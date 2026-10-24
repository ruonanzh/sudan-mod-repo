/**
 * form-bridge.js — the one script the form pages run, and only inside the app.
 *
 * A loot or fate-shop page is static HTML with a value block at the end. This wrapper reads the
 * page over `editor:readFile`, mounts it, writes the player's numbers back into the block over
 * `editor:save`, and sends the changed keys to the agent over `editor:sendPrompt`.
 *
 * The difference from a card page is what travels: a card page sends its path and the agent reads
 * the block itself. A form page sends the changed values in the message, because the page path is
 * all the app gives away and the agent should not have to parse the block to find three numbers.
 *
 * The app's editor protocol: `editor:init` and `editor:theme` come in; `editor:readFile`,
 * `editor:save`, `editor:sendPrompt` go out; `editor:fileContent`, `editor:saved`, `editor:sent`
 * and `editor:error` answer a request.
 */
(function () {
  "use strict";

  var BLOCK_ID = "form-values";
  var HOST_ID = "card-host";
  var isHost = Boolean(document.getElementById(HOST_ID));

  var state = {
    started: false,
    host: false,
    writable: false,
    revision: null,
    path: "",
    text: "",
    key: "",
    values: {},
    root: null,
    dirty: false,
    saved: "{}",
  };
  var waiting = new Map();
  var seq = 0;

  function byId(id) {
    return document.getElementById(id);
  }
  function post(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, "*");
  }
  function request(type, payload) {
    var requestId = "r" + ++seq;
    return new Promise(function (resolve) {
      waiting.set(requestId, resolve);
      post(Object.assign({ type: type, requestId: requestId }, payload || {}));
    });
  }
  function settle(requestId, value) {
    var resolve = waiting.get(requestId);
    if (!resolve) return false;
    waiting.delete(requestId);
    resolve(value);
    return true;
  }
  function setStatus(text, stateName) {
    var element = byId("card-status");
    if (!element) return;
    element.textContent = text;
    element.setAttribute("data-state", stateName || "clean");
  }
  function setText(id, text) {
    var element = byId(id);
    if (element) element.textContent = text;
  }

  /** Key order must not decide whether the page is dirty. */
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map(function (key) {
            return JSON.stringify(key) + ":" + canonical(value[key]);
          })
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function blockRegExp() {
    return new RegExp('<script[^>]*\\sid="' + BLOCK_ID + '"[^>]*>([\\s\\S]*?)<\\/script>', "i");
  }

  function parseBlock(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    return {
      key: String(parsed.key || ""),
      values: parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values) ? parsed.values : {},
    };
  }

  function readBlockFromHtml(html) {
    var match = blockRegExp().exec(html || "");
    return match ? parseBlock(match[1]) : null;
  }

  /** Replace the block, keeping every other byte of the page as it is on disk. */
  function withValues(html, key, values) {
    var payload = JSON.stringify({ version: 1, key: key, values: values }, null, 2).replace(/</g, "\\u003c");
    var block = '<script type="application/json" id="' + BLOCK_ID + '">\n' + payload + "\n</" + "script>";
    var pattern = blockRegExp();
    if (pattern.test(html)) return html.replace(pattern, block);
    var bodyEnd = html.toLowerCase().lastIndexOf("</body>");
    if (bodyEnd === -1) return html.replace(/\s*$/, "\n") + block + "\n";
    return html.slice(0, bodyEnd) + block + "\n" + html.slice(bodyEnd);
  }

  /* ---------- the controls ---------- */

  function readControl(element) {
    var kind = element.getAttribute("data-kind") || "text";
    if (kind === "number") return element.value === "" ? undefined : Number(element.value);
    if (kind === "json") {
      var text = String(element.value || "").trim();
      if (text === "") return undefined;
      return JSON.parse(text);
    }
    return String(element.value ?? "");
  }

  /**
   * What the page currently says. A blank number or text box means the key is absent, so the
   * saved record stays exactly as short as the player made it.
   */
  function collect(root) {
    var values = {};
    root.querySelectorAll("[data-form]").forEach(function (element) {
      var key = element.getAttribute("data-form");
      var value = readControl(element);
      if (value === undefined || value === "") return;
      values[key] = value;
    });
    var container = byId("item-rows");
    if (container) {
      var rows = container.querySelectorAll("[data-item-row]");
      var saved = Array.isArray((state.values || {}).item) ? state.values.item : [];
      var items = Array.prototype.map.call(rows, function (row) {
        var item = {};
        row.querySelectorAll("[data-item]").forEach(function (element) {
          var key = element.getAttribute("data-item");
          var value = readControl(element);
          if (value === undefined || value === "") return;
          item[key] = value;
        });
        return item;
      });
      // The condition is not a control any more: the player describes it in words. Keep the
      // stored one by identity, not by index — deleting a row shifts every index after it.
      values.item = window.FormValues ? window.FormValues.mergeConditions(items, saved) : items;
    }
    return values;
  }

  function paintStatus() {
    var blocked = !state.host || !state.writable;
    ["card-send", "card-reload"].forEach(function (id) {
      var element = byId(id);
      if (element) element.disabled = blocked;
    });
    if (!state.host) setStatus("只读：只能在 app 里编辑", "readonly");
    else if (!state.writable) setStatus("只读：这个文件不在 your_mods/ 里", "readonly");
    else setStatus(state.dirty ? "有改动还没发送" : "", state.dirty ? "dirty" : "clean");
  }

  function markDirty() {
    if (!state.root) return;
    state.dirty = canonical(collect(state.root)) !== state.saved;
    paintStatus();
  }

  /** The line under 抽取算法 says what this algorithm gives, from the table the page ships. */
  function wireTypeNote(root) {
    var pick = root.querySelector('[data-form="type"]');
    var line = root.querySelector("#type-note");
    if (!pick || !line) return;
    // The mounted page drops every script, so the table is read from the file text, not the DOM.
    var match = /<script[^>]*id="loot-type-notes"[^>]*>([\s\S]*?)<\/script>/i.exec(state.text || "");
    if (!match) return;
    var notes;
    try {
      notes = JSON.parse(match[1]);
    } catch (error) {
      return;
    }
    var paint = function () {
      var text = notes[String(pick.value)] || notes["2"] || "";
      if (text) line.textContent = text;
    };
    pick.addEventListener("change", paint);
    pick.addEventListener("input", paint);
    paint();
  }

  function wire(root) {
    if (!root || root.getAttribute("data-form-wired") === "1") return;
    root.setAttribute("data-form-wired", "1");
    root.addEventListener("input", markDirty);
    root.addEventListener("change", markDirty);
    wireTypeNote(root);
    var add = byId("item-add");
    if (add) {
      add.addEventListener("click", function () {
        var body = byId("item-rows");
        if (!body) return;
        var last = body.querySelector("[data-item-row]");
        var template = byId("item-template");
        // An empty table has no row to copy: the page ships a blank one for exactly this case.
        var next = last ? last.cloneNode(true) : template && template.content.firstElementChild.cloneNode(true);
        if (!next) return;
        next.removeAttribute("data-item-index");
        next.querySelectorAll("input").forEach(function (input) {
          input.value = input.getAttribute("data-item") === "num" || input.getAttribute("data-item") === "weight" ? "1" : "";
        });
        next.querySelectorAll("textarea").forEach(function (box) { box.value = ""; });
        var head = next.querySelector(".item-head span");
        if (head) head.textContent = "第 " + (body.querySelectorAll("[data-item-row]").length + 1) + " 件";
        body.appendChild(next);
        wireRemove(next);
        markDirty();
      });
    }
    Array.prototype.forEach.call(root.querySelectorAll("[data-item-row]"), wireRemove);
  }

  /** The visible "第 N 件" follows the rows that remain; the message does not rely on it. */
  function renumber(body) {
    if (!body) return;
    body.querySelectorAll("[data-item-row]").forEach(function (row, index) {
      var head = row.querySelector(".item-head span");
      if (head) head.textContent = "第 " + (index + 1) + " 件";
    });
  }

  function wireRemove(tr) {
    var button = tr.querySelector("[data-item-remove]");
    if (!button) return;
    button.onclick = function () {
      var body = tr.parentNode;
      body.removeChild(tr);
      renumber(body);
      markDirty();
    };
  }

  /* ---------- reading, saving, sending ---------- */

  /**
   * Only the keys whose value differs from the block, so the message stays short. Two kinds of key
   * never travel as a change: `id`, which the page shows read-only (a record that loses its id
   * cannot be found again), and every key the player describes in words instead of typing it — an
   * absent control there means "the player said nothing", not "remove this field".
   */
  function changedValues(values, described) {
    var saved = state.values || {};
    var changed = {};
    var skip = function (key) {
      return key === "id" || described.indexOf(key) !== -1;
    };
    Object.keys(values).forEach(function (key) {
      if (skip(key)) return;
      if (JSON.stringify(values[key]) !== JSON.stringify(saved[key])) changed[key] = values[key];
    });
    Object.keys(saved).forEach(function (key) {
      if (skip(key)) return;
      if (!(key in values)) changed[key] = null;
    });
    return changed;
  }

  function saveError(response) {
    var code = response && response.code;
    if (code === "READ_ONLY") return "这个文件不在 your_mods/ 里，不能写入。";
    if (code === "WRITE_DENIED") return "只能写 your_mods/ 里的文件。";
    if (code === "CONFLICT") return "页面在别处被改过。关掉再打开这一页，否则会盖掉别人的改动。";
    if (code === "TOO_LARGE") return "页面太大，写不下。";
    return "保存失败：" + ((response && (response.message || code)) || "未知错误");
  }

  function save() {
    if (!state.host || !state.writable || !state.root) return Promise.resolve(false);
    if (!state.text) {
      setStatus("读不到这一页的源文件，不能保存。", "error");
      return Promise.resolve(false);
    }
    var values = collect(state.root);
    var next = withValues(state.text, state.key, values);
    if (next === state.text) {
      state.dirty = false;
      paintStatus();
      return Promise.resolve(true);
    }
    setStatus("正在保存…", "clean");
    return request("editor:save", { data: next, baseRevision: state.revision || undefined }).then(function (response) {
      if (!response || response.code) {
        setStatus(saveError(response), "error");
        return false;
      }
      state.text = next;
      state.revision = response.revision || state.revision;
      state.values = values;
      state.saved = canonical(values);
      state.dirty = false;
      paintStatus();
      return true;
    });
  }

  /** Each kind has its own template: a loot table and a shop entry ask for different fields. */
  function command() {
    return String(state.key.split(":")[0]) === "upgrade" ? "/upgrade-edited" : "/loot-edited";
  }

  function sendErrorText(response) {
    var code = (response && response.code) || "NO_REPLY";
    if (code === "AGENT_BUSY") return "agent 正在运行，等它停下来再点一次。";
    if (code === "NO_SESSION") return "这一页没挂到会话上，到对话里发 " + command() + " " + state.key + "。";
    if (code === "NOT_ALLOWED") return "这个文件不在 your_mods/ 里，不能替你发消息。";
    if (code === "TOO_LONG") return "改动太多，分两次发。";
    return "没发出去（" + code + "）：到对话里发 " + command() + " " + state.key + "。";
  }

  /** What the player wrote about the fields the page does not let them type as JSON. */
  function proseOf(root) {
    var lines = [];
    root.querySelectorAll("[data-prose]").forEach(function (element) {
      var text = String(element.value || "").trim();
      if (text) lines.push(element.getAttribute("data-prose") + "：" + text);
    });
    // An item's condition is described one entry at a time; name the entry so the agent knows which.
    root.querySelectorAll("[data-item-row]").forEach(function (row, index) {
      var box = row.querySelector("[data-prose-item]");
      var text = box ? String(box.value || "").trim() : "";
      if (!text) return;
      // Name the entry by identity as well as by position: deleting a row changes the position,
      // and the agent writes into the file's array, not into what was on screen a minute ago.
      var type = row.querySelector('[data-item="type"]');
      var id = row.querySelector('[data-item="id"]');
      var key = (type && type.value ? type.value : "?") + " " + (id && id.value ? id.value : "?");
      lines.push("第 " + (index + 1) + " 件（" + key + "）的条件：" + text);
    });
    return lines;
  }

  function send() {
    if (!state.host || !state.writable || !state.root) return;
    var values;
    try {
      values = collect(state.root);
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), "error");
      return;
    }
    var described = Array.prototype.map.call(state.root.querySelectorAll("[data-prose]"), function (element) {
      return element.getAttribute("data-prose");
    });
    var changed = changedValues(values, described);
    var prose = proseOf(state.root);
    if (!Object.keys(changed).length && !prose.length) {
      setStatus("还没有改动。", "dirty");
      return;
    }
    save().then(function (ok) {
      if (!ok) return;
      setText("form-status", "正在通知 agent…");
      var lines = [command() + " " + state.key];
      if (prose.length) lines.push("说明：", prose.map(function (line) { return "- " + line; }).join("\n"));
      if (Object.keys(changed).length) lines.push("改动：" + JSON.stringify(changed));
      request("editor:sendPrompt", { text: lines.join("\n") }).then(function (response) {
        if (response && response.type === "editor:sent") {
          setText("form-status", "已通知 agent，它按这些值写回记录，再让这一页重新生成。");
        } else {
          setText("form-status", sendErrorText(response));
        }
      });
    });
  }

  function mountText() {
    var parsed = new DOMParser().parseFromString(state.text, "text/html");
    var style = parsed.querySelector("style");
    if (style) document.head.appendChild(style.cloneNode(true));
    var wrap = parsed.querySelector("[data-form-page]");
    var host = byId(HOST_ID);
    if (!wrap || !host) {
      setStatus("这一页里没有可编辑的内容。", "error");
      return;
    }
    host.replaceChildren(wrap.cloneNode(true));
    state.root = host.querySelector("[data-form-page]");
    state.root.querySelectorAll("script").forEach(function (element) {
      element.parentNode.removeChild(element);
    });
    var block = readBlockFromHtml(state.text);
    state.values = block ? block.values : {};
    state.key = (block && block.key) || state.root.getAttribute("data-form-page") || "";
    wire(state.root);
    var noHost = byId("card-no-host");
    if (noHost) noHost.hidden = true;
    state.saved = canonical(collect(state.root));
    state.dirty = false;
    paintStatus();
  }

  function load() {
    request("editor:readFile", {}).then(function (response) {
      if (!response || response.code) {
        setStatus("读不到这一页：" + ((response && (response.message || response.code)) || "未知错误"), "error");
        return;
      }
      state.text = typeof response.data === "string" ? response.data : "";
      state.revision = response.revision || null;
      mountText();
    });
  }

  function reloadFromDisk() {
    request("editor:readFile", {}).then(function (response) {
      if (!response || response.code) {
        var why = String((response && (response.message || response.code)) || "");
        setStatus(
          /ENOENT|not found/i.test(why)
            ? "这一页已经不在磁盘上了（可能被删除或换了名字）。关掉这个标签页即可。"
            : "读不到这一页：" + (why || "未知错误"),
          "error"
        );
        return;
      }
      state.text = typeof response.data === "string" ? response.data : "";
      state.revision = response.revision || null;
      mountText();
      setStatus("已按磁盘上的版本重新加载。", "clean");
    });
  }

  function applyTheme(data) {
    if (data && data.theme) document.documentElement.setAttribute("data-theme", data.theme === "light" ? "light" : "dark");
    if (data && typeof data.fontFamily === "string" && data.fontFamily) {
      document.documentElement.style.setProperty("--app-font", data.fontFamily);
    }
  }

  function renderHeader() {
    var bar = byId("bar");
    if (!bar) return;
    bar.innerHTML =
      '<strong>记录</strong>' +
      '<span id="card-file"></span>' +
      '<span id="card-status" data-state="clean">正在读取…</span>' +
      '<span class="grow"></span>' +
      '<button id="card-reload" type="button">重新加载</button>' +
      '<button id="card-send" type="button" disabled>发送给 Agent</button>';
  }

  function start(init) {
    if (state.started) return;
    state.started = true;
    state.host = true;
    state.writable = init.mode === "edit" && init.writable === true;
    applyTheme(init);
    renderHeader();
    state.path = (init.file && init.file.path) || "";
    var name = init.file && init.file.name;
    var file = byId("card-file");
    if (file && name) file.textContent = name;
    byId("card-send").addEventListener("click", send);
    byId("card-reload").addEventListener("click", reloadFromDisk);
    load();
    paintStatus();
  }

  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.requestId && settle(data.requestId, data)) return;
    if (data.type === "editor:init") start(data);
    else if (data.type === "editor:theme") applyTheme(data);
  });

  if (!isHost) {
    var note = byId("card-no-host");
    if (note) note.hidden = false;
  } else {
    post({ type: "editor:ready" });
  }
})();

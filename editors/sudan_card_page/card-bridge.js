/**
 * card-bridge.js — the one script a card page runs.
 *
 * Two homes, one file:
 *
 * - `tools/cardpage.mjs` inlines this source into every generated `*.card.html`, so a page
 *   opened from disk renders, filters tag names and says values can only be saved in the app.
 * - `editors/sudan_card_page/index.html` loads it as the tool's only script. The app opens the
 *   wrapper, the wrapper reads the matched card page over `editor:readFile`, mounts the page and
 *   saves the edited values back into the page's JSON block over `editor:save`.
 *
 * The protocol is the app's editor contract: `editor:init` and `editor:theme` come in;
 * `editor:readFile` and `editor:save` go out; `editor:fileContent`, `editor:saved` and
 * `editor:error` answer a request. Nothing here reaches the network.
 *
 * A save writes only the page's own value block. Writing the values into `config/cards.json` is
 * a separate, reviewed step: `node tools/preview.mjs --apply --mod your_mods/<Name>`.
 */
(function () {
  "use strict";

  var BLOCK_ID = "card-values";
  var HOST_ID = "card-host";
  var isHost = Boolean(document.getElementById(HOST_ID));

  var state = {
    started: false,
    host: false,
    writable: false,
    revision: null,
    text: "",
    values: {},
    root: null,
    id: "",
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
      id: String(parsed.id || ""),
      values: parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values) ? parsed.values : {},
    };
  }

  /** The same block replacement `tools/cardpage.mjs` performs, so both writers agree. */
  function withValues(html, id, values) {
    var payload = JSON.stringify({ version: 1, id: String(id), values: values }, null, 2).replace(/</g, "\\u003c");
    var block = '<script type="application/json" id="' + BLOCK_ID + '">\n' + payload + "\n</" + "script>";
    var pattern = blockRegExp();
    if (pattern.test(html)) return html.replace(pattern, block);
    var bodyEnd = html.toLowerCase().lastIndexOf("</body>");
    if (bodyEnd === -1) return html.replace(/\s*$/, "\n") + block + "\n";
    return html.slice(0, bodyEnd) + block + "\n" + html.slice(bodyEnd);
  }

  function readBlockFromHtml(html) {
    var match = blockRegExp().exec(html || "");
    return match ? parseBlock(match[1]) : null;
  }

  /* ---------- the controls ---------- */

  /** What the page currently says: the values a save would write into the block. */
  function collect(root) {
    var values = {};
    root.querySelectorAll("[data-field]").forEach(function (element) {
      var key = element.getAttribute("data-field");
      if (element.multiple) {
        values[key] = Array.prototype.map.call(element.selectedOptions, function (option) {
          return option.value;
        });
        return;
      }
      if (element.getAttribute("data-array") === "1") {
        values[key] = element.value
          .split(",")
          .map(function (part) {
            return part.trim();
          })
          .filter(Boolean);
        return;
      }
      if (element.getAttribute("data-number") === "1") {
        values[key] = element.value === "" ? 0 : Number(element.value);
        return;
      }
      values[key] = element.value;
    });

    var tag = {};
    root.querySelectorAll("[data-tag-level]").forEach(function (element) {
      var name = element.getAttribute("data-tag-level");
      var kind = element.getAttribute("data-tag-kind");
      // A marker is present or absent: an unchecked box drops the key, and a checked one carries
      // the level the page found (1, unless the record wrote something else). A page generated
      // before the checkbox still has the select, where "0 · 没有" means the same removal.
      if (kind === "marker") {
        if (element.type === "checkbox") {
          if (!element.checked) return;
        } else if (element.value === "0") return;
      }
      var level = Number(element.value);
      tag[name] = Number.isFinite(level) ? level : 0;
    });
    values.tag = tag;
    return values;
  }

  /** The names a tag can be picked from: every name in tag.json, then the stat-only list. */
  function tagOption(name) {
    var lists = [byId("tag-name-options"), byId("tag-stat-options")];
    for (var i = 0; i < lists.length; i += 1) {
      var list = lists[i];
      if (!list) continue;
      for (var j = 0; j < list.options.length; j += 1) {
        if (list.options[j].value === name) return list.options[j];
      }
    }
    return null;
  }

  /** `marker` or `stat`, from the kind the datalist marks a name with. */
  function kindOf(option) {
    return option.getAttribute("data-kind") === "marker" ? "marker" : "stat";
  }

  function tagControl(name) {
    var controls = state.root.querySelectorAll("[data-tag-level]");
    for (var i = 0; i < controls.length; i += 1) {
      if (controls[i].getAttribute("data-tag-level") === name) return controls[i];
    }
    return null;
  }

  /** What the page says about a name `tag.json` does not carry yet: the row appears anyway. */
  var UNKNOWN_TAG_NOTE = "这个标签还没有。agent 会为你在 `tag.json` 里新建一条。";
  /** Its range cell: `tag.json` carries the range, so the cell waits for the tag to exist. */
  var UNKNOWN_TAG_RANGE = "待建标签后确定";

  /**
   * Build the row a newly named tag needs. A name `tag.json` does not carry has no kind and no
   * range to bound, so it becomes a marker row — the shape whose only state is the checkbox —
   * and the row itself says the name is the thing to build.
   */
  function buildTagRow(name, kind, option) {
    var row = document.createElement("tr");
    row.setAttribute("data-tag-row", name);

    var nameCell = document.createElement("td");
    var code = document.createElement("code");
    code.textContent = name;
    nameCell.appendChild(code);
    if (!option) {
      var warning = document.createElement("div");
      warning.className = "note bad";
      warning.setAttribute("data-tag-warning", name);
      warning.textContent = UNKNOWN_TAG_NOTE;
      nameCell.appendChild(warning);
    }
    row.appendChild(nameCell);

    var valueCell = document.createElement("td");
    valueCell.className = "num";
    var control;
    var range;
    if (kind === "marker") {
      // A marker is present or absent, the same box a regenerated page carries.
      control = document.createElement("input");
      control.type = "checkbox";
      control.value = "1";
      control.checked = true;
      range = option ? "1 或不存在" : UNKNOWN_TAG_RANGE;
    } else {
      control = document.createElement("input");
      control.type = "number";
      control.value = "1";
      var min = option.getAttribute("data-min");
      var max = option.getAttribute("data-max");
      if (min !== null) control.min = min;
      if (max !== null) control.max = max;
      range = min !== null ? min + " … " + max : "不在原版 tag 表";
    }
    control.setAttribute("data-tag-kind", kind);
    control.setAttribute("data-tag-level", name);
    valueCell.appendChild(control);
    row.appendChild(valueCell);

    var rangeCell = document.createElement("td");
    rangeCell.textContent = range;
    row.appendChild(rangeCell);
    return row;
  }

  function addTag(input) {
    var name = (input.value || "").trim();
    if (!name) return;
    input.value = "";
    var wanted = input.getAttribute("data-tag-add") === "marker" ? "marker" : "stat";
    var option = tagOption(name);
    // A name `tag.json` does not carry has no kind to check: it goes to 标记, the table a
    // regenerated page would put it in, and its own row says the name has to be built.
    var kind = option ? kindOf(option) : "marker";
    // 加标记 lists every name in tag.json, so a stat typed there points at the other table.
    if (option && kind !== wanted) {
      setStatus("「" + name + "」是" + (kind === "marker" ? "标记，用「加标记」" : "数值属性，用「加属性」"), "error");
      return;
    }
    if (tagControl(name)) {
      setStatus("这张卡已经有这个标签了。", "dirty");
      return;
    }
    var table = state.root.querySelector(kind === "marker" ? "#tag-markers" : "#tag-stats");
    if (!table) return;
    var body = table.tBodies[0] || table;
    var empty = body.querySelector(".empty");
    if (empty) body.removeChild(empty.parentNode);
    body.appendChild(buildTagRow(name, kind, option));
    markDirty();
  }

  function wire(root) {
    if (!root || root.getAttribute("data-card-wired") === "1") return;
    root.setAttribute("data-card-wired", "1");
    root.addEventListener("input", markDirty);
    root.addEventListener("change", function (event) {
      var target = event.target;
      if (target && target.getAttribute && target.getAttribute("data-tag-add") !== null) return;
      markDirty();
    });
    root.querySelectorAll("[data-tag-add]").forEach(function (input) {
      input.addEventListener("change", function () {
        addTag(input);
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          addTag(input);
        }
      });
    });
  }

  function markDirty() {
    if (!state.root) return;
    state.dirty = canonical(collect(state.root)) !== state.saved;
    paintStatus();
  }

  function paintStatus() {
    var button = byId("card-save");
    if (!state.host) {
      setStatus("只读：只能在 app 里保存", "readonly");
      if (button) button.disabled = true;
      return;
    }
    if (!state.writable) {
      setStatus("只读：这个文件不在 your_mods/ 里", "readonly");
      if (button) button.disabled = true;
      return;
    }
    if (button) button.disabled = !state.dirty;
    setStatus(state.dirty ? "未保存（Ctrl+S）" : "已保存", state.dirty ? "dirty" : "clean");
  }

  /* ---------- reading and saving ---------- */

  /** The page's own DOM is already there; wire it even when no host ever says hello. */
  function preparePage() {
    state.root = document.querySelector("[data-card-page]");
    if (!state.root) return false;
    var element = byId(BLOCK_ID);
    var block = element ? parseBlock(element.textContent) : null;
    state.values = block ? block.values : {};
    state.id = (block && block.id) || state.root.getAttribute("data-card-page") || "";
    state.saved = canonical(state.values);
    wire(state.root);
    return true;
  }

  function loadPage() {
    if (!preparePage()) {
      setStatus("这一页里没有卡页内容。", "error");
      return;
    }
    request("editor:readFile", {}).then(function (response) {
      if (response && !response.code) {
        state.text = typeof response.data === "string" ? response.data : "";
        state.revision = response.revision || null;
      } else {
        setStatus("读不到这一页的源文件，保存会失败。", "error");
      }
    });
  }

  function loadHost() {
    request("editor:readFile", {}).then(function (response) {
      if (!response || response.code) {
        setStatus("读不到这一页：" + ((response && (response.message || response.code)) || "未知错误"), "error");
        return;
      }
      state.text = typeof response.data === "string" ? response.data : "";
      state.revision = response.revision || null;

      var parsed = new DOMParser().parseFromString(state.text, "text/html");
      var style = parsed.querySelector("style");
      if (style) document.head.appendChild(style.cloneNode(true));
      var wrap = parsed.querySelector("[data-card-page]");
      var host = byId(HOST_ID);
      if (!wrap || !host) {
        setStatus("这一页里没有卡页内容。", "error");
        return;
      }
      host.replaceChildren(wrap.cloneNode(true));
      state.root = host.querySelector("[data-card-page]");
      // The page's own scripts are the bridge itself; the tool already runs that one.
      state.root.querySelectorAll("script").forEach(function (element) {
        element.parentNode.removeChild(element);
      });
      var bar = state.root.querySelector("#card-savebar");
      if (bar) bar.parentNode.removeChild(bar);
      var noHost = state.root.querySelector("#card-no-host");
      if (noHost) noHost.hidden = true;

      var block = readBlockFromHtml(state.text);
      state.values = block ? block.values : {};
      state.id = (block && block.id) || state.root.getAttribute("data-card-page") || "";
      state.saved = canonical(state.values);
      wire(state.root);
      markDirty();
    });
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
    if (!state.host || !state.writable || !state.root) return;
    if (!state.text) {
      setStatus("读不到这一页的源文件，不能保存。", "error");
      return;
    }
    var values = collect(state.root);
    var next = withValues(state.text, state.id, values);
    if (next === state.text) {
      state.dirty = false;
      paintStatus();
      return;
    }
    setStatus("正在保存…", "clean");
    request("editor:save", { data: next, baseRevision: state.revision || undefined }).then(function (response) {
      if (!response || response.code) {
        setStatus(saveError(response), "error");
        return;
      }
      state.text = next;
      state.revision = response.revision || state.revision;
      state.values = values;
      state.saved = canonical(values);
      state.dirty = false;
      paintStatus();
      setStatus("已保存这一页；写回 cards.json 要跑 preview --apply", "clean");
    });
  }

  /* ---------- the host ---------- */

  function applyTheme(data) {
    if (data && data.theme) document.documentElement.setAttribute("data-theme", data.theme === "light" ? "light" : "dark");
    if (data && typeof data.fontFamily === "string" && data.fontFamily) {
      document.documentElement.style.setProperty("--app-font", data.fontFamily);
    }
  }

  function start(init) {
    if (state.started) return;
    state.started = true;
    state.host = true;
    state.writable = init.mode === "edit" && init.writable === true;
    applyTheme(init);
    var name = init.file && init.file.name;
    var file = byId("card-file");
    if (file && name) file.textContent = name;
    var bar = byId("card-savebar");
    if (bar) bar.hidden = false;
    var noHost = byId("card-no-host");
    if (noHost) noHost.hidden = true;
    if (isHost) loadHost();
    else loadPage();
    paintStatus();
  }

  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type === "editor:init") {
      start(data);
    } else if (data.type === "editor:theme") {
      applyTheme(data);
    } else if (data.type === "editor:fileContent" || data.type === "editor:saved" || data.type === "editor:error") {
      if (!settle(data.requestId, data)) {
        setStatus(data.type === "editor:error" ? saveError(data) : "已保存", data.type === "editor:error" ? "error" : "clean");
      }
    }
  });

  window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });

  var saveButton = byId("card-save");
  if (saveButton) saveButton.addEventListener("click", save);

  if (isHost) {
    paintStatus();
    setTimeout(function () {
      if (!state.host) setStatus("只读：没有 app 宿主，打开不了卡页。", "readonly");
    }, 1200);
  } else {
    // The value block sits after this script, so read it once the document has finished parsing.
    var ready = function () {
      if (!preparePage()) setStatus("这一页里没有卡页内容。", "error");
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
    else ready();
  }

  window.cardPageBridge = { collect: collect, save: save, withValues: withValues, readBlock: readBlockFromHtml };
})();

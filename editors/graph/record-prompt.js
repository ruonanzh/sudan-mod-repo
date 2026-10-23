/**
 * The "要改什么" box on a record page. The page is a plain HTML preview, so the only way to
 * reach the app is a message to the parent frame; the app validates it and forwards it to the
 * session that owns this mod.
 */
(function () {
  var box = document.getElementById("record-prompt");
  var button = document.getElementById("record-notify");
  var status = document.getElementById("record-status");
  if (!box || !button) return;

  var inApp = window.parent && window.parent !== window;

  function say(text) {
    if (status) status.textContent = text;
  }

  function done(result) {
    if (!result || typeof result !== "object") return;
    if (result.ok) {
      say("已通知 agent，它按这句话改记录并重新生成这一页。");
      button.disabled = false;
      return;
    }
    var why = {
      NOT_ALLOWED: "这个文件不在 your_mods/ 里，不能替你发消息。",
      EMPTY_MESSAGE: "先写一句你想改什么。",
      TOO_LONG: "这句话太长，分两次发。",
      NO_SESSION: "这个 mod 还没有会话，先在应用里打开它。",
    }[result.code];
    say(why || "没发出去（" + (result.code || "?") + "）：到对话里说。");
    button.disabled = false;
  }

  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "pi:preview-prompt-result") done(event.data);
  });

  if (!inApp) {
    button.disabled = true;
    say("这一页只能看。要在应用里打开，才能把这句话发给 agent。");
    return;
  }

  button.addEventListener("click", function () {
    var text = String(box.value || "").trim();
    if (!text) {
      say("先写一句你想改什么。");
      return;
    }
    button.disabled = true;
    say("已发送，等 agent 回话…");
    window.parent.postMessage({ type: "pi:preview-prompt", text: text }, "*");
  });
})();

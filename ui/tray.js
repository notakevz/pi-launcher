// Tray popover behaviour. No Tauri IPC is used: actions are signalled through
// window.open, which the Rust side denies in `on_new_window` and handles there.
// State is pushed in by Rust via `WebviewWindow::eval` (see __setTrayState).
(function () {
  "use strict";

  var BASE = "https://pi-launcher.tray/";
  var startupLastClick = -Infinity;

  function send(action) {
    try {
      window.open(BASE + action, "_blank");
      return true; // null is normal: Rust denies the popup after handling it.
    } catch (error) {
      return false;
    }
  }

  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  window.__setTrayState = function (state) {
    if (!state) return;
    var ready = !!state.ready;
    var badge = document.getElementById("badge");
    if (badge) badge.dataset.ready = String(ready);
    setText("badge-text", ready ? "运行中" : "启动中");
    var subtitle = document.getElementById("subtitle");
    if (subtitle) {
      subtitle.textContent = ready ? "本地服务已就绪" : "正在启动本地服务…";
      subtitle.title = state.label || "";
    }
    setText("endpoint", state.endpoint || "等待连接");
    setText("version", state.version || "");
    var browser = document.getElementById("action-browser");
    var copy = document.getElementById("action-copy");
    if (browser) browser.disabled = !ready;
    if (copy) copy.disabled = !ready;

    // Never optimistically flip this checkbox: Rust re-reads the Run value
    // after every write and reports unknown/errors explicitly.
    var startup = state.autostart || {};
    var known = typeof startup.enabled === "boolean";
    var autostart = document.getElementById("action-autostart");
    if (autostart) {
      autostart.disabled = !known;
      autostart.setAttribute("aria-checked", known ? String(startup.enabled) : "mixed");
      autostart.title = startup.error || (known ? (startup.enabled ? "关闭开机自启" : "开启开机自启") : "无法确认开机自启状态，请重新打开菜单。");
    }
    // No visible footnote. Keep failures available in the tooltip/live region.
    setText("autostart-status", startup.error || (known ? "" : "无法确认开机自启状态，请重新打开菜单。"));
  };

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    if (target.dataset.action === "autostart-toggle") {
      // A fast native reply can arrive BETWEEN the two mouse clicks. Suppress
      // the second click even after the state round-trip has re-enabled us.
      var now = performance.now();
      if (event.detail > 1 || now - startupLastClick < 500) return;
      startupLastClick = now;
      target.disabled = true;
      if (!send(target.dataset.action)) {
        startupLastClick = -Infinity;
        target.disabled = false;
        target.title = "无法发送自启设置请求，请重新打开菜单。";
        setText("autostart-status", target.title);
      }
    } else {
      send(target.dataset.action);
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      send("dismiss");
    }
  });

  // Suppress the native WebView2 context menu; this window is a menu itself.
  document.addEventListener("contextmenu", function (event) {
    event.preventDefault();
  });
})();

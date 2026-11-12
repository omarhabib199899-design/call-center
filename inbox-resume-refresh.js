/**
 * [CUSTOM] Refresh the inbox when the panel comes back from the background.
 *
 * Phones suspend a background tab and drop its socket. While it is down the
 * server's "request_update_chat_list" pushes are lost, and the compiled inbox
 * does not ask for the list again when the tab wakes up, so agents keep
 * looking at an old list until they reload by hand.
 *
 * This script reloads the panel when it becomes visible again after being
 * hidden for a while, when the browser restores it from its page cache, and
 * when the network comes back. If the person has typed something that has
 * not been sent, it shows a small "Refresh" bar instead of reloading, so no
 * draft is ever lost.
 */
(function () {
  "use strict";

  var HIDDEN_MS = 20000; // hidden at least this long -> list may be stale
  var MIN_GAP_MS = 15000; // never reload more often than this
  var LAST_KEY = "custom_resume_refresh_at";
  var BAR_ID = "custom-resume-refresh-bar";

  var hiddenAt = document.hidden ? Date.now() : 0;
  var wentOffline = false;

  function inPanel() {
    var p = location.pathname.toLowerCase();
    if (p.indexOf("/login") !== -1) return false;
    try {
      if (p.indexOf("/agent") === 0) return !!localStorage.getItem("wacrm_agent");
      if (p.indexOf("/user") === 0) return !!localStorage.getItem("wacrm_user");
    } catch (e) {}
    return false;
  }

  function isArabic() {
    try {
      return (localStorage.getItem("language") || "").toLowerCase().indexOf("arab") !== -1;
    } catch (e) {
      return false;
    }
  }

  /** True when a message box has text that hasn't been sent yet. */
  function hasDraft() {
    var fields = document.querySelectorAll("textarea, [contenteditable='true'], input[type='text']");
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var ph = (f.getAttribute("placeholder") || "").toLowerCase();
      // The chat-list search box is not a draft.
      if (ph.indexOf("search") !== -1 || ph.indexOf("بحث") !== -1) continue;
      var text = f.isContentEditable ? f.textContent : f.value;
      if (text && text.trim().length > 0) return true;
    }
    return false;
  }

  function tooSoon() {
    try {
      var last = Number(sessionStorage.getItem(LAST_KEY) || 0);
      return Date.now() - last < MIN_GAP_MS;
    } catch (e) {
      return false;
    }
  }

  function reload() {
    try {
      sessionStorage.setItem(LAST_KEY, String(Date.now()));
    } catch (e) {}
    location.reload();
  }

  function showBar() {
    if (document.getElementById(BAR_ID)) return;
    var ar = isArabic();
    var bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.dir = ar ? "rtl" : "ltr";
    bar.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:calc(16px + env(safe-area-inset-bottom, 0px))",
      "transform:translateX(-50%)",
      "z-index:2147483001",
      "display:flex",
      "align-items:center",
      "gap:10px",
      "background:#16202a",
      "color:#fff",
      "border-radius:999px",
      "padding:8px 8px 8px 14px",
      "box-shadow:0 4px 14px rgba(0,0,0,.25)",
      "font:600 13px/1.2 'Segoe UI',Tahoma,system-ui,sans-serif",
      "max-width:calc(100vw - 32px)",
    ].join(";");

    var text = document.createElement("span");
    text.textContent = ar ? "ممكن يكون فيه رسائل جديدة" : "New messages may have arrived";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = ar ? "تحديث" : "Refresh";
    btn.style.cssText =
      "border:0;border-radius:999px;padding:6px 14px;background:#25d366;color:#0b1a12;font:inherit;cursor:pointer";
    btn.onclick = reload;

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", ar ? "إغلاق" : "Dismiss");
    close.textContent = "×";
    close.style.cssText =
      "border:0;background:transparent;color:#fff;font:600 18px/1 sans-serif;cursor:pointer;padding:0 6px";
    close.onclick = function () {
      bar.remove();
    };

    bar.appendChild(text);
    bar.appendChild(btn);
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  function refreshNow() {
    if (!inPanel() || tooSoon()) return;
    if (hasDraft()) return showBar();
    reload();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    var away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away >= HIDDEN_MS) refreshNow();
  });

  // Restored from the browser's back/forward cache: the socket is long gone.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) refreshNow();
  });

  window.addEventListener("offline", function () {
    wentOffline = true;
  });

  window.addEventListener("online", function () {
    if (!wentOffline) return;
    wentOffline = false;
    if (!document.hidden) refreshNow();
  });
})();

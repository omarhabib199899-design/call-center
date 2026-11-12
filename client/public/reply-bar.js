/**
 * [CUSTOM] "Reply" to a specific message (WhatsApp, Messenger, Instagram).
 *
 * Swipe a message to the right (finger or mouse drag), or right-click it ->
 * Reply. A bar shows above the message box with the
 * quoted message; the next message you send goes out as a reply to it (the
 * customer sees it quoted in WhatsApp). The bundle puts the choice in
 * window.__inboxReply and sends it with the message; this file only draws the
 * bar and clears it. Anything unexpected here just means no bar.
 */
(function () {
  "use strict";
  var BAR_ID = "custom-reply-bar";
  var timer = null;

  function parseCtx(m) {
    var c = m && m.msgContext;
    if (typeof c === "string") { try { c = JSON.parse(c); } catch (e) { c = null; } }
    return c || {};
  }
  function preview(m) {
    var c = parseCtx(m), t = c.type || m.type;
    var txt = (c.text && c.text.body) || (c[t] && c[t].caption) || "";
    if (!txt) {
      var labels = { image: "📷 Photo", video: "🎥 Video", audio: "🎤 Voice message",
        document: "📄 " + ((c.document && c.document.filename) || "Document"),
        location: "📍 Location", contacts: "👤 Contact", sticker: "Sticker" };
      txt = labels[t] || "Message";
    }
    return String(txt).replace(/\s+/g, " ").slice(0, 160);
  }
  function composer() {
    var list = document.querySelectorAll("textarea:not([aria-hidden='true'])");
    for (var i = list.length - 1; i >= 0; i--) {
      var r = list[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return list[i];
    }
    return null;
  }
  function clear() {
    window.__inboxReply = null;
    var el = document.getElementById(BAR_ID);
    if (el) el.parentNode.removeChild(el);
    if (timer) { clearInterval(timer); timer = null; }
  }
  window.__inboxReplyClear = clear;

  function place(el) {
    var ta = composer();
    if (!ta) { el.style.display = "none"; return; }
    var box = ta.closest(".MuiFormControl-root") || ta;
    var r = box.getBoundingClientRect();
    el.style.display = "flex";
    el.style.left = Math.max(8, r.left) + "px";
    el.style.width = Math.max(220, r.width) + "px";
    el.style.bottom = (window.innerHeight - r.top + 6) + "px";
  }

  function show(rep) {
    var el = document.getElementById(BAR_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BAR_ID;
      el.style.cssText =
        "position:fixed;z-index:1300;display:flex;align-items:center;gap:8px;box-sizing:border-box;" +
        "background:#fff;border:1px solid rgba(0,0,0,.12);border-left:4px solid #1976d2;border-radius:8px;" +
        "padding:6px 8px 6px 10px;box-shadow:0 4px 14px rgba(0,0,0,.12);font:13px/1.35 system-ui,'Segoe UI',Tahoma,sans-serif";
      document.body.appendChild(el);
    }
    el.innerHTML = "";
    var body = document.createElement("div");
    body.style.cssText = "flex:1;min-width:0";
    var who = document.createElement("div");
    who.style.cssText = "color:#1976d2;font-weight:600;font-size:12px";
    who.textContent = "Replying to " + (rep.outgoing ? "your message" : (rep.name || "customer"));
    var txt = document.createElement("div");
    txt.style.cssText = "color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    txt.textContent = rep.preview;
    body.appendChild(who); body.appendChild(txt);
    var x = document.createElement("button");
    x.type = "button"; x.title = "Cancel reply"; x.textContent = "×";
    x.style.cssText = "border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#777;padding:0 4px";
    x.onclick = clear;
    el.appendChild(body); el.appendChild(x);
    place(el);
    if (timer) clearInterval(timer);
    timer = setInterval(function () { place(el); }, 400);
    var ta = composer(); if (ta) ta.focus();
  }

  window.addEventListener("inbox_reply_to", function (e) {
    var d = e.detail || {}, m = d.msg;
    if (!m || !d.chatId || !m.metaChatId) return;
    var rep = {
      chatId: d.chatId, id: m.id, metaChatId: m.metaChatId,
      outgoing: m.route === "OUTGOING",
      name: m.senderName && m.senderName !== "NA" ? m.senderName : "",
      preview: preview(m),
    };
    window.__inboxReply = rep;
    show(rep);
  });
  // a different chat was opened: drop the reply
  window.addEventListener("inbox_active_chat", function () {
    if (window.__inboxReply && window.__inboxReply.chatId !== window.__inboxActiveChat) clear();
  });
  // ── swipe right on a message bubble = reply (like WhatsApp) ──────────
  var st = document.createElement("style");
  st.textContent = "[data-msg-bubble]{touch-action:pan-y}";
  (document.head || document.documentElement).appendChild(st);

  var TRIGGER = 60, MAX = 90;
  var sw = null; // { el, x, y, dx, active, icon, row }

  function resetBubble(s) {
    if (!s) return;
    s.el.style.transition = "transform .18s ease";
    s.el.style.transform = "";
    if (s.icon && s.icon.parentNode) s.icon.parentNode.removeChild(s.icon);
    setTimeout(function () { s.el.style.transition = ""; }, 200);
    document.body.style.userSelect = "";
  }

  document.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    var el = e.target && e.target.closest && e.target.closest("[data-msg-bubble]");
    if (!el) return;
    if (e.target.closest("a,button,input,textarea,audio,video")) return;
    sw = { el: el, x: e.clientX, y: e.clientY, dx: 0, active: false, icon: null, pid: e.pointerId };
  }, true);

  document.addEventListener("pointermove", function (e) {
    if (!sw || e.pointerId !== sw.pid) return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; } // scrolling
      if (dx < 12 || Math.abs(dy) > 10) return;
      sw.active = true;
      sw.el.style.transition = "";
      document.body.style.userSelect = "none";
      try { window.getSelection().removeAllRanges(); } catch (x) {}
      var ic = document.createElement("div");
      ic.textContent = "↩";
      var br = sw.el.getBoundingClientRect();
      ic.style.cssText = "position:fixed;z-index:1300;pointer-events:none;left:" + (br.left + 6) + "px;top:" +
        (br.top + br.height / 2 - 12) + "px;width:24px;height:24px;" +
        "border-radius:50%;background:rgba(0,0,0,.08);color:#1976d2;display:flex;align-items:center;" +
        "justify-content:center;font:bold 14px/1 system-ui;opacity:0;transition:opacity .1s";
      document.body.appendChild(ic);
      sw.icon = ic;
    }
    sw.dx = Math.max(0, Math.min(MAX, dx));
    sw.el.style.transform = "translateX(" + sw.dx + "px)";
    if (sw.icon) sw.icon.style.opacity = String(Math.min(1, sw.dx / TRIGGER));
  }, true);

  function endSwipe(e) {
    if (!sw || (e && e.pointerId !== sw.pid)) return;
    var s = sw; sw = null;
    if (!s.active) return;
    window.__swipeJustEnded = true;
    setTimeout(function () { window.__swipeJustEnded = false; }, 300);
    var fire = s.dx >= TRIGGER;
    resetBubble(s);
    if (fire) {
      // the bundle's message handler turns this into "reply to this message"
      window.__swipeReply = true;
      var r = s.el.getBoundingClientRect();
      s.el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10,
      }));
      setTimeout(function () { window.__swipeReply = false; }, 0);
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (x) {}
    }
  }
  document.addEventListener("pointerup", endSwipe, true);
  document.addEventListener("pointercancel", function (e) {
    if (sw && e.pointerId === sw.pid) { resetBubble(sw); sw = null; }
  }, true);
  // a swipe must not also count as a click on the bubble
  document.addEventListener("click", function (e) {
    if (window.__swipeJustEnded) { e.stopPropagation(); e.preventDefault(); window.__swipeJustEnded = false; }
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && window.__inboxReply) clear();
  });
})();

/**
 * [CUSTOM] Alert the owner when a WhatsApp number is disconnected.
 *
 * Polls /api/qr_pairing/alerts every 60 s in the owner panel. When a linked
 * number has been offline for 2+ minutes it shows a red bar at the top of the
 * page with a link to reconnect, and a desktop notification (if allowed) the
 * first time each number goes down. Anything unexpected simply means no bar,
 * never a broken panel.
 */
(function () {
  "use strict";

  var BAR_ID = "custom-number-alerts";
  var POLL_MS = 60000;
  var SNOOZE_KEY = "numberAlertsSnoozeUntil";
  var notified = {}; // uniqueId -> true, so each outage notifies once

  function token() {
    try { return localStorage.getItem("wacrm_user") || ""; } catch (e) { return ""; }
  }
  function inOwnerPanel() {
    var p = location.pathname.toLowerCase();
    return p.indexOf("/user") === 0 && !!token();
  }
  function snoozed() {
    try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch (e) { return false; }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function removeBar() {
    var el = document.getElementById(BAR_ID);
    if (el) el.parentNode.removeChild(el);
  }

  function showBar(list) {
    var el = document.getElementById(BAR_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BAR_ID;
      el.setAttribute("role", "alert");
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#c0392b;color:#fff;" +
        "font:14px/1.4 system-ui,'Segoe UI',Tahoma,sans-serif;padding:8px 44px 8px 14px;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.25);direction:ltr;text-align:left";
      document.body.appendChild(el);
    }
    var names = list.map(function (n) {
      return "<b>" + esc(n.title || n.number) + "</b> (+" + esc(n.number) + ")";
    }).join(", ");
    var canNotify = "Notification" in window && Notification.permission === "default";
    el.innerHTML =
      "⚠️ WhatsApp " + (list.length > 1 ? "numbers" : "number") + " disconnected: " + names +
      ' &nbsp;<a href="/whatsapp-pairing.html" target="_blank" style="color:#fff;font-weight:700;text-decoration:underline">Reconnect</a>' +
      (canNotify ? ' &nbsp;<a href="#" data-act="notify" style="color:#fff;text-decoration:underline">Enable desktop alerts</a>' : "") +
      ' <button data-act="snooze" title="Hide for 30 minutes" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);' +
      'background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1">×</button>';
    el.onclick = function (e) {
      var act = e.target && e.target.getAttribute("data-act");
      if (act === "snooze") {
        try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 30 * 60000)); } catch (x) {}
        removeBar();
      } else if (act === "notify") {
        e.preventDefault();
        try { Notification.requestPermission().then(function () { showBar(list); }); } catch (x) {}
      }
    };
  }

  function desktopNotify(list) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    list.forEach(function (n) {
      if (notified[n.uniqueId]) return;
      notified[n.uniqueId] = true;
      try {
        var note = new Notification("WhatsApp disconnected: " + (n.title || n.number), {
          body: "+" + n.number + (n.needsScan ? " needs to be linked again." : " is offline."),
          tag: "wa-down-" + n.uniqueId,
        });
        note.onclick = function () { window.open("/whatsapp-pairing.html", "_blank"); };
      } catch (e) {}
    });
  }

  function check() {
    if (!inOwnerPanel()) { removeBar(); return; }
    fetch("/api/qr_pairing/alerts", { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.success) return;
        var list = d.data || [];
        // forget numbers that came back, so a new outage notifies again
        var down = {};
        list.forEach(function (n) { down[n.uniqueId] = true; });
        Object.keys(notified).forEach(function (k) { if (!down[k]) delete notified[k]; });

        if (!list.length) { removeBar(); return; }
        desktopNotify(list);
        if (!snoozed()) showBar(list);
      })
      .catch(function () {});
  }

  function start() {
    check();
    setInterval(check, POLL_MS);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

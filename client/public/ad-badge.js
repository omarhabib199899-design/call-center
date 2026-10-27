/**
 * [CUSTOM] Shows which ad the open conversation came from, inside the panel.
 *
 * The inbox is a compiled bundle with no source available, so the badge can't
 * be rendered by the app itself. Instead this watches for an open
 * conversation, reads the customer's number out of the chat header, asks the
 * server which ad that number arrived from, and pins a small banner under the
 * header.
 *
 * Reading the DOM is the fragile part. It is kept deliberately conservative:
 *   - the number is matched by shape (a phone number, masked or not)
 *   - a masked number that could belong to more than one customer resolves to
 *     nothing server-side rather than showing the wrong campaign
 *   - anything unexpected simply means no badge, never a broken panel
 */
(function () {
  "use strict";

  var BADGE_ID = "custom-ad-source-badge";
  var POLL_MS = 1200;

  var lastNumber = null;
  var inFlight = false;
  var cache = {}; // number -> ad | null

  function panelToken() {
    try {
      return (
        localStorage.getItem("wacrm_agent") ||
        localStorage.getItem("wacrm_user") ||
        ""
      );
    } catch (e) {
      return "";
    }
  }

  function inPanel() {
    var p = location.pathname.toLowerCase();
    return p.indexOf("/agent") === 0 || p.indexOf("/user") === 0;
  }

  /**
   * The customer's number as shown in the conversation header.
   * Accepts both "+201094646331" and the masked "+974******13".
   */
  function readNumber() {
    var nodes = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,p,span,div,a,small",
    );
    var re = /\+?\d[\d\s*]{6,}\d/;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.children.length) continue; // leaf nodes only

      var r = el.getBoundingClientRect();
      // The header strip, where the open chat's identity sits.
      if (r.top < 20 || r.top > 200 || r.width <= 0) continue;

      var text = (el.textContent || "").trim();
      if (text.length > 30) continue;

      var m = text.match(re);
      if (m) return m[0].replace(/\s/g, "");
    }
    return null;
  }

  function removeBadge() {
    var el = document.getElementById(BADGE_ID);
    if (el) el.remove();
  }

  function showBadge(ad) {
    removeBadge();
    if (!ad) return;

    var arabic = document.documentElement.lang === "ar";
    var label = arabic ? "جاء من إعلان" : "Came from ad";
    var title = ad.ad_title || (arabic ? "إعلان" : "Ad");

    var bar = document.createElement("div");
    bar.id = BADGE_ID;
    bar.style.cssText = [
      "position:fixed",
      "top:0",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147482000",
      "max-width:92vw",
      "background:#128c4a",
      "color:#fff",
      "font:600 12px/1.4 'Segoe UI',Tahoma,system-ui,sans-serif",
      "padding:6px 14px",
      "border-radius:0 0 10px 10px",
      "box-shadow:0 2px 10px rgba(0,0,0,.25)",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "cursor:pointer",
      "direction:" + (arabic ? "rtl" : "ltr"),
    ].join(";");

    bar.textContent = "📢 " + label + ": " + title;
    bar.title = ad.source_id ? "Ad ID: " + ad.source_id : "";

    bar.onclick = function () {
      window.open("/ad-sources.html", "_blank");
    };

    document.body.appendChild(bar);
  }

  function lookup(number) {
    if (Object.prototype.hasOwnProperty.call(cache, number)) {
      showBadge(cache[number]);
      return;
    }

    if (inFlight) return;
    inFlight = true;

    fetch("/api/ad_sources/lookup?mobile=" + encodeURIComponent(number), {
      headers: { Authorization: "Bearer " + panelToken() },
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var ad = d && d.success ? d.data : null;
        cache[number] = ad;
        if (readNumber() === number) showBadge(ad);
      })
      .catch(function () {
        // Network trouble: no badge, panel unaffected.
      })
      .then(function () {
        inFlight = false;
      });
  }

  function tick() {
    if (!inPanel() || !panelToken()) {
      removeBadge();
      lastNumber = null;
      return;
    }

    var number = readNumber();

    if (!number) {
      removeBadge();
      lastNumber = null;
      return;
    }

    if (number === lastNumber) return; // same chat, nothing to redo
    lastNumber = number;
    removeBadge();
    lookup(number);
  }

  function start() {
    setInterval(tick, POLL_MS);
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

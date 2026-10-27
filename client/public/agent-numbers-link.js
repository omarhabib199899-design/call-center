/**
 * [CUSTOM] Floating shortcut to the "agent <-> WhatsApp number" admin page.
 *
 * Loaded from index.html with a single <script> tag. It only renders for a
 * signed-in owner on /user* routes, never for agents or the admin panel, and
 * touches nothing inside the React tree — it appends one button to <body>.
 */
(function () {
  "use strict";

  var BTN_ID = "custom-panel-links";

  var LINKS = [
    {
      href: "/agent-numbers.html",
      label: "🔗 Agent ↔ Accounts",
      title: "Assign WhatsApp numbers, Facebook Pages and Instagram accounts to agents",
    },
    {
      href: "/ad-sources.html",
      label: "📢 Ad Sources",
      title: "See which ad each customer came from",
    },
  ];

  function isOwnerPanel() {
    if (location.pathname.indexOf("/user") !== 0) return false;
    try {
      return !!localStorage.getItem("wacrm_user");
    } catch (e) {
      return false;
    }
  }

  function remove() {
    var el = document.getElementById(BTN_ID);
    if (el) el.remove();
  }

  function render() {
    if (!isOwnerPanel()) return remove();
    if (document.getElementById(BTN_ID)) return;
    if (!document.body) return;

    var box = document.createElement("div");
    box.id = BTN_ID;
    box.style.cssText = [
      "position:fixed",
      "bottom:70px",
      "left:auto",
      "right:18px",
      "z-index:2147483000",
      "display:flex",
      "flex-direction:column",
      "gap:8px",
      "align-items:flex-end",
    ].join(";");

    LINKS.forEach(function (link) {
      var a = document.createElement("a");
      a.href = link.href;
      a.title = link.title;

      // Collapsed to the icon so the buttons don't cover the sidebar menu;
      // the full label slides out on hover.
      var parts = link.label.split(" ");
      var icon = parts.shift();
      var text = document.createElement("span");
      text.textContent = " " + parts.join(" ");
      text.style.cssText = "display:none";
      a.appendChild(document.createTextNode(icon));
      a.appendChild(text);

      a.style.cssText = [
        "background:#128c4a",
        "color:#fff",
        "font:600 13px/1 'Segoe UI',Tahoma,system-ui,sans-serif",
        "padding:10px 12px",
        "border-radius:999px",
        "text-decoration:none",
        "box-shadow:0 4px 14px rgba(0,0,0,.25)",
        "white-space:nowrap",
      ].join(";");

      a.onmouseenter = function () {
        a.style.background = "#0f7540";
        text.style.display = "inline";
      };
      a.onmouseleave = function () {
        a.style.background = "#128c4a";
        text.style.display = "none";
      };

      box.appendChild(a);
    });

    document.body.appendChild(box);
  }

  function start() {
    render();

    // The panel is a single-page app, so re-check on client-side navigation.
    ["pushState", "replaceState"].forEach(function (fn) {
      var original = history[fn];
      history[fn] = function () {
        var result = original.apply(this, arguments);
        setTimeout(render, 0);
        return result;
      };
    });

    window.addEventListener("popstate", render);
    setInterval(render, 3000); // covers login/logout without a navigation
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

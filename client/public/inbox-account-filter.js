/**
 * [CUSTOM] "Show chats from: <account>" filter for the inbox.
 *
 * The inbox is a compiled bundle with no source available, so it can't get a
 * new filter control of its own. This script floats a small dropdown in the
 * owner and agent panels listing the connected accounts the signed-in person
 * may see (WhatsApp numbers, Facebook Pages, Instagram accounts…).
 *
 * The choice is saved server-side (/api/agent_accounts/filter) and applied
 * in get_chat_list, then the page reloads so the chat list is fetched again.
 * Anything unexpected simply means no dropdown, never a broken panel.
 */
(function () {
  "use strict";

  var BOX_ID = "custom-inbox-account-filter";
  var REFRESH_MS = 60000;

  var ICONS = { qr: "📱", meta: "📱", messenger: "💬", instagram: "📸", telegram: "✈️" };

  var state = { panel: null, options: null, current: "", loadedAt: 0, loading: false };

  function isArabic() {
    try {
      var sys = (localStorage.getItem("language") || "").toLowerCase();
      return sys.indexOf("arab") !== -1;
    } catch (e) {
      return false;
    }
  }

  /** "agent", "user" or null when this isn't a signed-in panel page. */
  function panel() {
    var p = location.pathname.toLowerCase();
    if (p.indexOf("/login") !== -1) return null;
    try {
      if (p.indexOf("/agent") === 0 && localStorage.getItem("wacrm_agent")) return "agent";
      if (p.indexOf("/user") === 0 && localStorage.getItem("wacrm_user")) return "user";
    } catch (e) {}
    return null;
  }

  function token(kind) {
    try {
      return localStorage.getItem(kind === "agent" ? "wacrm_agent" : "wacrm_user") || "";
    } catch (e) {
      return "";
    }
  }

  function api(kind, method, body) {
    return fetch("/api/agent_accounts/filter", {
      method: method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token(kind),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json();
    });
  }

  function remove() {
    var el = document.getElementById(BOX_ID);
    if (el) el.remove();
  }

  function load(kind) {
    if (state.loading) return;
    state.loading = true;

    api(kind, "GET")
      .then(function (d) {
        state.loading = false;
        state.loadedAt = Date.now();
        state.panel = kind;
        if (!d || !d.success) {
          state.options = [];
          return remove();
        }
        state.options = d.data.options || [];
        state.current = d.data.current || "";

        // Don't yank the dropdown out from under someone using it.
        var box = document.getElementById(BOX_ID);
        if (box && box.contains(document.activeElement)) return;
        draw(kind);
      })
      .catch(function () {
        state.loading = false;
      });
  }

  function draw(kind) {
    remove();

    var options = state.options || [];
    // Nothing to choose between, and no stale filter to clear.
    if (options.length < 2 && !state.current) return;

    var ar = isArabic();
    var filtered = !!state.current;

    var box = document.createElement("div");
    box.id = BOX_ID;
    box.dir = ar ? "rtl" : "ltr";
    box.style.cssText = [
      // Top centre: the panel's header strip is empty there, while the
      // bottom-left corner sits on top of the sidebar menu.
      "position:fixed",
      "top:10px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483000",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "background:" + (filtered ? "#128c4a" : "#ffffff"),
      "color:" + (filtered ? "#ffffff" : "#16202a"),
      "border:1px solid " + (filtered ? "#128c4a" : "#dde3e9"),
      "border-radius:999px",
      "padding:4px 6px 4px 12px",
      "box-shadow:0 2px 8px rgba(0,0,0,.15)",
      "font:600 13px/1.2 'Segoe UI',Tahoma,system-ui,sans-serif",
      "max-width:calc(100vw - 32px)",
    ].join(";");

    var label = document.createElement("span");
    label.textContent = "📥 " + (ar ? "الحساب:" : "Account:");
    label.style.whiteSpace = "nowrap";

    var select = document.createElement("select");
    select.style.cssText = [
      "border:0",
      "border-radius:999px",
      "padding:5px 10px",
      "font:inherit",
      "max-width:180px",
      "background:" + (filtered ? "#0f7540" : "#f4f6f8"),
      "color:inherit",
      "cursor:pointer",
    ].join(";");

    var all = document.createElement("option");
    all.value = "";
    all.textContent = ar ? "كل الحسابات" : "All accounts";
    select.appendChild(all);

    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.key;
      opt.textContent = (ICONS[o.channel] || "•") + " " + o.name;
      if (o.key === state.current) opt.selected = true;
      select.appendChild(opt);
    });

    select.onchange = function () {
      select.disabled = true;
      api(kind, "POST", { account: select.value })
        .then(function () {
          // The chat list is fetched by the compiled app; reload so it asks
          // again and the server applies the new filter.
          location.reload();
        })
        .catch(function () {
          select.disabled = false;
        });
    };

    box.appendChild(label);
    box.appendChild(select);
    document.body.appendChild(box);
  }

  function tick() {
    var kind = panel();
    if (!kind) {
      state.options = null;
      return remove();
    }

    var stale = Date.now() - state.loadedAt > REFRESH_MS;
    if (state.panel !== kind || state.options === null || stale) return load(kind);

    if (!document.getElementById(BOX_ID)) draw(kind);
  }

  function start() {
    tick();
    window.addEventListener("popstate", tick);
    setInterval(tick, 3000); // SPA navigation, login and logout
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

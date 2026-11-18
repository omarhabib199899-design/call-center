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
 *
 * Look matches the new Omni design (white, navy #0D2266, brand logos).
 */
(function () {
  "use strict";

  var BOX_ID = "custom-inbox-account-filter";
  var STYLE_ID = "custom-inbox-account-filter-css";
  var REFRESH_MS = 60000;

  // Official brand marks (simple-icons, CC0), 24x24 viewBox.
  var PATHS = {"whatsapp":"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z","telegram":"M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z","messenger":"M.001 11.639C.001 4.949 5.241 0 12.001 0S24 4.95 24 11.639c0 6.689-5.24 11.638-12 11.638-1.21 0-2.38-.16-3.47-.46a.96.96 0 00-.64.05l-2.39 1.05a.96.96 0 01-1.35-.85l-.07-2.14a.97.97 0 00-.32-.68A11.39 11.389 0 01.002 11.64zm8.32-2.19l-3.52 5.6c-.35.53.32 1.139.82.75l3.79-2.87c.26-.2.6-.2.87 0l2.8 2.1c.84.63 2.04.4 2.6-.48l3.52-5.6c.35-.53-.32-1.13-.82-.75l-3.79 2.87c-.25.2-.6.2-.86 0l-2.8-2.1a1.8 1.8 0 00-2.61.48z","instagram":"M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"};
  var LOGO = {
    qr: ["whatsapp", "#25D366"],
    meta: ["whatsapp", "#25D366"],
    telegram: ["telegram", "#26A5E4"],
    messenger: ["messenger", "#0866FF"],
    instagram: ["instagram", "#E4405F"],
  };

  var state = { panel: null, options: null, current: "", loadedAt: 0, loading: false, open: false, q: "" };

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
    state.open = false;
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
        if (state.open) return;
        draw(kind);
      })
      .catch(function () {
        state.loading = false;
      });
  }

  function css() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      "#" + BOX_ID + "{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483000;font:500 13px/18px 'IBM Plex Sans','Segoe UI',Tahoma,system-ui,sans-serif;color:#202020;max-width:calc(100vw - 32px)}",
      "#" + BOX_ID + " *{box-sizing:border-box;font-family:inherit}",
      "#" + BOX_ID + " .iaf-btn{display:flex;align-items:center;gap:8px;height:36px;padding:0 10px 0 12px;background:#fff;border:1px solid #dadada;border-radius:8px;box-shadow:0 1px 3px rgba(16,24,40,.08);cursor:pointer;color:inherit;font-size:13px;max-width:100%}",
      "#" + BOX_ID + " .iaf-btn:hover{border-color:#b8bdc9}",
      "#" + BOX_ID + " .iaf-btn:focus-visible{outline:2px solid #0d2266;outline-offset:2px}",
      "#" + BOX_ID + ".is-filtered .iaf-btn{background:#eff2fb;border:1.5px solid #0d2266}",
      "#" + BOX_ID + " .iaf-lbl{color:#707070;font-weight:500;white-space:nowrap}",
      "#" + BOX_ID + " .iaf-val{display:flex;align-items:center;gap:6px;font-weight:600;color:#202020;min-width:0}",
      "#" + BOX_ID + ".is-filtered .iaf-val{color:#0d2266}",
      "#" + BOX_ID + " .iaf-val span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}",
      "#" + BOX_ID + " .iaf-chev{color:#707070;flex:none;transition:transform .15s}",
      "#" + BOX_ID + ".is-open .iaf-chev{transform:rotate(180deg)}",
      "#" + BOX_ID + " .iaf-clear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;border:0;background:none;color:#0d2266;cursor:pointer;padding:0;margin-inline-start:2px}",
      "#" + BOX_ID + " .iaf-clear:hover{background:rgba(13,34,102,.1)}",
      "#" + BOX_ID + " .iaf-menu{position:absolute;top:42px;left:50%;transform:translateX(-50%);width:300px;max-width:calc(100vw - 32px);background:#fff;border:1px solid #e3e3e3;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:6px;display:flex;flex-direction:column;gap:2px}",
      "#" + BOX_ID + " .iaf-search{display:flex;align-items:center;gap:6px;height:34px;margin:0 0 4px;padding:0 10px;border:1px solid #dadada;border-radius:7px;color:#9aa0ae}",
      "#" + BOX_ID + " .iaf-search:focus-within{border-color:#0d2266}",
      "#" + BOX_ID + " .iaf-search input{flex:1;min-width:0;border:0;outline:0;background:none;font-size:13px;color:#202020}",
      "#" + BOX_ID + " .iaf-list{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:2px}",
      "#" + BOX_ID + " .iaf-item{display:flex;align-items:center;gap:10px;min-height:36px;padding:6px 10px;border:0;border-radius:7px;background:none;cursor:pointer;text-align:start;font-size:13px;color:#202020;width:100%}",
      "#" + BOX_ID + " .iaf-item:hover,#" + BOX_ID + " .iaf-item.is-kb{background:#f5f6fa}",
      "#" + BOX_ID + " .iaf-item.is-on{background:#eff2fb;color:#0d2266;font-weight:600}",
      "#" + BOX_ID + " .iaf-item .iaf-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "#" + BOX_ID + " .iaf-item .iaf-check{flex:none;color:#0d2266}",
      "#" + BOX_ID + " .iaf-all{width:20px;height:20px;border-radius:5px;background:#eff2fb;color:#0d2266;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      "#" + BOX_ID + " .iaf-sep{height:1px;background:#eee;margin:3px 4px}",
      "#" + BOX_ID + " .iaf-none{padding:12px;text-align:center;color:#8a91a1;font-size:12px}",
      "#" + BOX_ID + " .iaf-busy{opacity:.6;pointer-events:none}",
      "@media (max-width:600px){#" + BOX_ID + " .iaf-lbl{display:none}#" + BOX_ID + " .iaf-val span{max-width:150px}}",
    ].join("\n");
    document.head.appendChild(s);
  }

  var SVG = "http://www.w3.org/2000/svg";
  function svg(size, viewBox, html) {
    var el = document.createElementNS(SVG, "svg");
    el.setAttribute("width", size);
    el.setAttribute("height", size);
    el.setAttribute("viewBox", viewBox);
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = html;
    el.style.flex = "none";
    return el;
  }
  function logo(channel) {
    var l = LOGO[channel];
    if (!l) return svg(16, "0 0 24 24", '<circle cx="12" cy="12" r="5" fill="#a0a5b1"/>');
    return svg(16, "0 0 24 24", '<path fill="' + l[1] + '" d="' + PATHS[l[0]] + '"/>');
  }
  function lineIcon(d, size) {
    return svg(size || 16, "0 0 24 24", '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
  }
  var ICON = {
    chev: "m6 9 6 6 6-6",
    check: "M20 6 9 17l-5-5",
    x: "M18 6 6 18M6 6l12 12",
    search: "m21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  };

  function choose(kind, value) {
    var box = document.getElementById(BOX_ID);
    if (box) box.classList.add("iaf-busy");
    api(kind, "POST", { account: value })
      .then(function () {
        // The chat list is fetched by the compiled app; reload so it asks
        // again and the server applies the new filter.
        location.reload();
      })
      .catch(function () {
        if (box) box.classList.remove("iaf-busy");
      });
  }

  function draw(kind) {
    var old = document.getElementById(BOX_ID);
    if (old) old.remove();

    var options = state.options || [];
    // Nothing to choose between, and no stale filter to clear.
    if (options.length < 2 && !state.current) return;

    css();
    var ar = isArabic();
    var T = {
      label: ar ? "الحساب" : "Account",
      all: ar ? "كل الحسابات" : "All accounts",
      search: ar ? "ابحث في الحسابات" : "Search accounts",
      none: ar ? "مفيش نتايج" : "No accounts match",
      clear: ar ? "إلغاء الفلتر" : "Show all accounts",
    };
    var cur = null;
    options.forEach(function (o) {
      if (o.key === state.current) cur = o;
    });

    var box = document.createElement("div");
    box.id = BOX_ID;
    box.dir = ar ? "rtl" : "ltr";
    if (state.current) box.classList.add("is-filtered");
    if (state.open) box.classList.add("is-open");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "iaf-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", state.open ? "true" : "false");

    var lbl = document.createElement("span");
    lbl.className = "iaf-lbl";
    lbl.textContent = T.label;

    var val = document.createElement("span");
    val.className = "iaf-val";
    if (cur) val.appendChild(logo(cur.channel));
    else {
      var ic = lineIcon(ICON.inbox, 15);
      ic.style.color = "#0d2266";
      val.appendChild(ic);
    }
    var name = document.createElement("span");
    name.textContent = cur ? cur.name : state.current ? state.current : T.all;
    val.appendChild(name);

    btn.appendChild(lbl);
    btn.appendChild(val);
    var chev = lineIcon(ICON.chev, 15);
    chev.setAttribute("class", "iaf-chev");
    btn.appendChild(chev);
    btn.onclick = function () {
      state.open = !state.open;
      state.q = "";
      draw(kind);
    };
    box.appendChild(btn);

    if (state.current) {
      var clr = document.createElement("button");
      clr.type = "button";
      clr.className = "iaf-clear";
      clr.title = T.clear;
      clr.setAttribute("aria-label", T.clear);
      clr.appendChild(lineIcon(ICON.x, 14));
      clr.onclick = function (e) {
        e.stopPropagation();
        choose(kind, "");
      };
      btn.insertBefore(clr, chev);
    }

    if (state.open) {
      var menu = document.createElement("div");
      menu.className = "iaf-menu";
      menu.setAttribute("role", "listbox");

      var list = document.createElement("div");
      list.className = "iaf-list";

      var input = null;
      if (options.length > 6) {
        var sw = document.createElement("label");
        sw.className = "iaf-search";
        sw.appendChild(lineIcon(ICON.search, 14));
        input = document.createElement("input");
        input.placeholder = T.search;
        input.value = state.q;
        sw.appendChild(input);
        menu.appendChild(sw);
      }

      var items = [];
      function item(key, label, icon) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "iaf-item" + (key === state.current ? " is-on" : "");
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", key === state.current ? "true" : "false");
        b.appendChild(icon);
        var t = document.createElement("span");
        t.className = "iaf-txt";
        t.textContent = label;
        b.appendChild(t);
        if (key === state.current) {
          var c = lineIcon(ICON.check, 15);
          c.setAttribute("class", "iaf-check");
          b.appendChild(c);
        }
        b.onclick = function () {
          state.open = false;
          if (key === state.current) return draw(kind);
          choose(kind, key);
        };
        items.push(b);
        return b;
      }

      function fill() {
        list.innerHTML = "";
        items = [];
        var q = state.q.trim().toLowerCase();
        if (!q) {
          var allIco = document.createElement("span");
          allIco.className = "iaf-all";
          allIco.appendChild(lineIcon(ICON.inbox, 13));
          list.appendChild(item("", T.all, allIco));
          var sep = document.createElement("div");
          sep.className = "iaf-sep";
          list.appendChild(sep);
        }
        var shown = options.filter(function (o) {
          return !q || String(o.name || "").toLowerCase().indexOf(q) !== -1;
        });
        shown.forEach(function (o) {
          list.appendChild(item(o.key, o.name, logo(o.channel)));
        });
        if (!shown.length) {
          var n = document.createElement("div");
          n.className = "iaf-none";
          n.textContent = T.none;
          list.appendChild(n);
        }
      }
      fill();
      menu.appendChild(list);
      box.appendChild(menu);

      if (input) {
        input.oninput = function () {
          state.q = input.value;
          fill();
        };
        setTimeout(function () {
          input.focus();
        }, 0);
      }

      // Keyboard: arrows move, Enter picks, Esc closes.
      var kb = -1;
      menu.onkeydown = function (e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!items.length) return;
          kb = (kb + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items.forEach(function (x, i) {
            x.classList.toggle("is-kb", i === kb);
          });
          items[kb].scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && kb >= 0 && items[kb]) {
          e.preventDefault();
          items[kb].click();
        }
      };
    }

    document.body.appendChild(box);
  }

  // Close on outside click / Esc.
  document.addEventListener(
    "mousedown",
    function (e) {
      var box = document.getElementById(BOX_ID);
      if (state.open && box && !box.contains(e.target)) {
        state.open = false;
        if (state.panel) draw(state.panel);
      }
    },
    true,
  );
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) {
      state.open = false;
      if (state.panel) draw(state.panel);
      var b = document.querySelector("#" + BOX_ID + " .iaf-btn");
      if (b) b.focus();
    }
  });

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

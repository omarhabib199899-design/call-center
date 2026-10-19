/**
 * [CUSTOM] Keeps a signed-in panel user off the login screen.
 *
 * The compiled panel's login routes don't check for an existing session, so
 * pressing Back from the inbox lands on /agent/login and shows the sign-in
 * form even though the token in localStorage is still valid. Agents read that
 * as being logged out and sign in again, mid-conversation.
 *
 * This guard runs on the login routes only. If a token is present it verifies
 * it against the API first, then sends the person back to their panel. An
 * invalid token is cleared so the login form behaves normally — that check is
 * what stops a redirect loop.
 */
(function () {
  "use strict";

  var PANELS = [
    { path: "/agent/login", key: "wacrm_agent", verify: "/api/agent/get_me", home: "/agent" },
    { path: "/user/login", key: "wacrm_user", verify: "/api/user/get_me", home: "/user" },
    { path: "/admin/login", key: "wacrm_admin", verify: "/api/admin/get_admin", home: "/admin" },
  ];

  var AGENT = PANELS[0];
  var INSIDE = "custom_was_in_agent_panel";

  var checking = false;

  function path() {
    return location.pathname.replace(/\/+$/, "").toLowerCase();
  }

  /** Remember that this tab is working inside the agent panel. */
  function markInsidePanel() {
    try {
      if (path().indexOf("/agent") === 0 && path() !== AGENT.path) {
        sessionStorage.setItem(INSIDE, "1");
      }
    } catch (e) {}
  }

  function wasInsidePanel() {
    try {
      return sessionStorage.getItem(INSIDE) === "1";
    } catch (e) {
      return false;
    }
  }

  function currentPanel() {
    var p = path();

    for (var i = 0; i < PANELS.length; i++) {
      if (p !== PANELS[i].path) continue;

      // This login page's own session wins.
      if (read(PANELS[i].key)) return PANELS[i];

      // Otherwise: Back can throw an agent onto whichever login page happens
      // to be earlier in this tab's history — /admin/login, say, left over
      // from setting the system up. Without a session of its own that page
      // just shows a sign-in form, so send the agent back to their inbox.
      if (wasInsidePanel() && read(AGENT.key)) return AGENT;

      return PANELS[i];
    }

    // Back can equally land on the public home page ("/"), which also reads
    // as being signed out. Only rescue tabs that were working inside the
    // panel, so the owner can still open the marketing site normally.
    if ((p === "" || p === "/index.html") && wasInsidePanel()) {
      return AGENT;
    }

    return null;
  }

  function read(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  }

  function clear(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  function guard() {
    if (checking) return;

    markInsidePanel();

    var panel = currentPanel();
    if (!panel) return;

    var token = read(panel.key);
    if (!token) return; // no session — leave the login form alone

    checking = true;

    fetch(panel.verify, {
      headers: { Authorization: "Bearer " + token },
    })
      .then(function (r) {
        return r.json().catch(function () {
          return null;
        });
      })
      .then(function (d) {
        if (d && d.success) {
          // Replace, not push, so Back doesn't bounce between the two.
          location.replace(panel.home);
          return;
        }
        // Token is dead — drop it and let the person sign in normally.
        // Clearing the flag too stops "/" from bouncing on every visit.
        clear(panel.key);
        try {
          sessionStorage.removeItem(INSIDE);
        } catch (e) {}
        checking = false;
      })
      .catch(function () {
        // Network trouble: do nothing rather than trap someone on a blank page.
        checking = false;
      });
  }

  /**
   * Keeps Back inside the agent panel.
   *
   * Opening a conversation doesn't add a history entry — the panel stays on
   * /agent — so Back pops straight past it and leaves the site entirely.
   * Once the page is gone no script can bring it back, so a sentinel entry is
   * seeded while the agent is in the panel and re-seeded whenever it is
   * consumed. Leaving is still possible through Logout or closing the tab.
   */
  function inAgentPanel() {
    return path().indexOf("/agent") === 0 && path() !== AGENT.path;
  }

  // Captured before the history methods are wrapped below, so seeding never
  // re-enters our own hook.
  var rawPushState = history.pushState;

  function seedSentinel() {
    if (!inAgentPanel()) return;
    try {
      rawPushState.call(history, { customPanelGuard: true }, "", location.href);
    } catch (e) {}
  }

  /** Is a conversation open? On narrow screens it replaces the chat list. */
  function chatIsOpen() {
    var composers = document.querySelectorAll(
      'textarea, [contenteditable="true"]',
    );
    for (var i = 0; i < composers.length; i++) {
      var r = composers[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  /**
   * Clicks the panel's own back arrow, so the hardware Back button closes the
   * conversation instead of leaving the site.
   *
   * The panel is a compiled bundle with generated class names, so the arrow is
   * found by position rather than by selector: the left-most interactive
   * element in the conversation header. If nothing convincing is there we
   * return false and the caller falls back to asking before leaving.
   */
  function closeOpenChat() {
    // Wide screens show the chat list and the conversation side by side, so
    // there is no back arrow and nothing to close — pressing Back there must
    // not go poking at whatever button sits in the top-left.
    if ((window.innerWidth || 0) >= 900) return false;

    if (!chatIsOpen()) return false;

    var nodes = document.querySelectorAll('button, [role="button"], svg');
    var best = null;
    var bestLeft = Infinity;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();

      // Header strip only, and skip anything full-width or invisible.
      if (r.top < 8 || r.top > 140) continue;
      if (r.width <= 0 || r.height <= 0 || r.width > 90) continue;
      if (r.left > 140) continue;

      if (r.left < bestLeft) {
        bestLeft = r.left;
        best = el;
      }
    }

    if (!best) return false;

    var clickable = best.closest
      ? best.closest('button, [role="button"], a') || best
      : best;

    try {
      clickable.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Second Back press: confirm before actually leaving the panel. */
  function confirmLeave() {
    var msg =
      document.documentElement.lang === "ar"
        ? "هل تريد الخروج من لوحة التحكم؟"
        : "Leave the panel?";

    if (!window.confirm(msg)) return;

    try {
      sessionStorage.removeItem(INSIDE); // stop the guard bouncing us back
    } catch (e) {}
    location.href = "/";
  }

  function start() {
    guard();
    seedSentinel();

    ["pushState", "replaceState"].forEach(function (fn) {
      var original = history[fn];
      history[fn] = function () {
        var result = original.apply(this, arguments);
        setTimeout(guard, 0);
        return result;
      };
    });

    window.addEventListener("popstate", function () {
      if (inAgentPanel()) {
        // Re-seed first: the sentinel has just been consumed, and without a
        // new one the next Back press leaves the site for good.
        seedSentinel();

        // First press inside a conversation closes it; otherwise ask.
        if (closeOpenChat()) return;
        confirmLeave();
        return;
      }

      setTimeout(guard, 0);
    });

    window.addEventListener("pageshow", function (e) {
      if (e.persisted) guard(); // back/forward cache
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

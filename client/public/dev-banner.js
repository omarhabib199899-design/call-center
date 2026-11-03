/* [CUSTOM] Orange "DEV COPY" ribbon on the dev site so nobody mistakes it for
 * the real system. Does nothing on the production domain. */
(function () {
  if (!/^dev\./i.test(location.hostname)) return;
  function add() {
    var el = document.createElement("div");
    el.textContent = "DEV COPY — not the real system. Nothing here reaches customers.";
    el.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:2147483000;" +
      "background:#e67e22;color:#fff;font:600 12px/1.4 system-ui,sans-serif;" +
      "text-align:center;padding:3px 8px;pointer-events:none;opacity:.92";
    document.body.appendChild(el);
    document.title = "[DEV] " + document.title;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})();

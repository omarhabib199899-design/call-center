import { useEffect, useRef, useState } from "react";
import { RotateCw, ExternalLink } from "lucide-react";
import "./ClassicFrame.css";

// Shows a page of the classic panel inside the new layout until that page is rebuilt
const EMBED_CSS = `
  nav:has(> .MuiDrawer-root), nav:has(.MuiDrawer-docked) { display: none !important; }
  nav:has(.MuiDrawer-root) ~ * { width: 100% !important; max-width: 100% !important; margin-left: 0 !important; margin-right: 0 !important; }
  .MuiAppBar-root { width: 100% !important; margin-left: 0 !important; margin-right: 0 !important; left: 0 !important; right: 0 !important; }
`;

// Undo the space the classic layout leaves for its own sidebar
const OFFSET_MIN = 120;
function fixOffsets(doc) {
  const win = doc.defaultView;
  if (!win || !doc.body) return;
  const vw = win.innerWidth;
  const walk = (el, depth) => {
    if (!el || depth > 8) return;
    for (const child of el.children) {
      const tag = child.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NAV") continue;
      const cs = win.getComputedStyle(child);
      if (cs.display === "none") continue;
      const rect = child.getBoundingClientRect();
      if (rect.width >= vw * 0.4 && rect.height > 0) {
        const p = child.parentElement.getBoundingClientRect();
        const gapL = rect.left - p.left;
        const gapR = p.right - rect.right;
        const centered = Math.abs(gapL - gapR) < 8;
        const fix = (prop, value) => child.style.setProperty(prop, value, "important");
        const positioned = cs.position === "fixed" || cs.position === "absolute";
        // padding used to make room for the old sidebar
        if (parseFloat(cs.paddingLeft) >= OFFSET_MIN && parseFloat(cs.paddingRight) < OFFSET_MIN)
          fix("padding-left", "0");
        if (parseFloat(cs.paddingRight) >= OFFSET_MIN && parseFloat(cs.paddingLeft) < OFFSET_MIN)
          fix("padding-right", "0");
        if (!centered && gapL >= OFFSET_MIN) {
          fix("margin-left", "0");
          if (parseFloat(cs.paddingLeft) >= OFFSET_MIN) fix("padding-left", "0");
          if (positioned) fix("left", "0");
          if (gapR < 4) fix("width", positioned ? "100%" : "auto");
          if (cs.flexGrow === "0" && !positioned) fix("flex-grow", "1");
        } else if (!centered && gapR >= OFFSET_MIN) {
          // right-to-left layout: the old sidebar sat on the right
          fix("margin-right", "0");
          if (parseFloat(cs.paddingRight) >= OFFSET_MIN) fix("padding-right", "0");
          if (positioned) fix("right", "0");
          if (gapL < 4) fix("width", positioned ? "100%" : "auto");
          if (cs.flexGrow === "0" && !positioned) fix("flex-grow", "1");
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(doc.body, 0);
}

export default function ClassicFrame({ src, hidden, onUrlChange, onSignedOut }) {
  const ref = useRef(null);
  const [frameSrc, setFrameSrc] = useState(src);
  const [loading, setLoading] = useState(true);
  const lastUrl = useRef("");
  const ready = useRef(false);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  // Switch pages inside the running classic app when we can (it listens to popstate),
  // instead of reloading the whole thing
  useEffect(() => {
    let target;
    try {
      target = new URL(src, location.origin);
    } catch {
      return;
    }
    try {
      const win = ref.current?.contentWindow;
      const cur = win?.location;
      if (ready.current && cur && cur.origin === target.origin) {
        if (cur.pathname === target.pathname) {
          if (cur.search !== target.search) {
            win.history.pushState(null, "", target.pathname + target.search);
            win.dispatchEvent(new win.PopStateEvent("popstate", { state: null }));
          }
          lastUrl.current = win.location.href;
          return;
        }
      }
    } catch {}
    ready.current = false;
    setLoading(true);
    setFrameSrc(src);
  }, [src]);

  // Follow navigation inside the frame (the classic panel uses pushState)
  useEffect(() => {
    const t = setInterval(() => {
      if (hiddenRef.current) return;
      try {
        const href = ref.current?.contentWindow?.location?.href;
        if (!href || href === "about:blank" || href === lastUrl.current) return;
        lastUrl.current = href;
        const path = new URL(href).pathname;
        if (/\/(user|agent)\/login\/?$/.test(path)) onSignedOut?.(path);
        else if (path === "/" || path === "") {
          // The classic page jumped to the public website (logo click, or a redirect)
          let signedIn = false;
          try {
            signedIn = !!(localStorage.getItem("wacrm_user") || localStorage.getItem("wacrm_agent"));
          } catch {}
          if (!signedIn) onSignedOut?.(path);
          else {
            lastUrl.current = "";
            ref.current.contentWindow.location.replace(frameSrc);
          }
        } else onUrlChange?.(href);
      } catch {}
    }, 700);
    return () => clearInterval(t);
  }, [frameSrc, onUrlChange, onSignedOut]);

  const injectStyles = () => {
    try {
      const doc = ref.current.contentDocument;
      if (doc && !doc.getElementById("omni-embed")) {
        const style = doc.createElement("style");
        style.id = "omni-embed";
        style.textContent = EMBED_CSS;
        doc.head.appendChild(style);
      }
      // The classic app renders late and switches pages in place, so keep checking
      let queued = false;
      const run = () => {
        queued = false;
        fixOffsets(doc);
      };
      run();
      const obs = new doc.defaultView.MutationObserver(() => {
        if (!queued) {
          queued = true;
          doc.defaultView.requestAnimationFrame(run);
        }
      });
      obs.observe(doc.body, { childList: true, subtree: true });
      doc.defaultView.addEventListener("resize", run);
    } catch {}
    ready.current = true;
    setLoading(false);
  };

  const reload = () => {
    try {
      ref.current.contentWindow.location.reload();
    } catch {}
  };

  return (
    <div className="cf" style={hidden ? { display: "none" } : undefined}>
      <div className="cf-tools">
        <button type="button" onClick={reload} aria-label="Reload page" title="Reload page">
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <a href={src} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
      {loading && (
        <div className="cf-loading" aria-live="polite">
          Loading…
        </div>
      )}
      <iframe ref={ref} className="cf-frame" src={frameSrc} title="Page" onLoad={injectStyles} />
    </div>
  );
}

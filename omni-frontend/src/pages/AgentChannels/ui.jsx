import { useEffect, useRef, useState } from "react";
import { Check, Minus, MoreHorizontal, X } from "lucide-react";
import { BRAND_PATHS } from "../../components/brand/brandPaths.js";
import { TABS } from "./model.js";

const BRAND_FILL = {
  whatsapp: "#25D366",
  telegram: "#26A5E4",
  messenger: "#0866FF",
  instagram: "url(#ac-ig-grad)",
};

// Real brand logo
export function Logo({ tab, size = 28, muted = false }) {
  const id = TABS.find((t) => t.id === tab)?.logo || tab;
  return (
    <svg
      className="ac-ch"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      style={muted ? { filter: "grayscale(1)", opacity: 0.5 } : undefined}
    >
      {id === "instagram" && (
        <defs>
          <radialGradient id="ac-ig-grad" cx="0.3" cy="1.07" r="1.3">
            <stop offset="0.1" stopColor="#FFDD55" />
            <stop offset="0.5" stopColor="#FF543E" />
            <stop offset="1" stopColor="#C837AB" />
          </radialGradient>
        </defs>
      )}
      <path d={BRAND_PATHS[id]} fill={BRAND_FILL[id]} />
    </svg>
  );
}

export function Box({ state }) {
  return (
    <span
      className={`ac-box ${state === true ? "is-on" : ""} ${state === "mixed" ? "is-mixed" : ""}`}
      aria-hidden
    >
      {state === true && <Check size={12} strokeWidth={3} />}
      {state === "mixed" && <Minus size={12} strokeWidth={3} />}
    </span>
  );
}

export function Radio({ on }) {
  return <span className={`ac-radio ${on ? "is-on" : ""}`} aria-hidden />;
}

const initials = (n) =>
  String(n || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

export function Avatar({ name, size = 36 }) {
  return (
    <span className="ac-av" style={{ width: size, height: size, fontSize: size * 0.34 }} title={name}>
      {initials(name)}
    </span>
  );
}

// Centered dialog
export function Modal({
  title,
  sub,
  onClose,
  children,
  footer,
  width = 560,
  busy = false,
  className = "",
  as = "div",
  onSubmit,
}) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [busy, onClose]);
  const Tag = as;
  return (
    <div className="ac-modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <Tag
        className={`ac-dlg ${className}`}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={onSubmit}
      >
        <div className="ac-dlg-head">
          <div>
            <h3>{title}</h3>
            {sub && <p>{sub}</p>}
          </div>
          <button type="button" className="ac-x" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="ac-dlg-body">{children}</div>
        {footer && <div className="ac-dlg-foot">{footer}</div>}
      </Tag>
    </div>
  );
}

// ⋯ button with a small menu
export function MoreMenu({ items, label = "More actions", align = "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const k = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <span className="ac-more" ref={ref} onClick={(e) => e.stopPropagation()}>
      <span
        role="button"
        tabIndex={0}
        className={`ac-more-btn ${open ? "is-open" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen((o) => !o))}
      >
        <MoreHorizontal size={16} />
      </span>
      {open && (
        <div className={`ac-menu ac-menu--${align}`} role="menu">
          {items.filter(Boolean).map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              className={it.danger ? "is-danger" : ""}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.icon}
              <span>
                {it.label}
                {it.hint && <small>{it.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

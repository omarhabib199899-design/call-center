import { BRAND_PATHS } from "../../components/brand/brandPaths.js";
import { STATUS, typeOf, initials, avatarColor } from "./meta.js";

const LOGO = { whatsapp: "whatsapp", instagram: "instagram", messenger: "messenger", telegram: "telegram" };
const FILL = { whatsapp: "#25D366", telegram: "#26A5E4", messenger: "#00B2FF", instagram: "url(#cmp-ig)" };

export function Logo({ tab, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={tab} role="img" className="cmp-logo">
      {tab === "instagram" && (
        <defs>
          <radialGradient id="cmp-ig" cx="0.3" cy="1.07" r="1.3">
            <stop offset="0.1" stopColor="#FFDD55" />
            <stop offset="0.5" stopColor="#FF543E" />
            <stop offset="1" stopColor="#C837AB" />
          </radialGradient>
        </defs>
      )}
      <path d={BRAND_PATHS[LOGO[tab]]} fill={FILL[tab]} />
    </svg>
  );
}

export function StatusPill({ status }) {
  const s = STATUS[status] || STATUS.draft;
  const Icon = s.icon;
  return (
    <span className={`cmp-status cmp-status--${status}`}>
      {Icon ? <Icon size={12} strokeWidth={2.2} /> : <i />}
      {s.label}
    </span>
  );
}

export function TypeIcon({ type, size = 38 }) {
  const t = typeOf(type);
  const Icon = t.icon;
  return (
    <span className="cmp-type-ico" style={{ width: size, height: size, background: t.bg, color: t.fg }}>
      <Icon size={Math.round(size * 0.47)} strokeWidth={1.6} />
    </span>
  );
}

export function Avatar({ name, uid, size = 26 }) {
  return (
    <span
      className="cmp-av"
      style={{ width: size, height: size, background: avatarColor(uid || name), fontSize: size * 0.38 }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function Check({ on, mixed }) {
  return (
    <span className={`cmp-check ${on ? "is-on" : ""} ${mixed ? "is-mixed" : ""}`} aria-hidden>
      {on && (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}

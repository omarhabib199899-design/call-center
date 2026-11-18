import { BRAND_PATHS } from "../../components/brand/brandPaths.js";
import { PLATFORMS, avatarColor, initials } from "./model.js";

// Small round platform badge (white logo on brand colour)
export function ChannelMark({ platform, size = 16, ring = true }) {
  const p = PLATFORMS[platform] || PLATFORMS.whatsapp;
  const bg =
    platform === "instagram" ? "linear-gradient(145deg, #833AB4 6%, #FD1D1D 50%, #FCB045 94%)" : p.color;
  return (
    <span
      className={`ib-cmark ${ring ? "has-ring" : ""}`}
      style={{ width: size, height: size, background: bg }}
      title={p.label}
      aria-label={p.label}
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" aria-hidden>
        <path d={BRAND_PATHS[p.logo]} fill="#fff" />
      </svg>
    </span>
  );
}

export function Avatar({ name, seed, size = 36 }) {
  return (
    <span
      className="ib-av"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.32),
        background: avatarColor(seed || name),
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

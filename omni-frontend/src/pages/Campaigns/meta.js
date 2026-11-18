import { ShoppingBag, Tag, Moon, Rocket, Sun, Sparkles, Pencil, Clock, Check } from "lucide-react";
import { api } from "../../api/session.js";

async function call(path, role, body) {
  const res = await api(
    `/api/omni_campaigns/${path}`,
    role,
    body ? { method: "POST", body: JSON.stringify(body) } : {},
  );
  if (!res?.success) throw new Error(res?.msg || "Something went wrong");
  return res;
}
export const listCampaigns = (role) => call("list", role).then((r) => r.data);
export const loadOptions = (role, exclude) =>
  call(`options${exclude ? `?exclude=${exclude}` : ""}`, role).then((r) => r.data);
export const saveCampaign = (role, c) => call("save", role, c).then((r) => r.data);
export const deleteCampaign = (role, id) => call("delete", role, { id });
export const duplicateCampaign = (role, id) => call("duplicate", role, { id }).then((r) => r.data);
export const endCampaign = (role, id) => call("end_now", role, { id }).then((r) => r.data);

export const TYPES = [
  { id: "white_friday", label: "White Friday", icon: ShoppingBag, bg: "#FBF4DC", fg: "#765C05" },
  { id: "black_friday", label: "Black Friday", icon: Tag, bg: "#ECEDF1", fg: "#202020" },
  { id: "ramadan", label: "Ramadan", icon: Moon, bg: "#EFF2FB", fg: "#0D2366" },
  { id: "product_launch", label: "Product launch", icon: Rocket, bg: "#FDEDEF", fg: "#A33A4C" },
  { id: "seasonal", label: "Seasonal offers", icon: Sun, bg: "#FFF3E0", fg: "#A15C07" },
  { id: "custom", label: "Custom", icon: Sparkles, bg: "#EAF6F2", fg: "#0F7A62" },
];
export const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[TYPES.length - 1];

export const STATUS = {
  draft: { label: "Draft", icon: Pencil },
  upcoming: { label: "Upcoming", icon: Clock },
  active: { label: "Active" },
  completed: { label: "Completed", icon: Check },
};

export const CHANNEL_TABS = [
  { id: "whatsapp", label: "WhatsApp", channels: ["qr", "meta"] },
  { id: "instagram", label: "Instagram", channels: ["instagram"] },
  { id: "messenger", label: "Messenger", channels: ["messenger"] },
  { id: "telegram", label: "Telegram", channels: ["telegram"] },
];
export const tabOfChannel = (ch) => CHANNEL_TABS.find((t) => t.channels.includes(ch))?.id || "whatsapp";
export const tabOfKey = (key) => tabOfChannel(String(key).split(":")[0]);

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const asDate = (s) => new Date(`${s}T00:00:00`);
export const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 86400000);

export function fmtDay(s, withYear) {
  if (!s) return "";
  return asDate(s).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
export function fmtRange(a, b) {
  if (!a || !b) return "";
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return `${fmtDay(a, !sameYear)} – ${fmtDay(b, true)}`;
}

// Status the way the server computes it (used for live previews)
export function previewStatus(start, end, draft) {
  if (draft || !start || !end) return "draft";
  const t = todayStr();
  if (t < start) return "upcoming";
  if (t > end) return "completed";
  return "active";
}

// "18 days left", "Starts in 33 days", ..
export function timing(c) {
  if (!c.start_date || !c.end_date) return "No dates yet";
  const t = todayStr();
  if (c.status === "draft") return `${daysBetween(c.start_date, c.end_date) + 1} days`;
  if (t < c.start_date) {
    const n = daysBetween(t, c.start_date);
    return n === 1 ? "Starts tomorrow" : `Starts in ${n} days`;
  }
  if (t > c.end_date) {
    const n = daysBetween(c.end_date, t);
    return n === 1 ? "Ended yesterday" : `Ended ${n} days ago`;
  }
  const left = daysBetween(t, c.end_date);
  return left === 0 ? "Ends today" : left === 1 ? "Ends tomorrow" : `${left} days left`;
}

export function progress(c) {
  if (c.status !== "active") return 0;
  const total = daysBetween(c.start_date, c.end_date) + 1;
  return Math.min(1, (daysBetween(c.start_date, todayStr()) + 1) / total);
}

export function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
export const AVATAR_COLORS = ["#5A73D8", "#2A8BC2", "#B25A73", "#3E8C6A", "#C08A2E", "#7C5CDB"];
export const avatarColor = (s) =>
  AVATAR_COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

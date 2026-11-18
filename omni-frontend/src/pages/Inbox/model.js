// Data side of the new Inbox
import { io } from "socket.io-client";
import { api, tokenFor } from "../../api/session.js";

export const PLATFORMS = {
  whatsapp: { label: "WhatsApp", origins: ["qr", "meta"], logo: "whatsapp", color: "#16A34A" },
  instagram: {
    label: "Instagram",
    origins: ["instagram", "instagram_comment"],
    logo: "instagram",
    color: "#E1306C",
  },
  messenger: {
    label: "Facebook Messenger",
    short: "Messenger",
    origins: ["messenger"],
    logo: "messenger",
    color: "#168AFF",
  },
  telegram: { label: "Telegram", origins: ["telegram"], logo: "telegram", color: "#26A5E4" },
};
export const platformOf = (origin) =>
  Object.keys(PLATFORMS).find((k) => PLATFORMS[k].origins.includes(origin)) || "whatsapp";
export const platformOfChannel = (ch) =>
  ch === "qr" || ch === "meta"
    ? "whatsapp"
    : ch === "messenger"
      ? "messenger"
      : ch === "instagram"
        ? "instagram"
        : ch === "telegram"
          ? "telegram"
          : "whatsapp";

async function call(path, role, body) {
  const res = await api(path, role, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  if (!res?.success)
    throw Object.assign(new Error(res?.msg || "Something went wrong"), { field: res?.field });
  return res.data;
}

export const loadChats = (role, p) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== "" && v != null) qs.set(k, v);
  return call(`/api/omni_inbox/chats?${qs}`, role);
};
export const loadChat = (role, chatId) =>
  call(`/api/omni_inbox/chat?chat_id=${encodeURIComponent(chatId)}`, role);
export const setStatus = (role, chatId, status) =>
  call("/api/omni_inbox/status", role, { chat_id: chatId, status });
export const setPriority = (role, chatId, on) =>
  call("/api/omni_inbox/priority", role, { chat_id: chatId, on });
export const loadActivity = (role, chatId) =>
  call(`/api/omni_inbox/activity?chat_id=${encodeURIComponent(chatId)}`, role);
export const recordSale = (role, f) => call("/api/omni_inbox/sale", role, f);
export const removeSale = (role, id) => call("/api/omni_inbox/sale/remove", role, { id });
export const loadAccounts = (role) => call("/api/omni_inbox/accounts", role);
export const searchCustomers = (role, q) =>
  call(`/api/omni_inbox/customers?q=${encodeURIComponent(q)}`, role);
export const loadAgents = async (role) => {
  if (role !== "owner") return [];
  try {
    const r = await api("/api/agent_accounts/overview", role);
    return r?.success ? r.data.agents || [] : [];
  } catch {
    return [];
  }
};
export async function adLookup(role, mobile) {
  try {
    const r = await api(`/api/ad_sources/lookup?mobile=${encodeURIComponent(mobile || "")}`, role);
    return r?.success ? r.data : null;
  } catch {
    return null;
  }
}

// Upload a file the same way the classic inbox does
export async function uploadMedia(role, file, { convertAudio = false } = {}) {
  const fd = new FormData();
  fd.append("file", file);
  if (convertAudio) {
    fd.append("convert", "YES");
    fd.append("target", "baileys");
  }
  const res = await fetch(role === "agent" ? "/api/agent/return_media_url" : "/api/user/return_media_url", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor(role)}` },
    body: fd,
  });
  const d = await res.json().catch(() => ({}));
  if (!d?.success || !d.url) throw new Error(d?.msg || "Upload failed");
  return d.url;
}

// One socket for the page
export function openSocket(role, handlers) {
  const socket = io(window.location.origin, {
    path: "/socket.io",
    query: { token: tokenFor(role) },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  socket.on("connect", () => handlers.onConnect?.());
  socket.on("connect_error", (e) => handlers.onConnectError?.(e?.message || "Could not connect"));
  socket.on(
    "connection_ack",
    (d) => d?.status === "error" && handlers.onConnectError?.(d.message || "Live connection refused"),
  );
  socket.on("disconnect", () => handlers.onDisconnect?.());
  socket.on("load_conversation", (d) => handlers.onConversation?.(d));
  socket.on("request_update_chat_list", (d) => handlers.onListChanged?.(d || {}));
  socket.on("request_update_opened_chat", () => handlers.onOpenedChanged?.());
  socket.on("update_labels", (d) => handlers.onLabels?.(d));
  socket.on("error", (d) => handlers.onError?.(d?.msg || "Something went wrong"));
  socket.on("ring", () => handlers.onRing?.());
  const send = (type, payload) => socket.emit("message", { type, payload });
  return { socket, send, close: () => socket.close() };
}

export function tsToMs(t) {
  if (t == null || t === "") return 0;
  const n = Number(t);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : 0;
}

// One-line preview of a message's content
export function preview(msg) {
  const c = msg?.msgContext || {};
  const type = c.type || msg?.type;
  const cap = (o) => (o?.caption ? ` ${o.caption}` : "");
  switch (type) {
    case "text":
      return c.text?.body || "";
    case "image":
      return `📷 Photo${cap(c.image)}`;
    case "video":
      return `🎬 Video${cap(c.video)}`;
    case "audio":
      return "🎤 Voice message";
    case "document":
      return `📄 ${c.document?.filename || "Document"}`;
    case "sticker":
      return "Sticker";
    case "location":
      return "📍 Location";
    case "contacts":
      return "👤 Contact";
    case "reaction":
      return `Reacted ${c.reaction?.emoji || ""}`;
    case "interactive":
      return (
        c.interactive?.body?.text ||
        c.interactive?.button_reply?.title ||
        c.interactive?.list_reply?.title ||
        "Interactive message"
      );
    case "button":
      return c.button?.text || "Button";
    case "template":
      return c.template?.name ? `Template: ${c.template.name}` : "Template";
    default:
      return c.text?.body || c.body || (type ? `${type[0].toUpperCase()}${type.slice(1)} message` : "");
  }
}

export function mediaUrl(link) {
  if (!link) return "";
  const s = String(link);
  if (/^(https?:|blob:|data:)/.test(s)) return s;
  if (s.startsWith("/")) return s;
  return `/media/${s}`;
}

export const initials = (n) =>
  String(n || "?")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";

const AV_COLORS = [
  "#6366F1",
  "#EC4899",
  "#0EA5E9",
  "#10B981",
  "#111827",
  "#F97316",
  "#8B5CF6",
  "#14B8A6",
  "#EF4444",
  "#2563EB",
];
export function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

export function shortAgo(t) {
  const ms = tsToMs(t);
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function dayLabel(ms) {
  const d = new Date(ms);
  const t = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === t.getFullYear() ? undefined : "numeric",
  });
}

export const clock = (ms) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const displayName = (c) => c?.contact_name || c?.sender_name || c?.sender_mobile || "Unknown";

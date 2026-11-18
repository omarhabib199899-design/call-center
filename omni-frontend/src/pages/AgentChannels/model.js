// Data side of the Agent & Channel Management page

import { api } from "../../api/session.js";

export const TABS = [
  { id: "whatsapp", label: "WhatsApp", channels: ["qr", "meta"], connect: "wa-qr-connect" },
  { id: "telegram", label: "Telegram", channels: ["telegram"], connect: "telegram-sessions" },
  {
    id: "facebook",
    label: "Facebook",
    channels: ["messenger"],
    logo: "messenger",
    connect: "link-messenger",
  },
  { id: "instagram", label: "Instagram", channels: ["instagram"], connect: "link-instagram" },
];

export function tabOf(channel) {
  return TABS.find((t) => t.channels.includes(channel))?.id || "whatsapp";
}

async function call(path, role, body) {
  const res = await api(path, role, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  if (!res?.success)
    throw Object.assign(new Error(res?.msg || "Something went wrong"), {
      field: res?.field,
      existing: res?.existing,
    });
  return res.data;
}

const EMPTY_STATE = {
  custom: [],
  limits: {},
  targets: {},
  mobiles: {},
  accounts: {},
  vip: [],
  installed: false,
};

// Page state from routes/omniAgents.js
export async function loadState(role) {
  try {
    const res = await api("/api/omni_agents/state", role);
    if (!res?.success) return EMPTY_STATE;
    return { ...EMPTY_STATE, ...res.data, installed: true };
  } catch (e) {
    if (e.signedOut) throw e;
    return EMPTY_STATE;
  }
}

export async function loadOverview(role) {
  const [res, st] = await Promise.all([api("/api/agent_accounts/overview", role), loadState(role)]);
  if (!res?.success) throw new Error(res?.msg || "Could not load agents and accounts");
  const { accounts: raw = [], agents = [], assignments = {} } = res.data || {};
  // Several WhatsApp sessions can share one number
  const byKey = new Map();
  for (const a of raw) {
    const cur = byKey.get(a.key);
    if (!cur) byKey.set(a.key, { ...a, names: [a.name], sessions: 1 });
    else {
      if (!cur.names.includes(a.name)) cur.names.push(a.name);
      cur.sessions += 1;
      cur.online = cur.online || a.online;
    }
  }
  const accounts = [...byKey.values()].map((a) => {
    const s = st.accounts[a.key] || {};
    return {
      ...a,
      name: s.label || a.names.join(" · "),
      off: !!s.deactivated,
      reason: s.reason || null,
      offAt: s.changedAt || null,
    };
  });
  const known = new Set(accounts.map((a) => a.key));
  const clean = {};
  // Drop keys for accounts that were disconnected since they were assigned
  for (const a of agents) clean[a.uid] = (assignments[a.uid] || []).filter((k) => known.has(k));

  const custom = new Map(st.custom.map((c) => [c.uid, c]));
  const people = agents.map((a) => ({
    ...a,
    custom: custom.has(a.uid),
    pending: !!custom.get(a.uid)?.pending,
    limit: st.limits[a.uid] ?? null,
    target: st.targets?.[a.uid] ?? null,
  }));
  return { accounts, agents: people, assignments: clean, vip: st.vip, installed: st.installed };
}

// Old per-agent save, used when the new route isn't installed yet
export async function saveAgent(role, agentUid, keys) {
  const res = await api("/api/agent_accounts/set", role, {
    method: "POST",
    body: JSON.stringify({ agent_uid: agentUid, accounts: keys }),
  });
  if (!res?.success) throw new Error(res?.msg || "Save failed");
  return res.data?.accounts || keys;
}

// Per agent: what the draft adds and removes compared to what is saved
export function diff(saved, draft) {
  const out = [];
  for (const uid of Object.keys(draft)) {
    const before = new Set(saved[uid] || []);
    const after = new Set(draft[uid] || []);
    const added = [...after].filter((k) => !before.has(k));
    const removed = [...before].filter((k) => !after.has(k));
    if (added.length || removed.length) out.push({ uid, added, removed });
  }
  return out;
}

export const saveBatch = (role, agents, vip) => call("/api/omni_agents/save_batch", role, { agents, vip });
export const revert = (role, id) => call("/api/omni_agents/revert", role, { id });
export const loadHistory = (role, days) => call(`/api/omni_agents/history?days=${days}`, role);

export const searchAgents = (role, q) =>
  call(`/api/omni_agents/search_agents?q=${encodeURIComponent(q)}`, role);
export const markCustom = (role, uid) => call("/api/omni_agents/mark_custom", role, { uid });
export const inviteAgent = (role, f) => call("/api/omni_agents/invite", role, f);
export const updateAgent = (role, f) => call("/api/omni_agents/agent/update", role, f);
export const removeAgent = (role, uid) => call("/api/omni_agents/agent/remove", role, { uid });

export const accountImpact = (role, key) =>
  call(`/api/omni_agents/account/impact?key=${encodeURIComponent(key)}`, role);
export const renameAccount = (role, key, label) =>
  call("/api/omni_agents/account/rename", role, { key, label });
export const deactivateAccount = (role, key, reason, note) =>
  call("/api/omni_agents/account/deactivate", role, { key, reason, note });
export const reactivateAccount = (role, key) => call("/api/omni_agents/account/reactivate", role, { key });
export const deleteAccount = (role, key, confirm) =>
  call("/api/omni_agents/account/delete", role, { key, confirm });

export const loadCustomers = (role, key, { q = "", page = 1, only = "" } = {}) =>
  call(
    `/api/omni_agents/customers?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&page=${page}&only=${only}`,
    role,
  );

export const firstName = (n) =>
  String(n || "")
    .trim()
    .split(/\s+/)[0] || "Unnamed";
// "Arwa", "Arwa and Jerome", "Arwa, Jerome and Eleanor", "Arwa, Jerome and 3 others"
export function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ago(t) {
  if (!t) return "";
  let ms = typeof t === "number" || /^\d+$/.test(String(t)) ? Number(t) : Date.parse(t);
  if (ms && ms < 1e12) ms *= 1000;
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

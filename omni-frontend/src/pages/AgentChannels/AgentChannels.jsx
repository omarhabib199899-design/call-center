import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  ExternalLink,
  History,
  Info,
  Loader,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Trash2,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { Avatar, Box, Logo, MoreMenu } from "./ui.jsx";
import {
  AddCustomAgent,
  DeactivateAccount,
  DeleteAccount,
  EditAgent,
  HowItWorks,
  RemoveAgent,
  RenameAccount,
  ReviewRemovals,
} from "./dialogs.jsx";
import { HistoryDrawer, VipDrawer } from "./drawers.jsx";
import {
  diff,
  firstName,
  joinNames,
  loadOverview,
  plural,
  reactivateAccount,
  revert,
  saveAgent,
  saveBatch,
  tabOf,
  TABS,
} from "./model.js";
import "./AgentChannels.css";

const FILTERS = [
  { id: "all", label: "All Agents" },
  { id: "assigned", label: "Assigned" },
  { id: "unassigned", label: "Unassigned" },
  { id: "custom", label: "Custom" },
];
const PAGE_SIZES = [12, 24, 48];
const STEPS = ["Select agents", "Assign accounts", "Review & save"];

function NoAccounts({ onConnect, onHow }) {
  return (
    <div className="ac-hero">
      <div className="ac-hero-art" aria-hidden>
        <svg className="ac-hero-lines" width="240" height="140" viewBox="0 0 240 140">
          <path
            d="M56 30 L100 62 M184 30 L140 62 M56 110 L100 80 M184 110 L140 80"
            stroke="#C9D0E6"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            fill="none"
          />
        </svg>
        <span className="ac-hero-center">
          <Users size={28} />
        </span>
        {[
          ["whatsapp", 12, 4],
          ["telegram", 180, 4],
          ["facebook", 12, 88],
          ["instagram", 180, 88],
        ].map(([t, l, top]) => (
          <span key={t} className="ac-hero-logo" style={{ left: l, top }}>
            <Logo tab={t} size={24} />
          </span>
        ))}
      </div>
      <h2>Connect an account to start assigning</h2>
      <p>
        Once a WhatsApp, Telegram, Facebook or Instagram account is connected, you can choose which agents
        handle its conversations.
      </p>
      <div className="ac-hero-btns">
        <button className="ac-btn ac-btn--primary ac-btn--lg" onClick={onConnect}>
          <Plus size={16} /> Connect account
        </button>
        <button className="ac-btn ac-btn--link ac-btn--lg" onClick={onHow}>
          How assignment works
        </button>
      </div>
    </div>
  );
}

function Stepper({ step }) {
  return (
    <ol className="ac-steps" aria-label="Progress">
      {STEPS.map((s, i) => {
        const n = i + 1;
        const st = n < step ? "done" : n === step ? "now" : "next";
        return (
          <li key={s} className={`is-${st}`} aria-current={st === "now" ? "step" : undefined}>
            <span className="ac-steps-dot">{st === "done" ? <Check size={13} strokeWidth={3} /> : n}</span>
            <span className="ac-steps-label">{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

// 1 2 3 4 … 21
function pageList(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set([1, total, cur - 1, cur, cur + 1]);
  if (cur <= 3) [2, 3, 4].forEach((p) => out.add(p));
  if (cur >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => out.add(p));
  const list = [...out].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const res = [];
  list.forEach((p, i) => {
    if (i && p - list[i - 1] > 1) res.push("…");
    res.push(p);
  });
  return res;
}

export default function AgentChannels({ role, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({});
  const [vipDraft, setVipDraft] = useState(() => new Map());
  const [selected, setSelected] = useState(() => new Set());
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("whatsapp");
  const [accQ, setAccQ] = useState("");
  const [accFilter, setAccFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [saving, setSaving] = useState(null);
  const [justSaved, setJustSaved] = useState(false);
  const [toast, setToast] = useState(null);
  const [dlg, setDlg] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await loadOverview(role);
      setData(d);
      setDraft(Object.fromEntries(Object.entries(d.assignments).map(([k, v]) => [k, [...v]])));
      setVipDraft(new Map());
      const first = TABS.find((t) => d.accounts.some((a) => t.channels.includes(a.channel)));
      if (first) setTab((cur) => (d.accounts.some((a) => tabOf(a.channel) === cur) ? cur : first.id));
      setSelected((s) => new Set([...s].filter((u) => d.agents.some((a) => a.uid === u))));
      return d;
    } catch (e) {
      if (e.signedOut) location.href = "/user/login";
      setError(e.message || "Could not load");
      return null;
    }
  }, [role]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo || toast.reactivate ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const agents = data?.agents || [];
  const accounts = data?.accounts || [];
  const savedVip = data?.vip || [];
  const accountByKey = useMemo(() => new Map(accounts.map((a) => [a.key, a])), [accounts]);
  const agentByUid = useMemo(() => new Map(agents.map((a) => [a.uid, a])), [agents]);
  const go = (id) => onNavigate?.(id);
  const close = () => setDlg(null);

  const vipKey = (u, k) => `${u}|${k}`;
  const vipFor = (u, k) => {
    const d = vipDraft.get(vipKey(u, k));
    if (d) return d;
    const rows = savedVip.filter((v) => v.agent_uid === u && v.acc_key === k);
    return {
      agent_uid: u,
      acc_key: k,
      chat_ids: rows.map((r) => r.chat_id),
      exclusive: rows[0] ? rows[0].exclusive : true,
      names: Object.fromEntries(rows.map((r) => [r.chat_id, r.name || r.mobile])),
    };
  };
  const vipChanges = useMemo(() => {
    const out = [];
    for (const v of vipDraft.values()) {
      const s = savedVip.filter((r) => r.agent_uid === v.agent_uid && r.acc_key === v.acc_key);
      const a = [...v.chat_ids].sort().join();
      const b = s
        .map((r) => r.chat_id)
        .sort()
        .join();
      const ex = s[0] ? s[0].exclusive : true;
      if (a !== b || (v.chat_ids.length && ex !== v.exclusive)) {
        const before = new Set(s.map((r) => r.chat_id));
        out.push({
          ...v,
          added: v.chat_ids.filter((id) => !before.has(id)).length,
          removed: s.filter((r) => !v.chat_ids.includes(r.chat_id)).length,
        });
      }
    }
    return out;
  }, [vipDraft, savedVip]);

  const changes = useMemo(() => (data ? diff(data.assignments, draft) : []), [data, draft]);
  const dirty = changes.length > 0 || vipChanges.length > 0;
  const nAdded =
    changes.reduce((s, c) => s + c.added.length, 0) + vipChanges.reduce((s, v) => s + v.added, 0);
  const nRemoved =
    changes.reduce((s, c) => s + c.removed.length, 0) + vipChanges.reduce((s, v) => s + v.removed, 0);

  useEffect(() => {
    if (!dirty) return;
    setJustSaved(false);
    const h = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const counts = useMemo(() => {
    const c = { all: agents.length, assigned: 0, unassigned: 0, custom: 0 };
    for (const a of agents) {
      (draft[a.uid] || []).length ? c.assigned++ : c.unassigned++;
      if (a.custom) c.custom++;
    }
    return c;
  }, [agents, draft]);

  const visibleAgents = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents.filter((a) => {
      const n = (draft[a.uid] || []).length;
      if (filter === "assigned" && !n) return false;
      if (filter === "unassigned" && n) return false;
      if (filter === "custom" && !a.custom) return false;
      return (
        !needle ||
        [a.name, a.email, a.mobile].some((v) =>
          String(v || "")
            .toLowerCase()
            .includes(needle),
        )
      );
    });
  }, [agents, draft, filter, q]);

  // Agents (draft) that have each account
  const holders = useMemo(() => {
    const m = new Map();
    for (const [uid, keys] of Object.entries(draft))
      for (const k of keys) m.set(k, [...(m.get(k) || []), uid]);
    return m;
  }, [draft]);

  const sel = [...selected];
  const one = sel.length === 1 ? agentByUid.get(sel[0]) : null;
  const has = (uid, key) => (draft[uid] || []).includes(key);
  const stateFor = (key) => {
    if (!sel.length) return false;
    const n = sel.filter((u) => has(u, key)).length;
    return n === 0 ? false : n === sel.length ? true : "mixed";
  };
  const isAdded = (key) => sel.some((u) => has(u, key) && !(data.assignments[u] || []).includes(key));

  const tabAccounts = accounts.filter((a) => tabOf(a.channel) === tab);
  const needle = accQ.trim().toLowerCase();
  const filtered = tabAccounts
    .filter((a) => !needle || `${a.name} ${a.detail}`.toLowerCase().includes(needle))
    .filter((a) => {
      if (accFilter === "unassigned") return !(holders.get(a.key) || []).length;
      if (accFilter === "assigned") return (holders.get(a.key) || []).length > 0;
      if (accFilter === "checked")
        return stateFor(a.key) !== false || (one && vipFor(one.uid, a.key).chat_ids.length > 0);
      if (accFilter === "off") return a.off;
      return true;
    });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, pages);
  const shownAccounts = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);
  const assignable = (list) => list.filter((a) => !a.off);

  useEffect(() => setPage(1), [tab, accQ, accFilter, pageSize]);

  const setFor = (keys, on) => {
    setDraft((d) => {
      const next = { ...d };
      for (const uid of selected) {
        const cur = new Set(next[uid] || []);
        keys.forEach((k) => (on ? cur.add(k) : cur.delete(k)));
        next[uid] = [...cur];
      }
      return next;
    });
    // Whole account replaces specific customers for the selected agents
    if (on)
      setVipDraft((m) => {
        const n = new Map(m);
        for (const uid of selected)
          for (const k of keys)
            if (vipFor(uid, k).chat_ids.length)
              n.set(vipKey(uid, k), { agent_uid: uid, acc_key: k, chat_ids: [], exclusive: true, names: {} });
        return n;
      });
  };

  const toggleAgent = (uid) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(uid) ? n.delete(uid) : n.add(uid);
      return n;
    });

  const pageAssignable = assignable(shownAccounts);
  const pageState = pageAssignable.length
    ? pageAssignable.every((a) => stateFor(a.key) === true)
      ? true
      : pageAssignable.some((a) => stateFor(a.key) !== false)
        ? "mixed"
        : false
    : false;
  const allFiltered = assignable(filtered);
  const allChecked = allFiltered.length > 0 && allFiltered.every((a) => stateFor(a.key) === true);
  const checkedInTab = assignable(tabAccounts).filter((a) => stateFor(a.key) !== false).length;
  const pagesWithChecked = new Set(
    filtered.map((a, i) => (stateFor(a.key) !== false ? Math.floor(i / pageSize) : -1)).filter((x) => x >= 0),
  ).size;

  const addedKeys = new Set(changes.flatMap((c) => c.added));
  const changedPages = new Set(
    filtered
      .map((a, i) =>
        addedKeys.has(a.key) || changes.some((c) => c.removed.includes(a.key))
          ? Math.floor(i / pageSize)
          : -1,
      )
      .filter((x) => x >= 0),
  ).size;

  const discard = () => {
    setDraft(Object.fromEntries(Object.entries(data.assignments).map(([k, v]) => [k, [...v]])));
    setVipDraft(new Map());
  };

  const doSave = async () => {
    setSaving({});
    try {
      const n = nAdded + nRemoved;
      let undoId = null;
      if (data.installed) {
        const agentsMap = Object.fromEntries(changes.map((c) => [c.uid, draft[c.uid] || []]));
        const vip = vipChanges.map(({ agent_uid, acc_key, chat_ids, exclusive }) => ({
          agent_uid,
          acc_key,
          chat_ids,
          exclusive,
        }));
        const r = await saveBatch(role, agentsMap, vip);
        undoId = r?.id || null;
      } else {
        for (const c of changes) await saveAgent(role, c.uid, draft[c.uid] || []);
      }
      await load();
      setSaving(null);
      setDlg(null);
      setJustSaved(true);
      setToast({ text: `${plural(n, "assignment")} saved`, undo: undoId });
    } catch (e) {
      setSaving({ error: e.message });
    }
  };
  const saveOrReview = () => (nRemoved > 0 ? setDlg({ type: "review" }) : doSave());

  const undo = async (id) => {
    setToast(null);
    try {
      await revert(role, id);
      setToast({ text: "Changes undone" });
    } catch (e) {
      setToast({ text: `Could not undo: ${e.message}` });
    }
    await load();
  };

  const afterAction = async (text) => {
    setDlg(null);
    setToast({ text });
    await load();
  };

  const reactivate = async (acc) => {
    try {
      await reactivateAccount(role, acc.key);
      afterAction(`${acc.name} resumed`);
    } catch (e) {
      setToast({ text: `Could not reactivate: ${e.message}` });
    }
  };

  if (error) {
    return (
      <main className="ac-page">
        <div className="ac-center">
          <p className="ac-error">{error}</p>
          <button className="ac-btn" onClick={load}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="ac-page">
        <div className="ac-center ac-muted">
          <Loader size={18} className="ac-spin" /> Loading agents and accounts…
        </div>
      </main>
    );
  }

  const step = !selected.size ? 1 : dirty ? 3 : 2;
  const head = (
    <header className="ac-head">
      <div>
        <h1>Agent &amp; Channel Management</h1>
        <p>Assign connected communication accounts to the agents who manage them.</p>
      </div>
      <div className="ac-head-side">
        {accounts.length > 0 && <Stepper step={step} />}
        <div className="ac-head-links">
          {data.installed && (
            <button className="ac-btn ac-btn--sm" onClick={() => setDlg({ type: "history" })}>
              <History size={15} /> History
            </button>
          )}
          <a className="ac-classic" href="/agent-numbers.html" target="_blank" rel="noreferrer">
            Classic page <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </header>
  );

  const dialogs = (
    <>
      {dlg?.type === "how" && <HowItWorks onClose={close} />}
      {dlg?.type === "history" && (
        <HistoryDrawer
          role={role}
          agents={agents}
          initialAgent={dlg.agent || ""}
          onClose={close}
          onReverted={(t) => {
            setToast({ text: t });
            load();
          }}
        />
      )}
      {dlg?.type === "add" && (
        <AddCustomAgent
          role={role}
          customCount={counts.custom}
          onClose={close}
          onDone={async ({ uid, toast: t }) => {
            setDlg(null);
            setToast({ text: t });
            await load();
            setFilter("custom");
            setSelected(new Set([uid]));
          }}
        />
      )}
      {dlg?.type === "edit" && (
        <EditAgent
          role={role}
          agent={dlg.agent}
          nAccounts={(draft[dlg.agent.uid] || []).length}
          onClose={close}
          onSaved={afterAction}
        />
      )}
      {dlg?.type === "remove" && (
        <RemoveAgent role={role} agent={dlg.agent} onClose={close} onDone={afterAction} />
      )}
      {dlg?.type === "rename" && (
        <RenameAccount role={role} acc={dlg.acc} onClose={close} onDone={afterAction} />
      )}
      {dlg?.type === "deactivate" && (
        <DeactivateAccount
          role={role}
          acc={dlg.acc}
          onClose={close}
          onDone={async (acc) => {
            setDlg(null);
            setToast({ text: `${acc.name} paused — agents no longer see it`, reactivate: acc.key });
            await load();
          }}
        />
      )}
      {dlg?.type === "delete" && (
        <DeleteAccount
          role={role}
          acc={dlg.acc}
          onClose={close}
          onDone={afterAction}
          onDeactivate={() => setDlg({ type: "deactivate", acc: dlg.acc })}
        />
      )}
      {dlg?.type === "vip" && (
        <VipDrawer
          role={role}
          acc={dlg.acc}
          agent={dlg.agent}
          agentByUid={agentByUid}
          holders={holders.get(dlg.acc.key) || []}
          initial={vipFor(dlg.agent.uid, dlg.acc.key)}
          onClose={close}
          onApply={(r) => {
            const { acc, agent } = dlg;
            if (r.scope === "whole") {
              setDraft((d) => ({ ...d, [agent.uid]: [...new Set([...(d[agent.uid] || []), acc.key])] }));
              setVipDraft((m) =>
                new Map(m).set(vipKey(agent.uid, acc.key), {
                  agent_uid: agent.uid,
                  acc_key: acc.key,
                  chat_ids: [],
                  exclusive: true,
                  names: {},
                }),
              );
            } else {
              // Specific customers replace whole-account access for this agent
              setDraft((d) => ({ ...d, [agent.uid]: (d[agent.uid] || []).filter((k) => k !== acc.key) }));
              setVipDraft((m) =>
                new Map(m).set(vipKey(agent.uid, acc.key), {
                  agent_uid: agent.uid,
                  acc_key: acc.key,
                  chat_ids: r.chat_ids,
                  exclusive: r.exclusive,
                  names: r.names,
                }),
              );
            }
            setDlg(null);
          }}
        />
      )}
      {dlg?.type === "customers" && (
        <VipDrawer
          role={role}
          acc={dlg.acc}
          agentByUid={agentByUid}
          holders={holders.get(dlg.acc.key) || []}
          viewOnly
          onClose={close}
        />
      )}
      {dlg?.type === "review" && (
        <ReviewRemovals
          changes={changes}
          vipChanges={vipChanges}
          accountByKey={accountByKey}
          agentByUid={agentByUid}
          holdersAfter={holders}
          saving={saving}
          onBack={() => {
            setSaving(null);
            setDlg(null);
          }}
          onSave={doSave}
        />
      )}
      {toast && (
        <div className="ac-toast" role="status">
          <span className="ac-toast-ok">
            <Check size={13} strokeWidth={3} />
          </span>
          {toast.text}
          {toast.undo && <button onClick={() => undo(toast.undo)}>Undo</button>}
          {toast.reactivate && (
            <button
              onClick={async () => {
                const acc = accountByKey.get(toast.reactivate) || { key: toast.reactivate, name: "Account" };
                setToast(null);
                await reactivate(acc);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </>
  );

  if (!accounts.length) {
    return (
      <main className="ac-page">
        <div className="ac-scroll">
          {head}
          <NoAccounts onConnect={() => go("wa-qr-connect")} onHow={() => setDlg({ type: "how" })} />
        </div>
        {dialogs}
      </main>
    );
  }

  const T = TABS.find((t) => t.id === tab);
  const pendingSel = sel.map((u) => agentByUid.get(u)).filter((a) => a?.pending);
  const nameList = joinNames(sel.map((u) => firstName(agentByUid.get(u)?.name)));

  return (
    <main className="ac-page">
      <div className="ac-scroll">
        {head}

        <div className="ac-cols">
          <section className="ac-left">
            <div className="ac-sec-head">
              <span className="ac-num">01</span>
              <div className="ac-sec-title">
                <h3>Select agents</h3>
                <p>Choose one or multiple agents</p>
              </div>
              {selected.size > 0 ? (
                <span className="ac-chip">{selected.size} selected</span>
              ) : (
                <span className="ac-start">Start here</span>
              )}
            </div>

            <label className="ac-search">
              <Search size={16} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search agents by name or email"
              />
              {q && (
                <button onClick={() => setQ("")} aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </label>

            <div className="ac-filters" role="tablist">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={filter === f.id}
                  className={filter === f.id ? "is-on" : ""}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label} <span>{counts[f.id]}</span>
                </button>
              ))}
            </div>

            {filter === "custom" && (
              <div className="ac-rule">
                <Info size={14} />
                <span>
                  Each agent can only be assigned accounts from this workspace. Custom agents see just what
                  you check for them here.
                </span>
              </div>
            )}

            {filter === "custom" && !visibleAgents.length && !q ? (
              <div className="ac-custom-empty">
                <span className="ac-custom-ico">
                  <Users size={20} />
                </span>
                <h4>No Custom Agents Yet</h4>
                <p>Create and assign agents exclusively for this client.</p>
                <button
                  className="ac-btn ac-btn--primary"
                  onClick={() => setDlg({ type: "add" })}
                  disabled={!data.installed}
                >
                  <Plus size={15} /> Add custom agent
                </button>
              </div>
            ) : (
              <>
                {visibleAgents.length > 0 && (
                  <div className="ac-bulk">
                    <button onClick={() => setSelected(new Set(visibleAgents.map((a) => a.uid)))}>
                      Select all
                    </button>
                    {selected.size > 0 && <button onClick={() => setSelected(new Set())}>Clear</button>}
                  </div>
                )}
                <ul className="ac-agents">
                  {visibleAgents.map((a) => {
                    const on = selected.has(a.uid);
                    const n = (draft[a.uid] || []).length;
                    const vipN = savedVip.filter((v) => v.agent_uid === a.uid).length;
                    const edited =
                      changes.some((c) => c.uid === a.uid) || vipChanges.some((v) => v.agent_uid === a.uid);
                    return (
                      <li key={a.uid}>
                        <div
                          className={`ac-agent ${on ? "is-on" : ""}`}
                          onClick={() => toggleAgent(a.uid)}
                          role="button"
                          tabIndex={0}
                          aria-pressed={on}
                          onKeyDown={(e) =>
                            (e.key === " " || e.key === "Enter") &&
                            e.target === e.currentTarget &&
                            (e.preventDefault(), toggleAgent(a.uid))
                          }
                        >
                          <Box state={on} />
                          <Avatar name={a.name} />
                          <span className="ac-agent-info">
                            <span className="ac-agent-name">
                              <span className="ac-trunc">{a.name || "Unnamed"}</span>
                              {a.pending && <em className="ac-pill ac-pill--gold">Invite pending</em>}
                              {a.custom && !a.pending && <em className="ac-pill ac-pill--blue">Custom</em>}
                              {!Number(a.is_active) && <em className="ac-tag">Inactive</em>}
                              {edited && <em className="ac-tag ac-tag--edit">Edited</em>}
                            </span>
                            <span className="ac-agent-email">{a.email}</span>
                            {a.mobile && <span className="ac-agent-phone">{a.mobile}</span>}
                          </span>
                          <span className="ac-agent-count">
                            <b>{n}</b>
                            <small>
                              {a.limit != null ? `of ${a.limit}` : n === 1 ? "account" : "accounts"}
                            </small>
                            {vipN > 0 && <small className="ac-vipn">+{vipN} VIP</small>}
                          </span>
                          {data.installed && (
                            <MoreMenu
                              label={`Actions for ${a.name}`}
                              items={[
                                {
                                  label: "Edit details",
                                  icon: <Pencil size={15} />,
                                  onClick: () => setDlg({ type: "edit", agent: a }),
                                },
                                {
                                  label: "View assigned accounts",
                                  icon: <Eye size={15} />,
                                  onClick: () => {
                                    setSelected(new Set([a.uid]));
                                    setAccFilter("checked");
                                    const k = (draft[a.uid] || [])[0];
                                    if (k) setTab(tabOf(accountByKey.get(k)?.channel));
                                  },
                                },
                                {
                                  label: "History",
                                  icon: <Clock size={15} />,
                                  onClick: () => setDlg({ type: "history", agent: a.name }),
                                },
                                {
                                  label: "Remove agent",
                                  icon: <UserMinus size={15} />,
                                  danger: true,
                                  onClick: () => setDlg({ type: "remove", agent: a }),
                                },
                              ]}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {!visibleAgents.length && <li className="ac-none">No agents match.</li>}
                </ul>
                {filter === "custom" && (
                  <button
                    className="ac-add-custom"
                    onClick={() => setDlg({ type: "add" })}
                    disabled={!data.installed}
                  >
                    <Plus size={15} /> Add custom agent
                  </button>
                )}
              </>
            )}
          </section>

          <section className="ac-right">
            <div className="ac-sec-head">
              <span className="ac-num">02</span>
              <div className="ac-sec-title">
                <h3>Assign channels &amp; accounts</h3>
                <p>Select the connected accounts agents can access</p>
              </div>
              <button className="ac-btn ac-btn--sm" onClick={() => go(T.connect)}>
                <Plus size={15} /> Create Channel
              </button>
            </div>

            <div className="ac-tabs" role="tablist">
              {TABS.map((t) => {
                const list = accounts.filter((a) => tabOf(a.channel) === t.id);
                const off = list.filter((a) => a.off).length;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    className={tab === t.id ? "is-on" : ""}
                    onClick={() => setTab(t.id)}
                  >
                    <Logo tab={t.id} />
                    <span>
                      <b>{t.label}</b>
                      <small>
                        {off ? `${list.length - off} active · ${off} paused` : `${list.length} connected`}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>

            {!selected.size ? (
              <div className="ac-locked-panel">
                <span className="ac-lock-ico">
                  <Lock size={22} />
                </span>
                <b>Select an agent to unlock accounts</b>
                <p>Accounts you check here will be visible to the agents you select on the left.</p>
                <span className="ac-lock-hint">
                  <ArrowLeft size={16} /> Choose agents from the list
                </span>
              </div>
            ) : !tabAccounts.length ? (
              <div className="ac-tab-empty">
                <Logo tab={tab} size={40} />
                <p>No {T.label} accounts connected yet.</p>
                <button className="ac-btn" onClick={() => go(T.connect)}>
                  <Plus size={14} /> Connect {T.label}
                </button>
              </div>
            ) : (
              <>
                {pendingSel.length > 0 && (
                  <div className="ac-callout ac-callout--gold">
                    <Info size={16} />
                    <span>
                      {joinNames(pendingSel.map((a) => firstName(a.name)))} can be assigned now — the invite
                      is still pending. They’ll see these accounts as soon as they sign in.
                    </span>
                  </div>
                )}
                <div className="ac-hint">
                  <Info size={16} />
                  <span>
                    Checked accounts will be visible in{" "}
                    {sel.length === 1 ? `${firstName(one?.name)}’s` : "these agents’"} inbox.
                    {one &&
                      data.installed &&
                      " You can also give them only specific customers of an account."}
                  </span>
                </div>
                <div className="ac-toolbar">
                  <label className="ac-search ac-grow">
                    <Search size={16} />
                    <input
                      value={accQ}
                      onChange={(e) => setAccQ(e.target.value)}
                      placeholder="Search accounts by name or number"
                    />
                  </label>
                  <label className="ac-select">
                    <select
                      value={accFilter}
                      onChange={(e) => setAccFilter(e.target.value)}
                      aria-label="Show accounts"
                    >
                      <option value="all">All accounts</option>
                      <option value="unassigned">Unassigned only</option>
                      <option value="assigned">Assigned only</option>
                      <option value="checked">Checked for selection</option>
                      {tabAccounts.some((a) => a.off) && <option value="off">Paused</option>}
                    </select>
                    <ChevronDown size={15} />
                  </label>
                  <button
                    className="ac-selall"
                    onClick={() =>
                      setFor(
                        pageAssignable.map((a) => a.key),
                        pageState !== true,
                      )
                    }
                    disabled={!pageAssignable.length}
                  >
                    <Box state={pageState} /> {pages > 1 ? "Select page" : "Select all"}
                  </button>
                </div>

                {accFilter !== "all" && (
                  <div className="ac-filter-note">
                    Showing {filtered.length} of {tabAccounts.length} {T.label} accounts
                    <button onClick={() => setAccFilter("all")}>Show all</button>
                  </div>
                )}

                {pages > 1 && pageState === true && !allChecked && (
                  <div className="ac-banner">
                    <Info size={16} />
                    <span>All {pageAssignable.length} accounts on this page are selected.</span>
                    <button
                      className="ac-banner-main"
                      onClick={() =>
                        setFor(
                          allFiltered.map((a) => a.key),
                          true,
                        )
                      }
                    >
                      Select all {allFiltered.length} {T.label} accounts
                    </button>
                    <button
                      className="ac-banner-sub"
                      onClick={() =>
                        setFor(
                          allFiltered.map((a) => a.key),
                          false,
                        )
                      }
                    >
                      Clear selection
                    </button>
                  </div>
                )}
                {pages > 1 && allChecked && (
                  <div className="ac-banner">
                    <Check size={16} />
                    <span>
                      All {allFiltered.length} {T.label} accounts are selected.
                    </span>
                    <button
                      className="ac-banner-sub"
                      onClick={() =>
                        setFor(
                          allFiltered.map((a) => a.key),
                          false,
                        )
                      }
                    >
                      Clear selection
                    </button>
                  </div>
                )}

                <ul className="ac-accounts">
                  {shownAccounts.map((acc) => {
                    const st = stateFor(acc.key);
                    const who = holders.get(acc.key) || [];
                    const nSel = sel.filter((u) => has(u, acc.key)).length;
                    const vipN = one ? vipFor(one.uid, acc.key).chat_ids.length : 0;
                    const menu = data.installed && (
                      <MoreMenu
                        label={`Actions for ${acc.name}`}
                        items={[
                          {
                            label: "View All Customers",
                            icon: <Eye size={15} />,
                            onClick: () => setDlg({ type: "customers", acc }),
                          },
                          {
                            label: "Rename",
                            icon: <Pencil size={15} />,
                            onClick: () => setDlg({ type: "rename", acc }),
                          },
                          acc.off
                            ? {
                                label: "Resume Channel",
                                icon: <RotateCcw size={15} />,
                                onClick: () => reactivate(acc),
                              }
                            : {
                                label: "Pause Channel",
                                hint: "Agents stop seeing it",
                                icon: <Clock size={15} />,
                                onClick: () => setDlg({ type: "deactivate", acc }),
                              },
                          {
                            label: "Delete Channel",
                            icon: <Trash2 size={15} />,
                            danger: true,
                            disabled: acc.channel === "meta",
                            title:
                              acc.channel === "meta"
                                ? "Disconnect the Cloud API from its Channels page"
                                : undefined,
                            onClick: () => setDlg({ type: "delete", acc }),
                          },
                        ]}
                      />
                    );
                    if (acc.off) {
                      return (
                        <li key={acc.key}>
                          <div className="ac-acc is-off" title="Paused — agents don’t see this account">
                            <span className="ac-box is-disabled" aria-hidden />
                            <span className="ac-acc-info">
                              <span className="ac-acc-name">
                                <span className="ac-trunc">{acc.name}</span>
                                <em className="ac-pill ac-pill--grey">Paused</em>
                              </span>
                              <span className="ac-acc-detail">
                                {acc.detail || "All chats on this channel"}
                              </span>
                            </span>
                            <button className="ac-btn ac-btn--sm" onClick={() => reactivate(acc)}>
                              <RotateCcw size={14} /> Resume
                            </button>
                            {menu}
                          </div>
                        </li>
                      );
                    }
                    const partial = st === false && vipN > 0;
                    return (
                      <li key={acc.key}>
                        <div
                          className={`ac-acc ${st === true ? "is-on" : ""} ${st === "mixed" || partial ? "is-mixed" : ""}`}
                          onClick={() => setFor([acc.key], st !== true)}
                          role="button"
                          tabIndex={0}
                          aria-pressed={st === true}
                          onKeyDown={(e) =>
                            (e.key === " " || e.key === "Enter") &&
                            e.target === e.currentTarget &&
                            (e.preventDefault(), setFor([acc.key], st !== true))
                          }
                          title={
                            who.length
                              ? `Handled by: ${who.map((u) => agentByUid.get(u)?.name || u).join(", ")}`
                              : "No agent handles this account"
                          }
                        >
                          <Box state={partial ? "mixed" : st} />
                          <span className="ac-acc-info">
                            <span className="ac-acc-name">
                              <span className="ac-trunc">{acc.name}</span>
                              {acc.channel === "qr" && !acc.online && <em className="ac-tag">Offline</em>}
                              {acc.sessions > 1 && <em className="ac-tag">{acc.sessions} sessions</em>}
                            </span>
                            <span className={`ac-acc-detail ${st === "mixed" ? "is-mixed" : ""}`}>
                              {acc.detail || "All chats on this channel"}
                              {st === "mixed" && `  ·  ${nSel} of ${sel.length}`}
                            </span>
                            {one && st !== true && data.installed && (
                              <button
                                className="ac-vip-link"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDlg({ type: "vip", acc, agent: one });
                                }}
                              >
                                <Star size={12} />
                                {vipN ? `${plural(vipN, "VIP customer")} · Edit` : "Only specific customers…"}
                              </button>
                            )}
                          </span>
                          {partial ? (
                            <span className="ac-added">
                              <Star size={11} /> +{vipN} VIP
                            </span>
                          ) : isAdded(acc.key) ? (
                            <span className="ac-added">
                              <Plus size={11} strokeWidth={2.5} /> Added
                            </span>
                          ) : who.length ? (
                            <span className="ac-stack">
                              {who.slice(0, 3).map((u) => (
                                <Avatar key={u} name={agentByUid.get(u)?.name} size={24} />
                              ))}
                              {who.length > 3 && <span className="ac-av ac-av--more">+{who.length - 3}</span>}
                            </span>
                          ) : (
                            <span className="ac-noagent">No agent</span>
                          )}
                          {menu}
                        </div>
                      </li>
                    );
                  })}
                  {!shownAccounts.length && <li className="ac-none">No accounts match.</li>}
                </ul>

                {pages > 1 && (
                  <div className="ac-pager">
                    {checkedInTab > 0 && (
                      <span className="ac-pill ac-pill--gold ac-pager-sel">
                        {checkedInTab} selected
                        {pagesWithChecked > 1 ? ` · across ${pagesWithChecked} pages` : ""}
                        <button onClick={() => setAccFilter(accFilter === "checked" ? "all" : "checked")}>
                          {accFilter === "checked" ? "Show all" : "Show selected"}
                        </button>
                      </span>
                    )}
                    <span className="ac-grow" />
                    <span className="ac-muted-sm">
                      {(curPage - 1) * pageSize + 1}–{Math.min(filtered.length, curPage * pageSize)} of{" "}
                      {filtered.length}
                    </span>
                    <button
                      className="ac-pg"
                      disabled={curPage <= 1}
                      onClick={() => setPage(curPage - 1)}
                      aria-label="Previous page"
                    >
                      <ChevronLeft size={15} />
                    </button>
                    {pageList(curPage, pages).map((p, i) =>
                      p === "…" ? (
                        <span key={`e${i}`} className="ac-muted-sm">
                          …
                        </span>
                      ) : (
                        <button
                          key={p}
                          className={`ac-pg ${p === curPage ? "is-on" : ""}`}
                          onClick={() => setPage(p)}
                          aria-current={p === curPage ? "page" : undefined}
                        >
                          {p}
                        </button>
                      ),
                    )}
                    <button
                      className="ac-pg"
                      disabled={curPage >= pages}
                      onClick={() => setPage(curPage + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight size={15} />
                    </button>
                    <label className="ac-select ac-select--sm">
                      <select
                        value={pageSize}
                        onChange={(e) => setPageSize(Number(e.target.value))}
                        aria-label="Accounts per page"
                      >
                        {PAGE_SIZES.map((n) => (
                          <option key={n} value={n}>
                            {n} / page
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </label>
                  </div>
                )}

                <div className="ac-legend">
                  <span>
                    <Box state={true} />{" "}
                    {sel.length === 1
                      ? "The selected agent has it"
                      : `All ${sel.length} selected agents have it`}
                  </span>
                  <span>
                    <Box state="mixed" /> {sel.length === 1 ? "Specific customers only" : "Some of them"}
                  </span>
                  <span>
                    <Box state={false} /> {sel.length === 1 ? "Doesn't have it" : "None of them"}
                  </span>
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <footer className="ac-foot">
        <div>
          {!selected.size && !dirty ? (
            <>
              <b>No agents selected</b>
              <span>Start by choosing at least one agent</span>
            </>
          ) : !dirty ? (
            justSaved ? (
              <>
                <b>All changes saved</b>
                <span>{nameList || "Select agents to keep assigning"}</span>
              </>
            ) : (
              <>
                <b>{plural(selected.size, "agent")} selected</b>
                <span>
                  {justSaved ? "All assignment changes are saved" : "Choose the accounts they can access"}
                </span>
              </>
            )
          ) : (
            <>
              <b>
                {plural(selected.size, "agent")}
                {addedKeys.size > 0 && ` · ${plural(addedKeys.size, "account")} added`}
                {vipChanges.length > 0 &&
                  ` · ${plural(
                    vipChanges.reduce((s, v) => s + v.chat_ids.length, 0),
                    "VIP customer",
                  )}`}
              </b>
              <span className={changedPages > 1 || nRemoved ? "is-gold" : ""}>
                {nRemoved > 0
                  ? "Not saved yet — removing access needs a quick review"
                  : `${changedPages > 1 ? `Across ${changedPages} pages — ` : ""}${plural(nAdded, "new assignment")}${changedPages > 1 ? ", not saved yet" : " — not saved yet"}`}
              </span>
            </>
          )}
        </div>
        <div className="ac-foot-btns">
          <button className="ac-btn" disabled={!dirty || (!!saving && !saving.error)} onClick={discard}>
            Discard changes
          </button>
          <button
            className="ac-btn ac-btn--primary"
            disabled={!dirty || (!!saving && !saving.error)}
            onClick={saveOrReview}
          >
            {saving && !saving.error && dlg?.type !== "review" ? (
              <Loader size={16} className="ac-spin" />
            ) : null}
            {nRemoved > 0 ? "Review before saving" : "Save changes"}
          </button>
        </div>
        {saving?.error && dlg?.type !== "review" && <div className="ac-foot-err">{saving.error}</div>}
      </footer>

      {dialogs}
    </main>
  );
}

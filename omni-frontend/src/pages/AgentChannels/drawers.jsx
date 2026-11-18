import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader,
  RotateCcw,
  Search,
  Star,
  X,
} from "lucide-react";
import { Avatar, Box, Logo, Radio } from "./ui.jsx";
import { ago, firstName, loadCustomers, loadHistory, plural, revert, tabOf, TABS } from "./model.js";

function Drawer({ title, sub, onClose, children, footer, width = 520 }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="ac-drawer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="ac-drawer"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="ac-drawer-head">
          <div>
            <h3>{title}</h3>
            {sub && <p>{sub}</p>}
          </div>
          <button className="ac-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="ac-drawer-body">{children}</div>
        {footer && <div className="ac-drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}

const KIND_TAG = {
  assign: null,
  revert: { label: "Reverted", cls: "ac-pill--grey" },
  agent: { label: "Agent details", cls: "ac-pill--blue" },
  account: { label: "Account", cls: "ac-pill--grey" },
  custom: { label: "Custom agent", cls: "ac-pill--blue" },
};

function dayLabel(d) {
  const t = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return "TODAY";
  if (diff === 1) return "YESTERDAY";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }).toUpperCase();
}

export function HistoryDrawer({ role, agents, initialAgent = "", onClose, onReverted }) {
  const [days, setDays] = useState(30);
  const [agent, setAgent] = useState(initialAgent);
  const [channel, setChannel] = useState("");
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = async () => {
    setErr("");
    try {
      setRows(await loadHistory(role, days));
    } catch (e) {
      setErr(e.message);
      setRows([]);
    }
  };
  useEffect(() => {
    setRows(null);
    load();
  }, [days]);

  const shown = (rows || []).filter(
    (r) => (!agent || r.agents.includes(agent)) && (!channel || r.channels.includes(channel)),
  );
  const groups = [];
  for (const r of shown) {
    const d = new Date(String(r.createdAt).replace(" ", "T"));
    const label = isNaN(d) ? "" : dayLabel(d);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push({ ...r, d });
    else groups.push({ label, items: [{ ...r, d }] });
  }

  const doRevert = async (r) => {
    setBusy(r.id);
    try {
      await revert(role, r.id);
      setConfirm(null);
      await load();
      onReverted(`Reverted: ${r.summary}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer title="Assignment history" sub="Every saved change, newest first" onClose={onClose}>
      <div className="ac-hist-filters">
        <label className="ac-select ac-select--sm">
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.uid} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="ac-select ac-select--sm">
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
            <option value="">All channels</option>
            {TABS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="ac-select ac-select--sm">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      {err && <div className="ac-error-box">{err}</div>}
      {rows === null ? (
        <p className="ac-muted-line">
          <Loader size={14} className="ac-spin" /> Loading…
        </p>
      ) : !shown.length ? (
        <p className="ac-empty-line">
          Nothing saved in this period{agent || channel ? " for this filter" : ""}.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="ac-hist-day">
            <span className="ac-hist-cap">{g.label}</span>
            <ul>
              {g.items.map((r) => {
                const tag = KIND_TAG[r.kind];
                return (
                  <li key={r.id} className={`ac-hist-item ${r.reverted_by ? "is-reverted" : ""}`}>
                    <Avatar name={r.actor} size={28} />
                    <div className="ac-hist-main">
                      <b>{r.summary}</b>
                      <small>
                        {r.actor} ·{" "}
                        {isNaN(r.d)
                          ? ""
                          : r.d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </small>
                      <span className="ac-hist-tags">
                        {r.added > 0 && <span className="ac-pill ac-pill--gold">+{r.added} assigned</span>}
                        {r.removed > 0 && <span className="ac-pill ac-pill--red">−{r.removed} removed</span>}
                        {tag && <span className={`ac-pill ${tag.cls}`}>{tag.label}</span>}
                        {r.reverted_by && <span className="ac-pill ac-pill--grey">Reverted</span>}
                        {r.agents.length > 0 && (
                          <span className="ac-hist-agents">{r.agents.map(firstName).join(", ")}</span>
                        )}
                      </span>
                      {r.revertable &&
                        (confirm === r.id ? (
                          <div className="ac-hist-confirm">
                            <span>Restores access as it was before this save.</span>
                            <button
                              className="ac-btn ac-btn--sm"
                              onClick={() => setConfirm(null)}
                              disabled={busy === r.id}
                            >
                              Cancel
                            </button>
                            <button
                              className="ac-btn ac-btn--sm ac-btn--primary"
                              onClick={() => doRevert(r)}
                              disabled={busy === r.id}
                            >
                              {busy === r.id ? (
                                <Loader size={14} className="ac-spin" />
                              ) : (
                                <RotateCcw size={14} />
                              )}{" "}
                              Revert
                            </button>
                          </div>
                        ) : (
                          <button className="ac-hist-revert" onClick={() => setConfirm(r.id)}>
                            <RotateCcw size={13} /> Revert this save
                          </button>
                        ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Drawer>
  );
}

// Pick VIP customers of one account for one agent
export function VipDrawer({
  role,
  acc,
  agent: agentIn,
  agentByUid,
  holders,
  initial: initialIn,
  onClose,
  onApply,
  viewOnly = false,
}) {
  const agent = agentIn || { uid: "", name: "" };
  const initial = initialIn || { chat_ids: [], exclusive: true, names: {} };
  const [scope, setScope] = useState("specific");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [only, setOnly] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(
    () => new Map(initial.chat_ids.map((id) => [id, initial.names?.[id] || ""])),
  );
  const [exclusive, setExclusive] = useState(initial.exclusive !== false);
  const [owners, setOwners] = useState({});

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const d = await loadCustomers(role, acc.key, { q: q.trim(), page, only: only ? "vip" : "" });
        if (!live) return;
        setData(d);
        setOwners((o) => {
          const n = { ...o };
          for (const r of d.rows) if (r.vip && r.vip.agent_uid !== agent.uid) n[r.chat_id] = r.vip.agent_uid;
          return n;
        });
      } catch (e) {
        if (live) setErr(e.message);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [role, acc.key, q, page, only, agent.uid]);

  const toggle = (r) =>
    setPicked((m) => {
      const n = new Map(m);
      n.has(r.chat_id) ? n.delete(r.chat_id) : n.set(r.chat_id, r.name);
      return n;
    });

  const conflicts = [...picked.keys()]
    .filter((id) => owners[id])
    .map((id) => ({ id, name: picked.get(id), owner: agentByUid.get(owners[id])?.name }));
  const first = firstName(agent.name);
  const tab = tabOf(acc.channel);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const from = data && data.total ? (data.page - 1) * data.size + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.size) : 0;
  const others = holders.filter((u) => u !== agent.uid).map((u) => firstName(agentByUid.get(u)?.name));

  const apply = () =>
    scope === "whole"
      ? onApply({ scope: "whole" })
      : onApply({
          scope: "specific",
          chat_ids: [...picked.keys()],
          exclusive,
          names: Object.fromEntries(picked),
        });

  return (
    <Drawer
      width={560}
      title={viewOnly ? `${acc.name} · customers` : `${acc.name} · specific customers`}
      sub={`${TABS.find((t) => t.id === tab)?.label} · ${acc.detail || acc.account_id}`}
      onClose={onClose}
      footer={
        viewOnly ? (
          <>
            <span className="ac-grow" />
            <button className="ac-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <span className="ac-grow" />
            <button className="ac-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="ac-btn ac-btn--primary"
              onClick={apply}
              disabled={scope === "specific" && !picked.size && !initial.chat_ids.length}
            >
              {scope === "whole"
                ? `Give ${first} the whole account`
                : picked.size
                  ? `Assign ${plural(picked.size, "customer")} to ${first}`
                  : initial.chat_ids.length
                    ? `Remove ${first}’s specific customers`
                    : `Assign customers to ${first}`}
            </button>
          </>
        )
      }
    >
      {!viewOnly && (
        <div className="ac-vip-to">
          <span>Assigning to</span>
          <Avatar name={agent.name} size={26} />
          <b>{agent.name}</b>
        </div>
      )}
      {!viewOnly && (
        <div className="ac-field">
          <span className="ac-field-label">Scope</span>
          <div className="ac-seg">
            <button className={scope === "whole" ? "is-on" : ""} onClick={() => setScope("whole")}>
              <Radio on={scope === "whole"} /> Whole account
            </button>
            <button className={scope === "specific" ? "is-on" : ""} onClick={() => setScope("specific")}>
              <Radio on={scope === "specific"} /> Specific customers
            </button>
          </div>
        </div>
      )}

      {scope === "whole" && !viewOnly ? (
        <p className="ac-note">
          {first} will see every conversation on {acc.name}.
          {initial.chat_ids.length ? " Their specific customers here are cleared." : ""}
        </p>
      ) : (
        <>
          <label className="ac-search">
            <Search size={16} />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search by name or phone number"
            />
          </label>
          {err && <div className="ac-error-box">{err}</div>}
          <div className="ac-cust-head">
            <span>Customer</span>
            <span>Handled now by</span>
          </div>
          <ul className="ac-cust">
            {!data ? (
              <li className="ac-none">
                <Loader size={14} className="ac-spin" /> Loading customers…
              </li>
            ) : !data.rows.length ? (
              <li className="ac-none">
                {q
                  ? "No customers match."
                  : only
                    ? "None selected yet."
                    : "No conversations on this account yet."}
              </li>
            ) : (
              data.rows.map((r) => {
                const on = picked.has(r.chat_id);
                const vipOf = r.vip ? agentByUid.get(r.vip.agent_uid)?.name : null;
                return (
                  <li key={r.chat_id}>
                    <button
                      className={`ac-cust-row ${on ? "is-on" : ""} ${viewOnly ? "is-view" : ""}`}
                      onClick={() => !viewOnly && toggle(r)}
                      aria-pressed={viewOnly ? undefined : on}
                    >
                      {!viewOnly && <Box state={on} />}
                      <Avatar name={r.name} size={30} />
                      <span className="ac-cust-who">
                        <b>{r.name}</b>
                        <small>
                          {r.mobile}
                          {r.last_at ? ` · ${ago(r.last_at)}` : ""}
                        </small>
                      </span>
                      <span className="ac-cust-by">
                        {vipOf ? (
                          <span className="ac-pill ac-pill--gold">
                            <Star size={10} /> VIP · {firstName(vipOf)}
                          </span>
                        ) : holders.length ? (
                          <small>
                            {joinShort(holders.map((u) => firstName(agentByUid.get(u)?.name)))} · via account
                          </small>
                        ) : (
                          <small>No agent</small>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <div className="ac-cust-foot">
            {!viewOnly && (
              <span className="ac-pill ac-pill--gold">
                {picked.size} selected
                <button onClick={() => (setOnly((o) => !o), setPage(1))}>
                  {only ? "Show all" : "Show selected"}
                </button>
              </span>
            )}
            <span className="ac-grow" />
            {data && data.total > 0 && (
              <>
                <span className="ac-muted-sm">
                  {from}–{to} of {data.total.toLocaleString()}
                </span>
                <button
                  className="ac-pg"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  className="ac-pg"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={15} />
                </button>
              </>
            )}
          </div>

          {!viewOnly && conflicts.length > 0 && (
            <div className="ac-callout ac-callout--gold">
              <AlertTriangle size={16} />
              <span>
                {conflicts.length === 1
                  ? `${conflicts[0].name} is already a VIP customer of ${conflicts[0].owner || "another agent"}.`
                  : `${conflicts.length} of these customers are already VIP for other agents.`}{" "}
                Assigning moves {conflicts.length === 1 ? "them" : "them"} to {first}.
              </span>
            </div>
          )}

          {!viewOnly && picked.size > 0 && (
            <div className="ac-rule-box">
              <span className="ac-field-label">Who handles chats from these customers?</span>
              <button className={`ac-reason ${exclusive ? "is-on" : ""}`} onClick={() => setExclusive(true)}>
                <Radio on={exclusive} />
                <span>
                  <b>Only {first}</b>
                  <small>
                    {others.length
                      ? `${joinShort(others)} won’t see them.`
                      : `Other ${acc.name} agents won’t see them.`}
                  </small>
                </span>
              </button>
              <button
                className={`ac-reason ${!exclusive ? "is-on" : ""}`}
                onClick={() => setExclusive(false)}
              >
                <Radio on={!exclusive} />
                <span>
                  <b>{first} and the account’s agents</b>
                  <small>
                    {first} gets them on top of whoever already handles {acc.name}.
                  </small>
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function joinShort(names) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  Loader,
  MessageSquarePlus,
  Search,
  SlidersHorizontal,
  Tag,
  X,
} from "lucide-react";
import { ChannelMark, Avatar } from "./bits.jsx";
import {
  PLATFORMS,
  displayName,
  initials,
  platformOf,
  platformOfChannel,
  preview,
  shortAgo,
} from "./model.js";

const STATUS_DOT = { open: "#16A34A", pending: "#D97706", resolved: "#98A2B3" };
const SORTS = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "unread", label: "Unread first" },
  { id: "priority", label: "Priority first" },
];

export default function ChatList({
  isAgent,
  data,
  loading,
  params,
  setParams,
  accounts,
  activeId,
  onOpen,
  onNew,
  onMore,
  searchRef,
}) {
  const [sortOpen, setSortOpen] = useState(false);
  const [adv, setAdv] = useState(false);
  const sortRef = useRef(null);
  useEffect(() => {
    if (!sortOpen) return;
    const h = (e) => sortRef.current && !sortRef.current.contains(e.target) && setSortOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [sortOpen]);

  const c = data?.counts || {};
  const VIEWS = [
    { id: "all", label: "All", n: c.all },
    { id: "unread", label: "Unread", n: c.unread },
    { id: "open", label: "Open", n: c.open },
    { id: "pending", label: "Pending", n: c.pending },
    { id: "resolved", label: "Resolved", n: c.resolved },
    { id: "mine", label: isAgent ? "Assigned to Me" : "Unassigned", n: c.mine },
  ];
  const accList = accounts.filter(
    (a) => !params.platform || platformOfChannel(a.channel) === params.platform,
  );
  const set = (patch) => setParams((p) => ({ ...p, ...patch }));
  const rows = data?.rows || [];
  const nFilters = (params.platform ? 1 : 0) + (params.account ? 1 : 0) + (params.labeled ? 1 : 0);

  return (
    <section className="ib-list" aria-label="Conversations">
      <div className="ib-list-head">
        <div>
          <h1>Inbox</h1>
          <span>{data ? `${(c.all || 0).toLocaleString()} conversations` : "Loading…"}</span>
        </div>
        <div className="ib-head-btns">
          <button
            className="ib-icon-btn"
            onClick={onNew}
            title="New conversation"
            aria-label="New conversation"
          >
            <MessageSquarePlus size={16} />
          </button>
          <button
            className={`ib-icon-btn ${adv || nFilters ? "is-on" : ""}`}
            onClick={() => setAdv((a) => !a)}
            title="Advanced filters"
            aria-label="Advanced filters"
            aria-expanded={adv}
          >
            <SlidersHorizontal size={16} />
            {nFilters > 0 && <i className="ib-dot-n">{nFilters}</i>}
          </button>
        </div>
      </div>

      <label className="ib-search">
        <Search size={15} />
        <input
          ref={searchRef}
          value={params.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search conversations…"
          aria-label="Search conversations"
        />
        {params.q ? (
          <button onClick={() => set({ q: "" })} aria-label="Clear search">
            <X size={14} />
          </button>
        ) : (
          <kbd>⌘ K</kbd>
        )}
      </label>

      <div className="ib-selects">
        <label className="ib-field">
          <span>PLATFORM</span>
          <span className="ib-dd">
            <select value={params.platform} onChange={(e) => set({ platform: e.target.value, account: "" })}>
              <option value="">All Platforms</option>
              {Object.entries(PLATFORMS).map(([k, p]) => (
                <option key={k} value={k}>
                  {p.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </span>
        </label>
        <label className="ib-field">
          <span>ACCOUNT</span>
          <span className="ib-dd">
            <select value={params.account} onChange={(e) => set({ account: e.target.value })}>
              <option value="">All Accounts</option>
              {accList.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </span>
        </label>
      </div>

      {adv && (
        <div className="ib-adv">
          <button
            className={`ib-chip ${params.labeled ? "is-on" : ""}`}
            onClick={() => set({ labeled: params.labeled ? "" : "1" })}
          >
            <Tag size={12} /> Has tags
          </button>
          {nFilters > 0 && (
            <button className="ib-link" onClick={() => set({ platform: "", account: "", labeled: "" })}>
              Clear filters
            </button>
          )}
        </div>
      )}

      <div className="ib-views" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={params.view === v.id}
            className={params.view === v.id ? "is-on" : ""}
            onClick={() => set({ view: v.id })}
          >
            {v.label} <b>{v.n ?? "–"}</b>
          </button>
        ))}
      </div>

      <div className="ib-list-meta">
        <span>
          {data
            ? `${rows.length} showing${data.total > rows.length ? ` of ${data.total.toLocaleString()}` : ""}`
            : ""}
        </span>
        <span className="ib-sort" ref={sortRef}>
          <button onClick={() => setSortOpen((o) => !o)} aria-haspopup="menu" aria-expanded={sortOpen}>
            {SORTS.find((s) => s.id === params.sort)?.label} <ArrowUpDown size={12} />
          </button>
          {sortOpen && (
            <div className="ib-menu" role="menu">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  role="menuitemradio"
                  aria-checked={params.sort === s.id}
                  className={params.sort === s.id ? "is-on" : ""}
                  onClick={() => {
                    set({ sort: s.id });
                    setSortOpen(false);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </span>
      </div>

      <ul className="ib-rows" aria-busy={loading}>
        {!data &&
          Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="ib-row ib-skel">
              <span className="ib-skel-av" />
              <span className="ib-skel-lines">
                <i />
                <i />
                <i />
              </span>
            </li>
          ))}
        {data && !rows.length && (
          <li className="ib-empty-list">
            {params.q
              ? "No conversations match your search."
              : params.view !== "all"
                ? "Nothing here right now."
                : "No conversations yet."}
          </li>
        )}
        {rows.map((r) => {
          const last = r.last_message;
          const mine = last?.route === "OUTGOING";
          const unread = r.unread_count > 0;
          const p = platformOf(r.origin);
          const name = displayName(r);
          return (
            <li key={r.chat_id}>
              <button
                className={`ib-row ${activeId === r.chat_id ? "is-on" : ""} ${unread ? "is-unread" : ""}`}
                onClick={() => onOpen(r)}
              >
                <span className="ib-row-av">
                  <Avatar name={name} seed={r.chat_id} size={40} />
                  <ChannelMark platform={p} size={17} />
                </span>
                <span className="ib-row-main">
                  <span className="ib-row-top">
                    <b>{name}</b>
                    <time>{shortAgo(last?.timestamp || r.updatedAt)}</time>
                  </span>
                  <span className={`ib-row-msg ${mine ? "is-mine" : ""}`}>
                    {mine ? "You: " : ""}
                    {preview(last) || " "}
                  </span>
                  <span className="ib-row-tags">
                    <span className="ib-row-acc">
                      {r.account_name || PLATFORMS[p].short || PLATFORMS[p].label}
                    </span>
                    <i className="ib-sdot" style={{ background: STATUS_DOT[r.status] }} />
                    <small>{r.status[0].toUpperCase() + r.status.slice(1)}</small>
                    {r.priority && <em className="ib-prio">Priority</em>}
                    {r.chat_label.slice(0, 1).map((l) => (
                      <em key={l.id || l.title} className="ib-lbl" style={{ "--c": l.hex || "#98A2B3" }}>
                        {l.title}
                      </em>
                    ))}
                  </span>
                </span>
                <span className="ib-row-side">
                  {unread && <b className="ib-unread">{r.unread_count > 99 ? "99+" : r.unread_count}</b>}
                  {r.assigned_agent[0] && (
                    <span
                      className="ib-agent-av"
                      title={`Assigned to ${r.assigned_agent.map((a) => a.name).join(", ")}`}
                    >
                      {initials(r.assigned_agent[0].name)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {data && data.total > rows.length && (
          <li className="ib-more">
            <button className="ib-btn ib-btn--sm" onClick={onMore} disabled={loading}>
              {loading ? <Loader size={14} className="ib-spin" /> : null} Load more
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

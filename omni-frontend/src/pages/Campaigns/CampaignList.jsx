import { useEffect, useMemo, useState } from "react";
import {
  Search,
  Eye,
  Pencil,
  Trash2,
  Ellipsis,
  Plus,
  Copy,
  CircleStop,
  Megaphone,
  Users,
  CalendarDays,
  X,
  ChevronDown,
} from "lucide-react";
import { TYPES, typeOf, fmtRange, timing, progress, tabOfKey, CHANNEL_TABS } from "./meta.js";
import { Logo, StatusPill, TypeIcon, Avatar } from "./bits.jsx";

const FILTERS = ["all", "active", "upcoming", "draft", "completed"];
const LABEL = { all: "All", active: "Active", upcoming: "Upcoming", draft: "Draft", completed: "Completed" };
const ORDER = { active: 0, upcoming: 1, draft: 2, completed: 3 };

function Channels({ keys }) {
  const tabs = CHANNEL_TABS.filter((t) => keys.some((k) => tabOfKey(k) === t.id));
  return (
    <span className="cmp-logos">
      {tabs.map((t) => (
        <Logo key={t.id} tab={t.id} />
      ))}
    </span>
  );
}

function AgentStack({ uids, agents }) {
  if (!uids.length) return <span className="cmp-muted">Not assigned</span>;
  const shown = uids.slice(0, 3);
  return (
    <span className="cmp-stack">
      {shown.map((u) => (
        <Avatar key={u} uid={u} name={agents.get(u)?.name || "?"} />
      ))}
      {uids.length > 3 && <span className="cmp-av cmp-av--more">+{uids.length - 3}</span>}
    </span>
  );
}

function RowMenu({ c, onAction }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="cmp-menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="cmp-icon-btn" aria-label="More actions" onClick={() => setOpen((o) => !o)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <ul className="cmp-menu">
          {c.status !== "draft" && (
            <li>
              <button onClick={() => onAction("duplicate", c)}>
                <Copy size={14} /> Duplicate
              </button>
            </li>
          )}
          {c.status === "active" && (
            <li>
              <button onClick={() => onAction("end", c)}>
                <CircleStop size={14} /> End now
              </button>
            </li>
          )}
          {c.status !== "active" && (
            <li>
              <button className="danger" onClick={() => onAction("delete", c)}>
                <Trash2 size={14} /> Delete
              </button>
            </li>
          )}
        </ul>
      )}
    </span>
  );
}

export function CampaignTable({ campaigns, agents, onOpen, onEdit, onAction }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");

  const counts = useMemo(() => {
    const c = { all: campaigns.length };
    for (const x of campaigns) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }, [campaigns]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return campaigns
      .filter((c) => filter === "all" || c.status === filter)
      .filter((c) => !type || c.type === type)
      .filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          typeOf(c.type).label.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          ORDER[a.status] - ORDER[b.status] ||
          String(a.start_date || "9").localeCompare(String(b.start_date || "9")),
      );
  }, [campaigns, filter, q, type]);

  return (
    <div className="cmp-list">
      <div className="cmp-toolbar">
        <div className="cmp-filter" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={filter === f ? "is-on" : ""}
              onClick={() => setFilter(f)}
            >
              {LABEL[f]} <span>{counts[f] || 0}</span>
            </button>
          ))}
        </div>
        <span className="cmp-grow" />
        <label className="cmp-input cmp-input--search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaigns" />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </label>
        <label className="cmp-input cmp-input--select">
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Campaign type">
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <ChevronDown size={16} />
        </label>
      </div>

      <div className="cmp-table-wrap">
        <table className="cmp-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Duration</th>
              <th>Accounts &amp; channels</th>
              <th>Agents</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.status === "active" ? "is-active" : ""} onClick={() => onOpen(c)}>
                <td>
                  <span className="cmp-name">
                    <TypeIcon type={c.type} />
                    <span>
                      <b>{c.name}</b>
                      <small>{typeOf(c.type).label}</small>
                    </span>
                  </span>
                </td>
                <td>
                  {c.start_date && c.end_date ? (
                    <>
                      <b className="cmp-cell-main">{fmtRange(c.start_date, c.end_date)}</b>
                      <small className="cmp-cell-sub">{timing(c)}</small>
                    </>
                  ) : (
                    <span className="cmp-muted">No dates yet</span>
                  )}
                </td>
                <td>
                  {c.accounts.length ? (
                    <>
                      <b className="cmp-cell-main">
                        {c.accounts.length} {c.accounts.length === 1 ? "account" : "accounts"}
                      </b>
                      <Channels keys={c.accounts} />
                    </>
                  ) : (
                    <span className="cmp-muted">No accounts yet</span>
                  )}
                </td>
                <td>
                  <AgentStack uids={c.agents} agents={agents} />
                </td>
                <td>
                  <StatusPill status={c.status} />
                  {c.status === "active" && (
                    <span
                      className="cmp-progress"
                      title={`${Math.round(progress(c) * 100)}% of the way through`}
                    >
                      <i style={{ width: `${progress(c) * 100}%` }} />
                    </span>
                  )}
                </td>
                <td className="cmp-actions" onClick={(e) => e.stopPropagation()}>
                  <div className="cmp-actions-in">
                    {c.status === "draft" ? (
                      <>
                        <button className="cmp-btn cmp-btn--sm" onClick={() => onEdit(c)}>
                          Continue
                        </button>
                        <button
                          className="cmp-icon-btn"
                          aria-label="Delete"
                          onClick={() => onAction("delete", c)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="cmp-btn cmp-btn--sm" onClick={() => onOpen(c)}>
                          <Eye size={14} /> View
                        </button>
                        {c.status !== "completed" && (
                          <button className="cmp-icon-btn" aria-label="Edit" onClick={() => onEdit(c)}>
                            <Pencil size={15} />
                          </button>
                        )}
                      </>
                    )}
                    <RowMenu c={c} onAction={onAction} />
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr className="cmp-none">
                <td colSpan={6}>No campaigns match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TEMPLATES = ["white_friday", "black_friday", "ramadan", "product_launch"];

export function EmptyCampaigns({ onCreate }) {
  return (
    <div className="cmp-empty">
      <div className="cmp-empty-art" aria-hidden>
        <span className="cmp-card cmp-card--a">
          <i />
          <i />
          <i />
        </span>
        <span className="cmp-card cmp-card--b">
          <i />
          <i />
          <i />
        </span>
        <span className="cmp-card cmp-card--c">
          <i />
          <i />
          <i />
        </span>
        <span className="cmp-empty-mega">
          <Megaphone size={24} />
        </span>
      </div>
      <h2>Create your first campaign</h2>
      <p>
        A campaign groups the accounts, channels and agents working on one promotion, with start and end dates
        — so your team always knows what's running and you can see how it went.
      </p>
      <div className="cmp-benefits">
        <div>
          <span>
            <Megaphone size={16} />
          </span>
          <b>Pick the accounts</b>
          <small>WhatsApp, Instagram, Messenger and Telegram accounts you already connected.</small>
        </div>
        <div>
          <span>
            <Users size={16} />
          </span>
          <b>Assign your agents</b>
          <small>Reuse the agents already handling those accounts, or choose others.</small>
        </div>
        <div>
          <span>
            <CalendarDays size={16} />
          </span>
          <b>Set the dates</b>
          <small>Status moves from Upcoming to Active to Completed on its own.</small>
        </div>
      </div>
      <button className="cmp-btn cmp-btn--primary cmp-btn--lg" onClick={() => onCreate()}>
        <Plus size={16} /> Create your first campaign
      </button>
      <div className="cmp-templates">
        <span>Or start from:</span>
        {TEMPLATES.map((id) => {
          const t = typeOf(id);
          const Icon = t.icon;
          return (
            <button
              key={id}
              onClick={() => onCreate({ type: id, name: `${t.label} ${new Date().getFullYear()}` })}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import {
  X,
  Pencil,
  Copy,
  CircleStop,
  Trash2,
  MessageSquare,
  ArrowDownLeft,
  ArrowUpRight,
} from "lucide-react";
import { typeOf, fmtRange, timing, progress, CHANNEL_TABS, tabOfKey, daysBetween } from "./meta.js";
import { Logo, StatusPill, TypeIcon, Avatar } from "./bits.jsx";

const nf = new Intl.NumberFormat("en-US");

// Side panel with one campaign's details, numbers and actions
export default function CampaignView({ c, accounts, agents, onClose, onEdit, onAction }) {
  const groups = CHANNEL_TABS.map((t) => ({
    ...t,
    keys: c.accounts.filter((k) => tabOfKey(k) === t.id),
  })).filter((g) => g.keys.length);
  const s = c.stats;

  return (
    <div className="cmp-drawer-back" onClick={onClose}>
      <aside
        className="cmp-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={c.name}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <TypeIcon type={c.type} size={42} />
          <div>
            <h2>{c.name}</h2>
            <small>{typeOf(c.type).label}</small>
          </div>
          <button className="cmp-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="cmp-drawer-body">
          <div className="cmp-drawer-status">
            <StatusPill status={c.status} />
            <span>{timing(c)}</span>
          </div>
          {c.status === "active" && (
            <span className="cmp-progress cmp-progress--wide">
              <i style={{ width: `${progress(c) * 100}%` }} />
            </span>
          )}

          {s ? (
            <div className="cmp-stats">
              <div>
                <MessageSquare size={15} />
                <b>{nf.format(s.conversations)}</b>
                <small>Conversations</small>
              </div>
              <div>
                <ArrowDownLeft size={15} />
                <b>{nf.format(s.incoming)}</b>
                <small>Messages in</small>
              </div>
              <div>
                <ArrowUpRight size={15} />
                <b>{nf.format(s.outgoing)}</b>
                <small>Replies sent</small>
              </div>
            </div>
          ) : (
            <p className="cmp-note">
              {c.status === "upcoming"
                ? "Numbers show up here once the campaign starts."
                : c.status === "draft"
                  ? "Finish setting up the campaign to see its numbers."
                  : "No numbers for this campaign yet."}
            </p>
          )}

          <dl className="cmp-dl">
            <dt>Dates</dt>
            <dd>
              {c.start_date
                ? `${fmtRange(c.start_date, c.end_date)} · ${daysBetween(c.start_date, c.end_date) + 1} days`
                : "Not set"}
            </dd>
            {c.description && (
              <>
                <dt>Description</dt>
                <dd>{c.description}</dd>
              </>
            )}
            <dt>Accounts &amp; channels · {c.accounts.length}</dt>
            <dd>
              {groups.length ? (
                groups.map((g) => (
                  <div key={g.id} className="cmp-dl-group">
                    <span className="cmp-dl-head">
                      <Logo tab={g.id} /> {g.label} · {g.keys.length}
                    </span>
                    <span className="cmp-chips">
                      {g.keys.map((k) => (
                        <span key={k} className="cmp-chip">
                          {accounts.get(k)?.name || k.split(":")[1]}
                        </span>
                      ))}
                    </span>
                  </div>
                ))
              ) : (
                <span className="cmp-muted">None yet</span>
              )}
            </dd>
            <dt>Agents · {c.agents.length}</dt>
            <dd>
              {c.agents.length ? (
                <ul className="cmp-agent-mini">
                  {c.agents.map((u) => (
                    <li key={u}>
                      <Avatar uid={u} name={agents.get(u)?.name || "?"} size={24} />
                      {agents.get(u)?.name || "Removed agent"}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="cmp-muted">Not assigned</span>
              )}
            </dd>
          </dl>
        </div>

        <footer>
          {c.status === "draft" && (
            <>
              <button className="cmp-btn cmp-btn--danger-ghost" onClick={() => onAction("delete", c)}>
                <Trash2 size={14} /> Delete
              </button>
              <button className="cmp-btn cmp-btn--primary" onClick={() => onEdit(c)}>
                Continue setup
              </button>
            </>
          )}
          {c.status === "upcoming" && (
            <>
              <button className="cmp-btn cmp-btn--danger-ghost" onClick={() => onAction("delete", c)}>
                <Trash2 size={14} /> Delete
              </button>
              <button className="cmp-btn" onClick={() => onAction("duplicate", c)}>
                <Copy size={14} /> Duplicate
              </button>
              <button className="cmp-btn cmp-btn--primary" onClick={() => onEdit(c)}>
                <Pencil size={14} /> Edit
              </button>
            </>
          )}
          {c.status === "active" && (
            <>
              <button className="cmp-btn" onClick={() => onAction("end", c)}>
                <CircleStop size={14} /> End now
              </button>
              <button className="cmp-btn" onClick={() => onAction("duplicate", c)}>
                <Copy size={14} /> Duplicate
              </button>
              <button className="cmp-btn cmp-btn--primary" onClick={() => onEdit(c)}>
                <Pencil size={14} /> Edit
              </button>
            </>
          )}
          {c.status === "completed" && (
            <>
              <button className="cmp-btn cmp-btn--danger-ghost" onClick={() => onAction("delete", c)}>
                <Trash2 size={14} /> Delete
              </button>
              <button className="cmp-btn cmp-btn--primary" onClick={() => onAction("duplicate", c)}>
                <Copy size={14} /> Duplicate for next time
              </button>
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}

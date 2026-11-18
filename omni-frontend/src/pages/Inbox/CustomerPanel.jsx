import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Copy,
  DollarSign,
  ExternalLink,
  Flag,
  Loader,
  Megaphone,
  MessageSquare,
  PanelRightClose,
  Plus,
  RotateCcw,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { Avatar, ChannelMark } from "./bits.jsx";
import { PLATFORMS, displayName, initials, platformOf, recordSale, removeSale, tsToMs } from "./model.js";

const LABEL_COLORS = ["#2563EB", "#16A34A", "#D97706", "#DC2626", "#7C3AED", "#0891B2", "#DB2777", "#475467"];

function when(t) {
  const ms = typeof t === "number" ? t : tsToMs(t) || Date.parse(String(t).replace(" ", "T"));
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same
    ? `Today, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const EV_ICON = {
  open: RotateCcw,
  resolved: CheckCircle2,
  pending: Clock3,
  priority: Flag,
  sale: DollarSign,
  note: StickyNote,
  first: MessageSquare,
  ad: Megaphone,
};

export default function CustomerPanel({
  role,
  isAgent,
  me,
  chat,
  conv,
  activity,
  onReloadActivity,
  send,
  onClose,
  onOpenContacts,
}) {
  const info = conv?.chatInfo || {};
  const allLabels = conv?.labels || [];
  const chatLabels = chat.chat_label || [];
  const notes = Array.isArray(info.chat_note) ? info.chat_note : [];
  const [note, setNote] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [saleOpen, setSaleOpen] = useState(false);
  const [sale, setSale] = useState({
    amount: "",
    currency: localStorage.getItem("omni.currency") || "EGP",
    note: "",
  });
  const [saleErr, setSaleErr] = useState("");
  const [saleBusy, setSaleBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const tagRef = useRef(null);

  useEffect(() => {
    if (!tagOpen) return;
    const h = (e) => tagRef.current && !tagRef.current.contains(e.target) && setTagOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [tagOpen]);

  useEffect(() => {
    setSaleOpen(false);
    setNote("");
    setShowAll(false);
  }, [chat.chat_id]);

  const p = platformOf(chat.origin);
  const name = displayName(chat);
  const contact = info.contactData || null;
  const sales = activity?.sales || [];
  const total = sales.reduce((s, x) => s + Number(x.amount || 0), 0);
  const currency = sales[0]?.currency || sale.currency;
  const firstAt = activity?.firstMessageAt
    ? tsToMs(activity.firstMessageAt)
    : tsToMs(chat.createdAt) || Date.parse(chat.createdAt);
  const email = contact
    ? [contact.var1, contact.var2, contact.var3, contact.var4, contact.var5].find((v) =>
        /@/.test(String(v || "")),
      )
    : null;
  const source = activity?.source;

  // Activity: status events, sales, notes, first message
  const events = [
    ...(activity?.events || []).map((e) => ({
      k: `e${e.id}`,
      kind: e.kind,
      title: e.text,
      by: e.actor,
      at: Date.parse(e.createdAt),
    })),
    ...notes.map((n) => ({
      k: `n${n.id}`,
      kind: "note",
      title: `Note added by ${String(n.name || "").split(" ")[0] || "team"}`,
      at: tsToMs(n.craetedAt) || Date.parse(n.craetedAt) || 0,
    })),
    ...(firstAt ? [{ k: "first", kind: "first", title: "First message", at: firstAt }] : []),
    ...(source
      ? [
          {
            k: "ad",
            kind: "ad",
            title: `Came from ad: ${source.ad_title || "Untitled ad"}`,
            at: Date.parse(source.createdAt),
          },
        ]
      : []),
  ].sort((a, b) => (b.at || 0) - (a.at || 0));
  const shown = showAll ? events : events.slice(0, 4);

  const addNote = () => {
    const t = note.trim();
    if (!t || !info.id) return;
    send("save_chat_note", { id: info.id, chatNote: t });
    setNote("");
  };

  const saveSale = async (e) => {
    e.preventDefault();
    setSaleErr("");
    setSaleBusy(true);
    try {
      await recordSale(role, { chat_id: chat.chat_id, ...sale });
      try {
        localStorage.setItem("omni.currency", sale.currency);
      } catch {}
      setSale((s) => ({ ...s, amount: "", note: "" }));
      setSaleOpen(false);
      onReloadActivity();
    } catch (e2) {
      setSaleErr(e2.message);
    } finally {
      setSaleBusy(false);
    }
  };

  return (
    <aside className="ib-cust" aria-label="Customer details">
      <div className="ib-cust-head">
        <b>Customer details</b>
        <button className="ib-icon-btn" onClick={onClose} aria-label="Hide customer details" title="Hide">
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="ib-cust-scroll">
        <div className="ib-cust-hero">
          <Avatar name={name} seed={chat.chat_id} size={60} />
          <h2>{name}</h2>
          <p>
            {firstAt
              ? `Customer since ${new Date(firstAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
              : " "}
          </p>
          <div className="ib-cust-quick">
            <button
              className="ib-icon-btn"
              title="Copy phone / ID"
              onClick={() => {
                navigator.clipboard?.writeText(chat.sender_mobile || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
            </button>
            <button className="ib-icon-btn" title="Record a sale" onClick={() => setSaleOpen(true)}>
              <DollarSign size={15} />
            </button>
            <button className="ib-icon-btn" title="Open in Contacts" onClick={onOpenContacts}>
              <ExternalLink size={15} />
            </button>
          </div>
        </div>

        <section className="ib-cust-sec">
          <div className="ib-cust-cap">
            <h3>CONTACT INFORMATION</h3>
            <button className="ib-link" onClick={onOpenContacts}>
              Edit
            </button>
          </div>
          <dl className="ib-dl">
            <dt>Phone</dt>
            <dd>{p === "whatsapp" || p === "telegram" ? chat.sender_mobile || "—" : "—"}</dd>
            {p !== "whatsapp" && (
              <>
                <dt>{PLATFORMS[p].short || PLATFORMS[p].label} ID</dt>
                <dd className="ib-mono">{chat.sender_mobile || "—"}</dd>
              </>
            )}
            <dt>Email</dt>
            <dd>{email || "—"}</dd>
            <dt>Customer ID</dt>
            <dd className="ib-mono">CUS-{String(info.id || chat.id || "").padStart(6, "0")}</dd>
            <dt>Source</dt>
            <dd className="ib-src">
              {source ? (
                <span title={source.ad_title || ""}>
                  <Megaphone size={12} /> {source.ad_title || "Ad"}
                </span>
              ) : (
                <>
                  <ChannelMark platform={p} size={14} ring={false} /> {PLATFORMS[p].label}
                </>
              )}
            </dd>
          </dl>
        </section>

        <section className="ib-cust-sec">
          <div className="ib-cust-cap">
            <h3>CRM INFORMATION</h3>
          </div>
          <div className="ib-crm-row">
            <span>Status</span>
            <em className={`ib-pill ${total > 0 ? "is-green" : "is-blue"}`}>
              {total > 0 ? "Active customer" : "Lead"}
            </em>
          </div>
          <div className="ib-crm-row">
            <span>Assigned to</span>
            <span className="ib-crm-agents">
              {(chat.assigned_agent || []).length ? (
                chat.assigned_agent.map((a) => (
                  <span key={a.uid || a.name} className="ib-crm-agent">
                    <span className="ib-agent-av ib-agent-av--sm">{initials(a.name)}</span> {a.name}
                  </span>
                ))
              ) : (
                <span className="ib-muted">Account agents</span>
              )}
            </span>
          </div>
          <div className="ib-crm-row">
            <span>Sales</span>
            <span className="ib-crm-sales">
              {sales.length ? (
                <b>
                  {currency} {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <small>
                    {" "}
                    · {sales.length} {sales.length === 1 ? "order" : "orders"}
                  </small>
                </b>
              ) : (
                <span className="ib-muted">None yet</span>
              )}
              <button className="ib-link" onClick={() => setSaleOpen((o) => !o)}>
                + Record sale
              </button>
            </span>
          </div>
          {saleOpen && (
            <form className="ib-sale" onSubmit={saveSale}>
              <div className="ib-sale-row">
                <input
                  autoFocus
                  inputMode="decimal"
                  placeholder="Amount"
                  value={sale.amount}
                  onChange={(e) => setSale((s) => ({ ...s, amount: e.target.value }))}
                  aria-label="Amount"
                />
                <select
                  value={sale.currency}
                  onChange={(e) => setSale((s) => ({ ...s, currency: e.target.value }))}
                  aria-label="Currency"
                >
                  {["EGP", "SAR", "AED", "KWD", "QAR", "USD", "EUR"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <input
                placeholder="Note (optional), e.g. order number"
                value={sale.note}
                onChange={(e) => setSale((s) => ({ ...s, note: e.target.value }))}
                aria-label="Sale note"
              />
              {saleErr && <span className="ib-err-inline">{saleErr}</span>}
              <div className="ib-sale-btns">
                <button type="button" className="ib-btn ib-btn--sm" onClick={() => setSaleOpen(false)}>
                  Cancel
                </button>
                <button className="ib-btn ib-btn--sm ib-btn--primary" disabled={saleBusy || !sale.amount}>
                  {saleBusy ? <Loader size={13} className="ib-spin" /> : null} Save sale
                </button>
              </div>
              <small className="ib-muted">
                Counts toward “Total Sales” on Home{isAgent ? " and your sales" : ""}.
              </small>
            </form>
          )}
          {sales.length > 0 && (
            <ul className="ib-sales">
              {sales.slice(0, 3).map((s) => (
                <li key={s.id}>
                  <span>
                    {s.currency} {Number(s.amount).toLocaleString()}
                    <small>
                      {s.note ? `${s.note} · ` : ""}
                      {when(s.createdAt)}
                      {s.agent_name ? ` · ${s.agent_name}` : ""}
                    </small>
                  </span>
                  {(!isAgent || s.agent_uid === me?.uid) && (
                    <button
                      className="ib-x-sm"
                      title="Remove sale"
                      aria-label="Remove sale"
                      onClick={async () => {
                        await removeSale(role, s.id).catch(() => {});
                        onReloadActivity();
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="ib-crm-row ib-crm-row--top">
            <span>Tags</span>
            <span className="ib-pop" ref={tagRef}>
              <button className="ib-link" onClick={() => setTagOpen((o) => !o)}>
                + Add
              </button>
              {tagOpen && (
                <div className="ib-menu ib-menu--right ib-menu--wide" role="menu">
                  <span className="ib-menu-cap">Add a tag</span>
                  {allLabels
                    .filter((l) => !chatLabels.some((x) => x.id === l.id))
                    .map((l) => (
                      <button
                        key={l.id}
                        onClick={() => {
                          send("set_chat_label", {
                            labelData: { id: l.id, title: l.title, hex: l.hex },
                            chatIdRow: info.id,
                          });
                          setTagOpen(false);
                        }}
                      >
                        <i className="ib-tagdot" style={{ background: l.hex }} /> {l.title}
                      </button>
                    ))}
                  {!isAgent && (
                    <form
                      className="ib-newtag"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const t = newTag.trim();
                        if (!t) return;
                        send("add_label", {
                          label: t,
                          hex: LABEL_COLORS[allLabels.length % LABEL_COLORS.length],
                        });
                        setNewTag("");
                      }}
                    >
                      <input
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value)}
                        placeholder="New tag name"
                        aria-label="New tag name"
                      />
                      <button className="ib-btn ib-btn--sm" disabled={!newTag.trim()}>
                        Create
                      </button>
                    </form>
                  )}
                </div>
              )}
            </span>
          </div>
          <div className="ib-tags">
            {chatLabels.length ? (
              chatLabels.map((l) => (
                <span key={l.id || l.title} className="ib-tag" style={{ "--c": l.hex || "#475467" }}>
                  {l.title}
                  <button
                    onClick={() => send("remove_chat_label", { labelId: l.id, chatId: info.id })}
                    aria-label={`Remove tag ${l.title}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))
            ) : (
              <span className="ib-muted">No tags</span>
            )}
          </div>
        </section>

        <section className="ib-cust-sec">
          <div className="ib-cust-cap">
            <h3>INTERNAL NOTE</h3>
          </div>
          {notes.length > 0 && (
            <ul className="ib-notes">
              {notes
                .slice()
                .reverse()
                .slice(0, 3)
                .map((n) => (
                  <li key={n.id}>
                    <p>{n.note}</p>
                    <small>
                      {n.name} · {when(tsToMs(n.craetedAt) || n.craetedAt)}
                    </small>
                    {(!isAgent || n.email === me?.email) && (
                      <button
                        className="ib-x-sm"
                        onClick={() => send("delete_chat_note", { chatNoteId: n.id, chatRealId: info.id })}
                        aria-label="Delete note"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          )}
          <textarea
            className="ib-note-in"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a private note for your team…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addNote();
            }}
            aria-label="Internal note"
          />
          <button
            className={`ib-btn ib-btn--sm ${note.trim() ? "ib-btn--primary" : ""}`}
            onClick={addNote}
            disabled={!note.trim() || !info.id}
          >
            Add note
          </button>
        </section>

        <section className="ib-cust-sec">
          <div className="ib-cust-cap">
            <h3>ACTIVITY HISTORY</h3>
            {events.length > 4 && (
              <button className="ib-link" onClick={() => setShowAll((s) => !s)}>
                {showAll ? "Show less" : "View all"}
              </button>
            )}
          </div>
          {!activity ? (
            <p className="ib-muted">
              <Loader size={12} className="ib-spin" /> Loading…
            </p>
          ) : (
            <ol className="ib-timeline">
              {shown.map((e) => {
                const I = EV_ICON[e.kind] || MessageSquare;
                return (
                  <li key={e.k}>
                    <span className="ib-tl-ico">
                      <I size={11} />
                    </span>
                    <span>
                      <b>{e.title}</b>
                      <small>
                        {when(e.at)}
                        {e.by ? ` · ${e.by}` : ""}
                      </small>
                    </span>
                  </li>
                );
              })}
              {!shown.length && <li className="ib-muted">No activity yet.</li>}
            </ol>
          )}
        </section>

        <button className="ib-profile-link" onClick={onOpenContacts}>
          View complete customer profile <ExternalLink size={13} />
        </button>
      </div>
    </aside>
  );
}

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, HelpCircle, Info, Loader, Search, X } from "lucide-react";
import { Avatar, ChannelMark } from "./bits.jsx";
import {
  PLATFORMS,
  displayName,
  loadAccounts,
  platformOf,
  platformOfChannel,
  searchCustomers,
} from "./model.js";

// Start a conversation
export default function NewConversation({ role, send, onClose, onOpenChat, lastError }) {
  const [accounts, setAccounts] = useState(null);
  const [platform, setPlatform] = useState("whatsapp");
  const [accKey, setAccKey] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    loadAccounts(role)
      .then((a) => {
        setAccounts(a);
        const first = a.find((x) => x.canStart) || a[0];
        if (first) {
          setPlatform(platformOfChannel(first.channel));
          setAccKey(first.key);
        }
      })
      .catch((e) => {
        setAccounts([]);
        setErr(e.message);
      });
  }, [role]);

  useEffect(() => {
    const h = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [busy, onClose]);

  useEffect(() => {
    if (q.trim().length < 2) return setFound(null);
    let live = true;
    const t = setTimeout(() => {
      searchCustomers(role, q.trim())
        .then((r) => live && setFound(r))
        .catch(() => live && setFound([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, role]);

  useEffect(() => {
    if (busy && lastError) {
      setBusy(false);
      setErr(lastError);
    }
  }, [lastError, busy]);

  const byPlat = useMemo(() => {
    const m = {};
    for (const a of accounts || []) (m[platformOfChannel(a.channel)] ||= []).push(a);
    return m;
  }, [accounts]);
  const accs = byPlat[platform] || [];
  const acc = accs.find((a) => a.key === accKey) || accs[0];
  const canStart = !!acc?.canStart;
  const digits = phone.replace(/[^\d]/g, "");
  const ready = canStart && digits.length >= 8 && msg.trim();
  const results = (found || []).filter((r) => platformOf(r.origin) === platform);

  const start = () => {
    if (!ready) return;
    setErr("");
    setBusy(true);
    send("send_new_message", {
      instance: acc.instance,
      number: `+${digits}`,
      message: msg.trim(),
      recName: name.trim() || undefined,
    });
    // The socket answers with request_update_chat_list on success, or an error
    const chatId = `${acc.instance.number}_${digits}_`;
    setTimeout(() => onOpenChat({ startsWith: chatId, phone: digits }), 1500);
  };

  return (
    <div className="ib-modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="ib-modal" role="dialog" aria-modal="true" aria-label="New conversation">
        <div className="ib-modal-head">
          <div>
            <h3>New Conversation</h3>
            <p>Start a customer conversation from a connected channel.</p>
          </div>
          <button className="ib-icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={16} />
          </button>
        </div>
        <div className="ib-modal-body">
          {accounts === null ? (
            <p className="ib-muted">
              <Loader size={14} className="ib-spin" /> Loading your accounts…
            </p>
          ) : !accounts.length ? (
            <div className="ib-callout">
              <Info size={15} /> No connected accounts {role === "agent" ? "are assigned to you" : "yet"}.
            </div>
          ) : (
            <>
              <fieldset className="ib-fs">
                <legend>SELECT PLATFORM</legend>
                <div className="ib-plats">
                  {Object.keys(PLATFORMS).map((k) => {
                    const n = (byPlat[k] || []).length;
                    return (
                      <button
                        key={k}
                        type="button"
                        className={`ib-plat ${platform === k ? "is-on" : ""}`}
                        disabled={!n}
                        onClick={() => {
                          setPlatform(k);
                          setAccKey((byPlat[k] || [])[0]?.key || "");
                        }}
                        title={n ? "" : "Not connected"}
                      >
                        <ChannelMark platform={k} size={22} ring={false} />
                        <span>{PLATFORMS[k].short || PLATFORMS[k].label}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <label className="ib-fs">
                <span className="ib-legend">CONNECTED ACCOUNT</span>
                <span className="ib-dd ib-dd--lg">
                  <select value={acc?.key || ""} onChange={(e) => setAccKey(e.target.value)}>
                    {accs.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.name} {a.detail && a.detail !== a.name ? `· ${a.detail}` : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </span>
                {acc && (
                  <span className="ib-from">
                    YOU’LL SEND FROM <b>{acc.name}</b>
                    {acc.channel === "qr" && !acc.online && <em> · offline</em>}
                  </span>
                )}
              </label>

              <div className="ib-fs">
                <span className="ib-legend">FIND AN EXISTING CUSTOMER</span>
                <label className="ib-search ib-search--lg">
                  <Search size={15} />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search name, phone number, or username"
                  />
                </label>
                {found && (
                  <ul className="ib-found">
                    {!results.length && (
                      <li className="ib-muted">
                        No {PLATFORMS[platform].short || PLATFORMS[platform].label} customers match.
                      </li>
                    )}
                    {results.map((r) => (
                      <li key={r.chat_id}>
                        <button onClick={() => onOpenChat(r)}>
                          <Avatar name={displayName(r)} seed={r.chat_id} size={30} />
                          <span>
                            <b>{displayName(r)}</b>
                            <small>
                              {r.sender_mobile} · {r.account_name || PLATFORMS[platform].label}
                            </small>
                          </span>
                          <em>Open chat</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="ib-or">
                <span>or start with a new contact</span>
              </div>

              {canStart ? (
                <div className="ib-newform">
                  <label className="ib-fs">
                    <span className="ib-legend">
                      PHONE NUMBER <em>Required</em>
                    </span>
                    <input
                      className="ib-in"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+20 100 000 0000"
                      inputMode="tel"
                    />
                    <span className="ib-hint2">
                      <HelpCircle size={12} /> Include the country code. We’ll create the customer
                      automatically if they’re new.
                    </span>
                  </label>
                  <label className="ib-fs">
                    <span className="ib-legend">CUSTOMER NAME (optional)</span>
                    <input
                      className="ib-in"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Olivia Martin"
                    />
                  </label>
                  <label className="ib-fs">
                    <span className="ib-legend">
                      FIRST MESSAGE <em>Required</em>
                    </span>
                    <textarea
                      className="ib-in"
                      rows={3}
                      value={msg}
                      onChange={(e) => setMsg(e.target.value)}
                      placeholder="Hi! …"
                    />
                  </label>
                </div>
              ) : (
                <div className="ib-callout">
                  <Info size={15} />
                  <span>
                    {platform === "whatsapp"
                      ? "The WhatsApp Cloud API can only start a conversation with an approved template. Find the customer above, or send a template from the classic inbox."
                      : `${PLATFORMS[platform].label} only lets you reply to customers who messaged you first. Find them above to open their chat.`}
                  </span>
                </div>
              )}
              {err && (
                <div className="ib-callout ib-callout--red">
                  <AlertTriangle size={15} /> {err}
                </div>
              )}
            </>
          )}
        </div>
        <div className="ib-modal-foot">
          <span className="ib-muted ib-grow">
            {canStart ? (ready ? `Sending to +${digits}` : "No recipient selected") : ""}
          </span>
          <button className="ib-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="ib-btn ib-btn--primary" onClick={start} disabled={!ready || busy}>
            {busy ? <Loader size={14} className="ib-spin" /> : null} Start Conversation
          </button>
        </div>
      </div>
    </div>
  );
}

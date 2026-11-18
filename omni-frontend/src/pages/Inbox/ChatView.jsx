import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  Flag,
  Image as ImageIcon,
  Loader,
  MessageSquare,
  PanelRight,
  Paperclip,
  RotateCcw,
  Send,
  Smile,
  UserPlus,
  X,
} from "lucide-react";
import { Avatar, ChannelMark } from "./bits.jsx";
import Message from "./Message.jsx";
import {
  PLATFORMS,
  clock,
  dayLabel,
  displayName,
  initials,
  platformOf,
  preview,
  tsToMs,
  uploadMedia,
} from "./model.js";

const EMOJIS =
  "😀 😂 😊 😍 🥰 😉 😎 🤩 🙏 👍 👌 👏 🙌 💪 🔥 ✨ 🎉 ❤️ 💙 💚 ✅ ❌ ⭐ 📦 🚚 💳 🛒 📞 📍 ⏰ 😅 🤔 😢 😮 🙂 😇".split(
    " ",
  );

function useClickOutside(ref, on, cb) {
  useEffect(() => {
    if (!on) return;
    const h = (e) => ref.current && !ref.current.contains(e.target) && cb();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [on, cb, ref]);
}

function Composer({ role, chat, platform, accountName, disabled, onSend, replyTo, clearReply }) {
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const ta = useRef(null);
  const fileRef = useRef(null);
  const imgRef = useRef(null);
  const emRef = useRef(null);
  useClickOutside(emRef, emoji, () => setEmoji(false));
  const name = displayName(chat);

  // Keep a draft per chat
  const key = `omni.draft.${chat.chat_id}`;
  useEffect(() => {
    try {
      setText(sessionStorage.getItem(key) || "");
    } catch {
      setText("");
    }
    setErr("");
  }, [key]);
  useEffect(() => {
    try {
      text ? sessionStorage.setItem(key, text) : sessionStorage.removeItem(key);
    } catch {}
  }, [key, text]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(160, el.scrollHeight) + "px";
  }, [text]);
  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo]);

  const sendText = () => {
    const body = text.trim();
    if (!body || disabled) return;
    onSend("text", { type: "text", text: { preview_url: true, body } });
    setText("");
    ta.current?.focus();
  };

  const sendFile = async (file) => {
    if (!file) return;
    setErr("");
    const t = file.type || "";
    const kind = t.startsWith("image/")
      ? "image"
      : t.startsWith("video/")
        ? "video"
        : t.startsWith("audio/")
          ? "audio"
          : "document";
    if (file.size > 64 * 1024 * 1024) return setErr("This file is larger than 64 MB.");
    setBusy(kind);
    try {
      const url = await uploadMedia(role, file, { convertAudio: kind === "audio" && chat.origin === "qr" });
      const caption = text.trim();
      const o = { link: url };
      if (kind !== "audio" && caption) o.caption = caption;
      if (kind === "document") o.filename = file.name;
      onSend(kind, { type: kind, [kind]: o });
      if (caption && kind !== "audio") setText("");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <form
      className="ib-composer"
      onSubmit={(e) => {
        e.preventDefault();
        sendText();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        sendFile(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="ib-replying">
        <ChannelMark platform={platform} size={15} ring={false} />
        <span>
          Replying from {PLATFORMS[platform].label}
          {accountName ? ` — ${accountName}` : ""}
        </span>
      </div>
      {replyTo && (
        <div className="ib-replyto">
          <span>
            <b>Replying to {replyTo.route === "OUTGOING" ? "yourself" : name}</b>
            <small>{preview(replyTo)}</small>
          </span>
          <button type="button" onClick={clearReply} aria-label="Cancel reply">
            <X size={14} />
          </button>
        </div>
      )}
      <div className={`ib-box ${disabled ? "is-disabled" : ""}`}>
        <textarea
          ref={ta}
          rows={2}
          value={text}
          disabled={disabled}
          placeholder={disabled ? "You can’t reply to this conversation" : `Message ${name}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendText();
            }
          }}
          onPaste={(e) => {
            const f = [...(e.clipboardData?.files || [])][0];
            if (f) {
              e.preventDefault();
              sendFile(f);
            }
          }}
          aria-label="Message"
        />
        <div className="ib-box-bar">
          <span className="ib-emoji-wrap" ref={emRef}>
            <button
              type="button"
              className="ib-tool"
              onClick={() => setEmoji((x) => !x)}
              aria-label="Emoji"
              title="Emoji"
              disabled={disabled}
            >
              <Smile size={17} />
            </button>
            {emoji && (
              <div className="ib-emoji" role="dialog" aria-label="Pick an emoji">
                {EMOJIS.map((em) => (
                  <button
                    type="button"
                    key={em}
                    onClick={() => {
                      const el = ta.current;
                      const s = el?.selectionStart ?? text.length;
                      const e2 = el?.selectionEnd ?? text.length;
                      setText(text.slice(0, s) + em + text.slice(e2));
                      setTimeout(() => {
                        el?.focus();
                        el?.setSelectionRange(s + em.length, s + em.length);
                      }, 0);
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button
            type="button"
            className="ib-tool"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach file"
            title="Attach file"
            disabled={disabled || !!busy}
          >
            {busy === "document" || busy === "audio" ? (
              <Loader size={16} className="ib-spin" />
            ) : (
              <Paperclip size={17} />
            )}
          </button>
          <button
            type="button"
            className="ib-tool"
            onClick={() => imgRef.current?.click()}
            aria-label="Add image"
            title="Add image or video"
            disabled={disabled || !!busy}
          >
            {busy === "image" || busy === "video" ? (
              <Loader size={16} className="ib-spin" />
            ) : (
              <ImageIcon size={17} />
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => (sendFile(e.target.files?.[0]), (e.target.value = ""))}
          />
          <input
            ref={imgRef}
            type="file"
            accept="image/*,video/*"
            hidden
            onChange={(e) => (sendFile(e.target.files?.[0]), (e.target.value = ""))}
          />
          <span className="ib-hint">
            {err ? (
              <span className="ib-err-inline">{err}</span>
            ) : (
              "Press Enter to send · Shift + Enter for a new line"
            )}
          </span>
          <button
            type="submit"
            className={`ib-send ${text.trim() ? "is-ready" : ""}`}
            disabled={!text.trim() || disabled}
          >
            Send <Send size={13} />
          </button>
        </div>
      </div>
    </form>
  );
}

export default function ChatView({
  role,
  isAgent,
  chat,
  convFailed,
  onRetryConv,
  conv,
  agents,
  onLoadOlder,
  onSend,
  onStatus,
  onPriority,
  onAssign,
  showCustomer,
  onToggleCustomer,
  onBack,
}) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const prevH = useRef(0);
  const [replyTo, setReplyTo] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [lightbox, setLightbox] = useState("");
  const asRef = useRef(null);
  const stRef = useRef(null);
  useClickOutside(asRef, assignOpen, () => setAssignOpen(false));
  useClickOutside(stRef, statusOpen, () => setStatusOpen(false));

  const msgs = conv?.messages || [];
  const p = platformOf(chat.origin);
  const name = displayName(chat);
  const assigned = chat.assigned_agent || [];

  useEffect(() => {
    setReplyTo(null);
    stick.current = true;
  }, [chat.chat_id]);

  // Stay at the bottom for new messages; keep position when older ones load
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (conv?.olderLoaded) {
      el.scrollTop = el.scrollHeight - prevH.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevH.current = el.scrollHeight;
  }, [msgs.length, conv?.olderLoaded, conv?.version]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && conv && msgs.length < conv.total && !conv.loadingOlder) {
      prevH.current = el.scrollHeight;
      onLoadOlder();
    }
  };

  // Group by day
  const items = [];
  let lastDay = "";
  for (const m of msgs) {
    const ms = tsToMs(m.timestamp);
    const d = ms ? dayLabel(ms) : "";
    if (d && d !== lastDay) {
      items.push({ day: d, key: `d-${d}-${m.id}` });
      lastDay = d;
    }
    items.push({ m, key: m.id || m.metaChatId || ms });
  }

  // Meta Cloud API: 24-hour customer service window
  let windowClosed = false;
  if (chat.origin === "meta" && conv?.countDownTimer?.timestamp) {
    windowClosed = Date.now() - tsToMs(conv.countDownTimer.timestamp) > 24 * 3600 * 1000;
  }
  const status = chat.status;

  return (
    <section className="ib-chat" aria-label={`Conversation with ${name}`}>
      <header className="ib-chat-head">
        <button className="ib-icon-btn ib-only-mobile" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft size={16} />
        </button>
        <span className="ib-chat-av">
          <Avatar name={name} seed={chat.chat_id} size={40} />
          <i className="ib-online" style={{ background: PLATFORMS[p].color }} />
        </span>
        <span className="ib-chat-who">
          <b>{name}</b>
          <small>
            {chat.sender_mobile && !/^\d{15,}$/.test(chat.sender_mobile)
              ? chat.sender_mobile
              : PLATFORMS[p].label}
          </small>
        </span>
        <span className="ib-chat-acc">
          <ChannelMark platform={p} size={16} ring={false} />
          <span>
            <small>{PLATFORMS[p].label}</small>
            <b>{chat.account_name || "—"}</b>
          </span>
        </span>
        <span className="ib-chat-actions">
          <button
            className={`ib-icon-btn ${chat.priority ? "is-prio" : ""}`}
            onClick={() => onPriority(!chat.priority)}
            title={chat.priority ? "Remove priority" : "Mark as priority"}
            aria-pressed={chat.priority}
          >
            <Flag size={15} />
          </button>
          {!isAgent && (
            <span className="ib-pop" ref={asRef}>
              <button
                className="ib-icon-btn"
                onClick={() => setAssignOpen((o) => !o)}
                title="Assign agent"
                aria-haspopup="menu"
                aria-expanded={assignOpen}
              >
                <UserPlus size={15} />
              </button>
              {assignOpen && (
                <div className="ib-menu ib-menu--right ib-menu--wide" role="menu">
                  <span className="ib-menu-cap">Assign this conversation</span>
                  {!agents.length && <span className="ib-menu-empty">No agents yet</span>}
                  {agents.map((a) => {
                    const on = assigned.some((x) => x.uid === a.uid);
                    return (
                      <button
                        key={a.uid}
                        role="menuitemcheckbox"
                        aria-checked={on}
                        className={on ? "is-on" : ""}
                        onClick={() => onAssign(a.uid, on)}
                      >
                        <span className="ib-agent-av">{initials(a.name)}</span>
                        <span className="ib-grow">{a.name}</span>
                        {on && <Check size={14} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </span>
          )}
          <span className="ib-split" ref={stRef}>
            <button
              className="ib-btn ib-btn--sm"
              onClick={() => onStatus(status === "resolved" ? "open" : "resolved")}
            >
              {status === "resolved" ? <RotateCcw size={13} /> : <Check size={13} />}
              {status === "resolved" ? "Reopen" : "Resolve"}
            </button>
            <button
              className="ib-btn ib-btn--sm ib-split-arrow"
              onClick={() => setStatusOpen((o) => !o)}
              aria-label="More status options"
              aria-haspopup="menu"
              aria-expanded={statusOpen}
            >
              <ChevronDown size={13} />
            </button>
            {statusOpen && (
              <div className="ib-menu ib-menu--right" role="menu">
                {[
                  ["open", "Open", MessageSquare],
                  ["pending", "Pending — waiting on customer", Clock3],
                  ["resolved", "Resolved", Check],
                ].map(([s, l, I]) => (
                  <button
                    key={s}
                    role="menuitemradio"
                    aria-checked={status === s}
                    className={status === s ? "is-on" : ""}
                    onClick={() => {
                      setStatusOpen(false);
                      onStatus(s);
                    }}
                  >
                    <I size={14} /> {l}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button
            className={`ib-icon-btn ${showCustomer ? "is-on" : ""}`}
            onClick={onToggleCustomer}
            title="Customer details"
            aria-pressed={showCustomer}
          >
            <PanelRight size={15} />
          </button>
        </span>
      </header>

      {(assigned.length > 0 || chat.priority || status !== "open") && (
        <div className="ib-banner">
          {assigned.length > 0 && (
            <>
              <span className="ib-agent-av ib-agent-av--sm">{initials(assigned[0].name)}</span>
              <span>Assigned to {assigned.map((a) => a.name).join(", ")}</span>
            </>
          )}
          {assigned.length > 0 && (chat.priority || status !== "open") && <i className="ib-sep" />}
          {chat.priority && <span className="ib-banner-prio">Priority conversation</span>}
          {chat.priority && status !== "open" && <i className="ib-sep" />}
          {status !== "open" && (
            <span>
              {status === "pending" ? "Pending — waiting on customer" : "Resolved — a new message reopens it"}
            </span>
          )}
        </div>
      )}

      <div className="ib-msgs" ref={scroller} onScroll={onScroll}>
        {!conv && convFailed ? (
          <div className="ib-msgs-loading ib-msgs-failed" role="alert">
            <span>Couldn’t load messages. The live connection to the server isn’t answering.</span>
            <button type="button" className="ib-retry" onClick={onRetryConv}>
              Try again
            </button>
          </div>
        ) : !conv ? (
          <div className="ib-msgs-loading">
            <Loader size={18} className="ib-spin" /> Loading messages…
          </div>
        ) : (
          <>
            {conv.loadingOlder && (
              <div className="ib-older">
                <Loader size={14} className="ib-spin" />
              </div>
            )}
            {!msgs.length && <div className="ib-msgs-loading">No messages yet.</div>}
            {msgs.length > 0 && msgs.length >= conv.total && (
              <div className="ib-start">Start of conversation</div>
            )}
            {items.map((it) =>
              it.day ? (
                <div key={it.key} className="ib-day">
                  <span>{it.day}</span>
                </div>
              ) : (
                <Message
                  key={it.key}
                  m={it.m}
                  onReply={["qr", "meta", "messenger", "instagram"].includes(chat.origin) ? setReplyTo : null}
                  onImage={setLightbox}
                />
              ),
            )}
            {conv.sending.map((s) => (
              <div key={s.tmp} className="ib-msg-row is-out">
                <div className="ib-bubble is-out is-sending">
                  <p className="ib-text">{preview({ msgContext: s.msgCon })}</p>
                  <span className="ib-meta">
                    {clock(s.at)} <Loader size={11} className="ib-spin" />
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {windowClosed && (
        <div className="ib-window">
          The 24-hour reply window for this WhatsApp Cloud API chat has closed. Only an approved template can
          be sent now —{" "}
          <a
            href={`/${isAgent ? "agent" : "user"}?page=${isAgent ? "chat" : "inbox"}`}
            target="_blank"
            rel="noreferrer"
          >
            send one from the classic inbox
          </a>
          .
        </div>
      )}

      <Composer
        role={role}
        chat={chat}
        platform={p}
        accountName={chat.account_name}
        disabled={!conv}
        replyTo={replyTo}
        clearReply={() => setReplyTo(null)}
        onSend={(type, msgCon) => {
          stick.current = true;
          onSend(type, msgCon, replyTo);
          setReplyTo(null);
        }}
      />

      {lightbox && (
        <div className="ib-lightbox" onClick={() => setLightbox("")} role="dialog" aria-label="Image">
          <img src={lightbox} alt="" />
          <button aria-label="Close" onClick={() => setLightbox("")}>
            <X size={20} />
          </button>
        </div>
      )}
    </section>
  );
}

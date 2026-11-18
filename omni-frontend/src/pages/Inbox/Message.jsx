import { useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Download,
  FileText,
  MapPin,
  Pause,
  Play,
  Reply,
  User,
} from "lucide-react";
import { clock, mediaUrl, preview, tsToMs } from "./model.js";

function Ticks({ status }) {
  if (status === "failed") return <AlertCircle size={12} className="ib-tick is-failed" aria-label="Failed" />;
  if (status === "read") return <CheckCheck size={13} className="ib-tick is-read" aria-label="Read" />;
  if (status === "delivered") return <CheckCheck size={13} className="ib-tick" aria-label="Delivered" />;
  if (status === "pending" || status === "sending")
    return <Clock size={11} className="ib-tick" aria-label="Sending" />;
  return <Check size={13} className="ib-tick" aria-label="Sent" />;
}

// Turns URLs into links and keeps *bold* WhatsApp formatting readable
function RichText({ text }) {
  const parts = String(text || "").split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Voice({ src }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState(0);
  const [dur, setDur] = useState(0);
  const bars = [8, 14, 20, 12, 24, 17, 10, 21, 26, 15, 9, 18, 22, 7, 11, 16, 23, 13, 19, 10];
  const fmt = (s) =>
    Number.isFinite(s) && s > 0
      ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
      : "0:00";
  return (
    <span className="ib-voice">
      <button
        className="ib-voice-btn"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          const a = ref.current;
          if (!a) return;
          a.paused ? a.play().catch(() => {}) : a.pause();
        }}
      >
        {playing ? <Pause size={12} fill="#fff" /> : <Play size={12} fill="#fff" />}
      </button>
      <span className="ib-wave" aria-hidden>
        {bars.map((h, i) => (
          <i key={i} style={{ height: h, opacity: i / bars.length < prog ? 1 : 0.45 }} />
        ))}
      </span>
      <span className="ib-voice-t">{fmt(playing || prog ? ref.current?.currentTime : dur)}</span>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProg(0);
        }}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setProg(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
      />
    </span>
  );
}

function ext(name) {
  const m = String(name || "").match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toUpperCase() : "FILE";
}

export default function Message({ m, onReply, onImage }) {
  const c = m.msgContext || {};
  const type = c.type || m.type;
  const out = m.route === "OUTGOING";
  const ms = tsToMs(m.timestamp);
  const ctx = m.context;
  let body;

  switch (type) {
    case "image":
    case "sticker": {
      const o = c[type] || {};
      const src = mediaUrl(o.link || o.url);
      body = (
        <>
          {src ? (
            <button
              className={`ib-img ${type === "sticker" ? "is-sticker" : ""}`}
              onClick={() => onImage?.(src)}
              aria-label="Open image"
            >
              <img src={src} alt={o.caption || "Image"} loading="lazy" />
            </button>
          ) : (
            <span className="ib-missing">Image unavailable</span>
          )}
          {o.caption && (
            <p className="ib-text">
              <RichText text={o.caption} />
            </p>
          )}
        </>
      );
      break;
    }
    case "video": {
      const o = c.video || {};
      body = (
        <>
          <video className="ib-video" src={mediaUrl(o.link || o.url)} controls preload="metadata" />
          {o.caption && (
            <p className="ib-text">
              <RichText text={o.caption} />
            </p>
          )}
        </>
      );
      break;
    }
    case "audio":
      body = <Voice src={mediaUrl(c.audio?.link || c.audio?.url)} />;
      break;
    case "document": {
      const o = c.document || {};
      const name =
        o.filename ||
        String(o.link || "")
          .split("/")
          .pop() ||
        "Document";
      body = (
        <>
          <a
            className="ib-doc"
            href={mediaUrl(o.link || o.url)}
            target="_blank"
            rel="noreferrer"
            download={name}
          >
            <span className="ib-doc-ico">
              <FileText size={16} />
            </span>
            <span className="ib-doc-txt">
              <b>{name}</b>
              <small>{ext(name)}</small>
            </span>
            <Download size={15} className="ib-doc-dl" />
          </a>
          {o.caption && (
            <p className="ib-text">
              <RichText text={o.caption} />
            </p>
          )}
        </>
      );
      break;
    }
    case "location": {
      const o = c.location || {};
      const href = `https://maps.google.com/?q=${o.latitude},${o.longitude}`;
      body = (
        <a className="ib-loc" href={href} target="_blank" rel="noreferrer">
          <MapPin size={16} />
          <span>
            <b>{o.name || "Location"}</b>
            <small>{o.address || `${o.latitude}, ${o.longitude}`}</small>
          </span>
        </a>
      );
      break;
    }
    case "contacts": {
      const list = Array.isArray(c.contacts) ? c.contacts : [];
      body = (
        <span className="ib-contacts">
          {list.map((x, i) => (
            <span key={i} className="ib-loc">
              <User size={16} />
              <span>
                <b>{x.name?.formatted_name || x.name?.first_name || "Contact"}</b>
                <small>{(x.phones || []).map((p) => p.phone).join(", ")}</small>
              </span>
            </span>
          ))}
        </span>
      );
      break;
    }
    default: {
      const text = type === "text" ? c.text?.body : preview(m);
      body = (
        <p className="ib-text">
          <RichText text={text} />
        </p>
      );
    }
  }

  if (type === "reaction") {
    return (
      <div className={`ib-msg-row ${out ? "is-out" : ""}`}>
        <span className="ib-reaction-note">
          {out ? "You reacted" : "Reacted"} {c.reaction?.emoji}
        </span>
      </div>
    );
  }

  return (
    <div className={`ib-msg-row ${out ? "is-out" : ""}`}>
      <div className={`ib-bubble ${out ? "is-out" : ""} ${type === "audio" ? "is-voice" : ""}`}>
        {ctx && (ctx.msgContext || ctx.type) && (
          <span className="ib-quote">
            <b>{ctx.route === "OUTGOING" ? "You" : ctx.senderName || "Customer"}</b>
            <span>
              {preview(typeof ctx.msgContext === "string" ? { msgContext: safe(ctx.msgContext) } : ctx)}
            </span>
          </span>
        )}
        {body}
        <span className="ib-meta">
          {m.reaction ? <span className="ib-react">{m.reaction}</span> : null}
          {ms ? clock(ms) : ""}
          {out && <Ticks status={m.status} />}
        </span>
      </div>
      {onReply && m.metaChatId && (
        <button
          className="ib-reply-btn"
          onClick={() => onReply(m)}
          aria-label="Reply to this message"
          title="Reply"
        >
          <Reply size={14} />
        </button>
      )}
    </div>
  );
}

function safe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

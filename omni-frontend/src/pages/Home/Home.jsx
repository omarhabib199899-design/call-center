import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Zap,
  Users,
  Send,
  Plus,
  CalendarDays,
  ChevronDown,
  Bell,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  RefreshCw,
  ExternalLink,
  DollarSign,
  CheckCircle2,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import { api } from "../../api/session.js";
import { BRAND_PATHS } from "../../components/brand/brandPaths.js";
import "./Home.css";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

const CHANNELS = {
  whatsapp: { label: "WhatsApp", color: "#25D366", tint: "rgba(37,211,102,.12)" },
  telegram: { label: "Telegram", color: "#26A5E4", tint: "rgba(38,165,228,.12)" },
  instagram: { label: "Instagram", color: "#FF4F8B", tint: "rgba(255,79,139,.12)" },
  messenger: { label: "Messenger", color: "#00B2FF", tint: "rgba(0,178,255,.12)" },
};

const AVATAR_COLORS = ["#7C5CDB", "#2A8BC2", "#B25A73", "#3E8C6A", "#C08A2E", "#5A73D8"];

const nf = new Intl.NumberFormat("en-US");
const num = (v) => (v == null ? "—" : nf.format(v));

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening";
}

function ago(at) {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function Brand({ id, size = 16 }) {
  const fill = id === "instagram" ? "url(#hm-ig)" : CHANNELS[id]?.color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {id === "instagram" && (
        <defs>
          <radialGradient id="hm-ig" cx="0.3" cy="1.07" r="1.3">
            <stop offset="0.1" stopColor="#FFDD55" />
            <stop offset="0.5" stopColor="#FF543E" />
            <stop offset="1" stopColor="#C837AB" />
          </radialGradient>
        </defs>
      )}
      <path d={BRAND_PATHS[id]} fill={fill} />
    </svg>
  );
}

// Smooth path through points (Catmull-Rom -> cubic Bezier)
function smooth(pts) {
  if (!pts.length) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    // Clamp control points so the curve never dips below zero
    const lo = Math.min(p1[1], p2[1]);
    const hi = Math.max(p1[1], p2[1]);
    const cl = (v) => Math.min(hi, Math.max(lo, v));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, cl(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, cl(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// Group daily values so long ranges stay readable (90 days -> weekly)
function bucket(values, size) {
  if (size <= 1) return values;
  const out = [];
  for (let i = 0; i < values.length; i += size)
    out.push(values.slice(i, i + size).reduce((a, b) => a + b, 0));
  return out;
}

function Sparkline({ values, id }) {
  if (!values || values.length < 2) return null;
  const v = bucket(values, values.length > 30 ? 7 : values.length > 14 ? 3 : 1);
  const w = 80;
  const h = 22;
  const max = Math.max(...v, 1);
  const pts = v.map((y, i) => [(i / (v.length - 1)) * (w - 2) + 1, h - 2 - (y / max) * (h - 5)]);
  const line = smooth(pts);
  return (
    <svg className="hm-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2F4FC7" stopOpacity="0.28" />
          <stop offset="1" stopColor="#2F4FC7" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${pts.at(-1)[0]},${h} L${pts[0][0]},${h} Z`} fill={`url(#sp-${id})`} />
      <path d={line} fill="none" stroke="#2F4FC7" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : 10) * p;
}
const short = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : String(v));

function ActivityChart({ activity, days }) {
  const wrap = useRef(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = days > 30 ? 7 : 1;
  const inc = bucket(activity.incoming, size);
  const out = bucket(activity.outgoing, size);
  const start = new Date(`${activity.start}T00:00:00`);
  const labelOf = (i) => {
    const d = new Date(start.getTime() + i * size * 86400000);
    return days <= 7
      ? d.toLocaleDateString("en-US", { weekday: "short" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const h = 210;
  const pad = { l: 30, r: 8, t: 10, b: 24 };
  const max = niceMax(Math.max(...inc, ...out, 1));
  const n = inc.length;
  const x = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (w - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const pIn = inc.map((v, i) => [x(i), y(v)]);
  const pOut = out.map((v, i) => [x(i), y(v)]);
  const lineIn = smooth(pIn);
  const ticks = [0, 1, 2, 3].map((k) => (max / 3) * k);
  const every = Math.ceil(n / 7);

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - pad.l) / (w - pad.l - pad.r)) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div className="hm-chart" ref={wrap}>
      <svg
        width={w}
        height={h}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Incoming and outgoing messages per day"
      >
        <defs>
          <linearGradient id="hm-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2F4FC7" stopOpacity="0.18" />
            <stop offset="1" stopColor="#2F4FC7" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="#EEEEEE" />
            <text x={0} y={y(t) + 3} className="hm-axis">
              {short(Math.round(t))}
            </text>
          </g>
        ))}
        <path d={`${lineIn} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#hm-area)" />
        <path d={lineIn} fill="none" stroke="#2F4FC7" strokeWidth="2" />
        <path d={smooth(pOut)} fill="none" stroke="#D14D6C" strokeWidth="1.5" strokeDasharray="4 4" />
        {inc.map((_, i) =>
          (i % every === 0 && n - 1 - i >= every / 2) || i === n - 1 ? (
            <text
              key={i}
              x={x(i)}
              y={h - 6}
              textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
              className="hm-axis"
            >
              {labelOf(i)}
            </text>
          ) : null,
        )}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} stroke="#DADADA" />
            <circle cx={x(hover)} cy={y(inc[hover])} r="4" fill="#2F4FC7" stroke="#FFFFFF" strokeWidth="2" />
            <circle
              cx={x(hover)}
              cy={y(out[hover])}
              r="3.5"
              fill="#D14D6C"
              stroke="#FFFFFF"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="hm-tip" style={{ left: Math.min(x(hover) + 10, w - 150) }}>
          <b>{size > 1 ? `Week of ${labelOf(hover)}` : labelOf(hover)}</b>
          <span>
            <i style={{ background: "#2F4FC7" }} /> Incoming <em>{num(inc[hover])}</em>
          </span>
          <span>
            <i style={{ background: "#D14D6C" }} /> Outgoing <em>{num(out[hover])}</em>
          </span>
        </div>
      )}
      <div className="hm-legend">
        <span>
          <i style={{ background: "#2F4FC7" }} /> Incoming
        </span>
        <span>
          <i className="dash" /> Outgoing
        </span>
      </div>
    </div>
  );
}

function Delta({ kpi }) {
  if (!kpi || kpi.prev == null) return <span className="hm-delta-none">current</span>;
  if (!kpi.prev)
    return kpi.value ? (
      <span className="hm-delta up">new</span>
    ) : (
      <span className="hm-delta-none">no activity yet</span>
    );
  const pct = ((kpi.value - kpi.prev) / kpi.prev) * 100;
  const up = pct >= 0;
  return (
    <>
      <span className={`hm-delta ${up ? "up" : "down"}`}>
        {up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
        {Math.abs(pct) > 999 ? "999%+" : `${Math.abs(pct).toFixed(1)}%`}
      </span>
      <span className="hm-vs">vs. last period</span>
    </>
  );
}

function Kpi({ icon: Icon, label, kpi, days, foot, id, onClick, display }) {
  return (
    <article className={`hm-card hm-kpi ${onClick ? "is-link" : ""}`} onClick={onClick}>
      <div className="hm-kpi-top">
        <span className="hm-ico">
          <Icon size={17} />
        </span>
        <span className="hm-period">{days}D</span>
      </div>
      <div className="hm-kpi-label">{label}</div>
      <div className="hm-kpi-value">{kpi ? (display ? display(kpi) : num(kpi.value)) : "—"}</div>
      <div className="hm-kpi-foot">
        {foot ?? <Delta kpi={kpi} />}
        <Sparkline values={kpi?.series} id={id} />
      </div>
    </article>
  );
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Workflow runs per day for the last 7 days: successful vs failed bars
function AutomationChart({ perf }) {
  const [hover, setHover] = useState(null);
  const rows = perf?.last7 || [];
  const max = niceMax(Math.max(1, ...rows.map((r) => r.ok + r.fail)));
  const H = 190;
  return (
    <div className="hm-auto">
      <div className="hm-auto-plot" onMouseLeave={() => setHover(null)}>
        <div className="hm-auto-axis" aria-hidden>
          {[1, 0.66, 0.33, 0].map((f) => (
            <span key={f} style={{ bottom: `${f * 100}%` }}>
              {short(Math.round(max * f))}
            </span>
          ))}
        </div>
        <div className="hm-auto-bars" role="img" aria-label="Workflow executions by day">
          {[1, 0.66, 0.33, 0].map((f) => (
            <i key={f} className="hm-auto-grid" style={{ top: `${(1 - f) * H}px` }} />
          ))}
          {rows.map((r, i) => (
            <div key={r.d} className="hm-auto-col" onMouseEnter={() => setHover(i)}>
              <div className="hm-auto-stack" style={{ height: H }}>
                <span className="hm-auto-ok" style={{ height: `${(r.ok / max) * 100}%` }} />
                <span className="hm-auto-fail" style={{ height: `${(r.fail / max) * 100}%` }} />
              </div>
              <small>{WD[new Date(r.d + "T00:00:00").getDay()]}</small>
              {hover === i && (
                <div className="hm-tip hm-tip--bar">
                  <b>
                    {new Date(r.d + "T00:00:00").toLocaleDateString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </b>
                  <span>
                    <i style={{ background: "#2F4FC7" }} /> Successful <em>{num(r.ok)}</em>
                  </span>
                  <span>
                    <i style={{ background: "#D14D6C" }} /> Failed <em>{num(r.fail)}</em>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="hm-legend">
        <span>
          <i style={{ background: "#2F4FC7" }} /> Successful
        </span>
        <span>
          <i style={{ background: "#D14D6C" }} /> Failed
        </span>
      </div>
    </div>
  );
}

function money(v, cur) {
  const n = Number(v || 0);
  const s = n >= 100000 ? nf.format(Math.round(n)) : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${cur || ""} ${s}`.trim();
}

const RECENT_KIND = {
  sale: { icon: DollarSign, title: () => "Sale completed", bg: "rgba(31,157,106,.12)", color: "#1F9D6A" },
  resolved: { icon: CheckCircle2, title: () => "Conversation resolved", bg: "#EFF2FB", color: "#3355CC" },
  reopened: { icon: RotateCcw, title: () => "Conversation reopened", bg: "#FBF4DC", color: "#B8860B" },
  automation_failed: {
    icon: AlertTriangle,
    title: () => "Automation failed",
    bg: "#FDEEEE",
    color: "#D14D6C",
  },
};

function SectionHead({ title, link, onLink }) {
  return (
    <div className="hm-sec-head">
      <h2>{title}</h2>
      {link && (
        <button className="hm-link" onClick={onLink}>
          {link} <ArrowRight size={12} />
        </button>
      )}
    </div>
  );
}

export default function Home({ role, user, onNavigate, badges }) {
  const [days, setDays] = useState(() => {
    try {
      return Number(localStorage.getItem("omni.home.days")) || 30;
    } catch {
      return 30;
    }
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api(`/api/dashboard/overview?days=${days}`, role);
      if (!res?.success) throw new Error(res?.msg || "Could not load the dashboard");
      setData(res.data);
      setError("");
    } catch (e) {
      if (e.signedOut) location.href = "/user/login";
      setError(e.message || "Could not load the dashboard");
    } finally {
      setLoading(false);
    }
  }, [days, role]);

  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem("omni.home.days", String(days));
    } catch {}
  }, [days]);

  useEffect(() => {
    if (!rangeOpen) return;
    const close = () => setRangeOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [rangeOpen]);

  const k = data?.kpis || {};
  const go = (id) => onNavigate?.(id);
  const first = String(user?.name || "").split(/\s+/)[0];
  const act = data?.activity;
  const team = data?.team || [];

  return (
    <main className="hm-page">
      <div className="hm-inner">
        <header className="hm-head">
          <div>
            <p className="hm-over">Workspace overview</p>
            <h1>
              {greeting()}
              {first && first !== "…" ? `, ${first}` : ""}
            </h1>
            <p className="hm-sub">Here's what's happening across your workspace.</p>
          </div>
          <div className="hm-actions">
            <button className="hm-btn-gold" onClick={() => go("agent-accounts")}>
              Agent Management <Plus size={18} />
            </button>
            <div className="hm-range" onClick={(e) => e.stopPropagation()}>
              <button
                className="hm-btn-dark"
                onClick={() => setRangeOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={rangeOpen}
              >
                <CalendarDays size={15} /> {RANGES.find((r) => r.days === days)?.label}{" "}
                <ChevronDown size={14} />
              </button>
              {rangeOpen && (
                <ul className="hm-menu" role="listbox">
                  {RANGES.map((r) => (
                    <li key={r.days}>
                      <button
                        className={r.days === days ? "is-on" : ""}
                        onClick={() => {
                          setDays(r.days);
                          setRangeOpen(false);
                        }}
                      >
                        {r.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              className="hm-btn-dark hm-bell"
              onClick={() => go("web-notifications")}
              aria-label="Notifications"
            >
              <Bell size={18} />
              {badges?.channels > 0 && <i />}
            </button>
          </div>
        </header>

        {error && (
          <div className="hm-error">
            {error}
            <button onClick={load}>
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        <div className={`hm-grid ${loading && !data ? "is-loading" : ""}`}>
          <div className="hm-kpis">
            <Kpi
              id="conv"
              icon={MessageSquare}
              label="Total Conversations"
              kpi={k.conversations}
              days={days}
              onClick={() => go("inbox")}
            />
            <Kpi
              id="auto"
              icon={Zap}
              label="Active Automations"
              kpi={k.automations}
              days={days}
              foot={k.automations && <span className="hm-vs">of {num(k.automations.total)} chatbots</span>}
              onClick={() => go("chatbots")}
            />
            <Kpi
              id="team"
              icon={Users}
              label="Active Team Members"
              kpi={k.team}
              days={days}
              foot={k.team && <span className="hm-vs">of {num(k.team.total)} agents</span>}
              onClick={() => go("agents")}
            />
            <Kpi
              id="sales"
              icon={DollarSign}
              label="Total Sales"
              kpi={k.sales}
              days={days}
              display={(x) => money(x.value, x.currency)}
              foot={
                k.sales && !k.sales.value && !k.sales.prev ? (
                  <span className="hm-vs">Record sales from a conversation in Inbox</span>
                ) : undefined
              }
              onClick={() => go("inbox")}
            />
          </div>

          <section className="hm-card hm-channels">
            <SectionHead
              title="Connected Channels"
              link="Manage channels"
              onLink={() => go("wa-qr-connect")}
            />
            <div className="hm-ch-row">
              {(data?.channels || Object.keys(CHANNELS).map((id) => ({ id }))).map((c) => {
                const on = c.accounts > 0;
                return (
                  <div key={c.id} className="hm-ch">
                    <span
                      className="hm-ch-logo"
                      style={{ background: CHANNELS[c.id].tint, borderColor: `${CHANNELS[c.id].color}55` }}
                    >
                      <Brand id={c.id} size={18} />
                    </span>
                    <span className="hm-ch-name">
                      <b>{CHANNELS[c.id].label}</b>
                      <small className={on ? (c.online ? "ok" : "warn") : ""}>
                        <i /> {on ? (c.online ? "Connected" : "Offline") : "Not connected"}
                      </small>
                    </span>
                    <span
                      className="hm-ch-num"
                      title={
                        !on && c.conversations
                          ? "Chats from an account that is no longer connected"
                          : undefined
                      }
                    >
                      <b className={!on ? "muted" : ""}>
                        {on || c.conversations ? num(c.conversations) : "—"}
                      </b>
                      <small>conversations</small>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="hm-card hm-activity">
            <SectionHead title="Automation Performance" link="View workflows" onLink={() => go("flows")} />
            {data?.automationPerf ? (
              <div className="hm-act-body">
                <AutomationChart perf={data.automationPerf} />
                <div className="hm-stats">
                  <div>
                    <small>Active workflows</small>
                    <b>{k.automations ? num(k.automations.value) : "—"}</b>
                  </div>
                  <div>
                    <small>Executions</small>
                    <b>{num(data.automationPerf.ok + data.automationPerf.fail)}</b>
                  </div>
                  <div>
                    <small>Failed</small>
                    <b className="pink">{num(data.automationPerf.fail)}</b>
                  </div>
                  <div className="hm-rate">
                    <small>Success rate</small>
                    {(() => {
                      const runs = data.automationPerf.ok + data.automationPerf.fail;
                      const rate = runs ? data.automationPerf.ok / runs : null;
                      return (
                        <>
                          <b>{rate == null ? "—" : `${(rate * 100).toFixed(1)}%`}</b>
                          <span className="hm-bar green">
                            <i style={{ width: `${(rate || 0) * 100}%` }} />
                          </span>
                          <em>
                            {runs
                              ? `Each time a workflow handled an incoming message, last ${days} days`
                              : "No workflow runs recorded yet in this period"}
                          </em>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : (
              <div className="hm-empty">{loading ? "Loading…" : "No workflow data yet."}</div>
            )}
          </section>

          <section className="hm-card hm-recent">
            <SectionHead title="Recent Activity" />
            <ul>
              {(data?.recent || []).map((r, i) => {
                const K = RECENT_KIND[r.kind];
                const Icon = K?.icon;
                return (
                  <li key={`${r.kind}-${r.chat_id || r.name}-${i}`}>
                    <button
                      onClick={() => {
                        if (r.chat_id && r.kind !== "automation_failed") {
                          try {
                            sessionStorage.setItem("omni.inbox.open", r.chat_id);
                          } catch {}
                          go("inbox");
                        } else go("flows");
                      }}
                    >
                      {K ? (
                        <span className="hm-r-ico" style={{ background: K.bg, color: K.color }}>
                          <Icon size={14} />
                        </span>
                      ) : (
                        <span className="hm-r-ico" style={{ background: CHANNELS[r.channel]?.tint }}>
                          <Brand id={r.channel} size={15} />
                        </span>
                      )}
                      <span className="hm-r-text">
                        <b>
                          {K
                            ? K.title(r)
                            : r.unread
                              ? `New ${CHANNELS[r.channel]?.label} conversation`
                              : `${CHANNELS[r.channel]?.label} conversation`}
                          {!K && r.unread > 0 && <em>{r.unread}</em>}
                        </b>
                        <small>
                          {K
                            ? `${r.name ? `${r.name} · ` : ""}${r.text || ""}`
                            : `${r.name || r.mobile}${r.text ? ` · ${r.text}` : ""}`}
                        </small>
                      </span>
                      <time>{ago(r.at)}</time>
                    </button>
                  </li>
                );
              })}
              {data && !data.recent?.length && <li className="hm-empty">No activity yet.</li>}
            </ul>
            <button className="hm-link hm-all" onClick={() => go("inbox")}>
              View all activity
            </button>
          </section>

          <section className="hm-card hm-team">
            <SectionHead title="Team Performance" link="View team" onLink={() => go("agents")} />
            <div className="hm-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Conversations handled</th>
                    <th>Sales generated</th>
                    <th>Target achievement</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((t, i) => (
                    <tr key={t.uid}>
                      <td>
                        <span
                          className="hm-av"
                          style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
                        >
                          {initials(t.name)}
                        </span>
                        <span className="hm-emp">
                          <b>{t.name}</b>
                          <small>{t.email}</small>
                        </span>
                      </td>
                      <td>
                        {num(t.conversations)}
                        {t.waiting > 0 && <small className="hm-wait"> · {num(t.waiting)} waiting</small>}
                      </td>
                      <td>
                        {t.sales ? money(t.sales, k.sales?.currency) : <span className="hm-dim">—</span>}
                      </td>
                      <td>
                        {t.target ? (
                          <>
                            <span className={`hm-bar ${t.achievement >= 1 ? "green" : ""}`}>
                              <i style={{ width: `${Math.min(1, t.achievement || 0) * 100}%` }} />
                            </span>
                            <span className="hm-pct">{Math.round((t.achievement || 0) * 100)}%</span>
                          </>
                        ) : (
                          <button
                            className="hm-set-target"
                            onClick={() => go("agent-accounts")}
                            title="Set a monthly sales target in Agents & Channels → Edit details"
                          >
                            Set target
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data && !team.length && (
                    <tr>
                      <td colSpan={4} className="hm-empty">
                        No active agents yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer className="hm-foot">
          {data?.generatedAt && (
            <span>
              Updated{" "}
              {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <a href="/user?page=dashboard" target="_blank" rel="noreferrer">
            Classic dashboard <ExternalLink size={11} />
          </a>
        </footer>
      </div>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Layers,
  Loader,
  Megaphone,
  RefreshCw,
  Search,
  Star,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { api } from "../../api/session.js";
import { BRAND_PATHS } from "../../components/brand/brandPaths.js";
import "./LeadSources.css";

const PLAT = {
  instagram: { label: "Instagram", color: "#8B63D6", logo: "instagram", fill: "url(#ls-ig)" },
  facebook: { label: "Facebook", color: "#3975EA", logo: "facebook", fill: "#0866FF" },
  tiktok: { label: "TikTok", color: "#E85A7C", logo: "tiktok", fill: "var(--ls-tiktok, #111827)" },
  whatsapp: { label: "WhatsApp", color: "#26A86A", logo: "whatsapp", fill: "#25D366" },
  other: { label: "Other", color: "#738199", logo: null, fill: "#58657B" },
};
const PRESETS = [
  { id: 7, label: "Last 7 days" },
  { id: 30, label: "Last 30 days" },
  { id: 90, label: "Last 90 days" },
];

const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const iso = (d) => d.toISOString().slice(0, 10);
const dayMs = 86400000;
function presetRange(days) {
  const to = new Date();
  return { from: iso(new Date(+to - (days - 1) * dayMs)), to: iso(to), preset: days };
}
function nice(dateStr, withYear) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
function when(t) {
  const d = new Date(t);
  if (isNaN(d)) return { day: "—", time: "" };
  return {
    day: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
  };
}

export function PlatformIcon({ p, size = 20 }) {
  const m = PLAT[p] || PLAT.other;
  return (
    <span className={`ls-pi ls-pi--${p}`} style={{ width: size, height: size }} aria-hidden>
      {m.logo ? (
        <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24">
          {p === "instagram" && (
            <defs>
              <radialGradient id="ls-ig" cx="0.3" cy="1.07" r="1.3">
                <stop offset="0.1" stopColor="#FFDD55" />
                <stop offset="0.5" stopColor="#FF543E" />
                <stop offset="1" stopColor="#C837AB" />
              </radialGradient>
            </defs>
          )}
          <path d={BRAND_PATHS[m.logo]} style={{ fill: m.fill }} />
        </svg>
      ) : (
        <Layers size={size * 0.6} />
      )}
    </span>
  );
}

function Delta({ v, flat = "0%" }) {
  if (v == null) return <span className="ls-delta is-new">New</span>;
  if (Math.abs(v) < 0.05) return <span className="ls-delta">{flat}</span>;
  const up = v > 0;
  return (
    <span className={`ls-delta ${up ? "is-up" : "is-down"}`}>
      {up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
      {Math.abs(v).toFixed(1)}%
    </span>
  );
}

function useOutside(ref, on, cb) {
  useEffect(() => {
    if (!on) return;
    const h = (e) => ref.current && !ref.current.contains(e.target) && cb();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [on, cb, ref]);
}

function RangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const ref = useRef(null);
  useOutside(ref, open, () => setOpen(false));
  useEffect(() => {
    setFrom(value.from);
    setTo(value.to);
  }, [value.from, value.to]);
  const sameYear = value.from.slice(0, 4) === value.to.slice(0, 4);
  return (
    <div className="ls-pop" ref={ref}>
      <button
        className="ls-ctl"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Calendar size={16} />
        <span>
          {nice(value.from, !sameYear)} – {nice(value.to, true)}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="ls-menu ls-menu--range" role="dialog" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={value.preset === p.id ? "is-on" : ""}
              onClick={() => {
                onChange(presetRange(p.id));
                setOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
          <div className="ls-custom">
            <span>Custom range</span>
            <label>
              From
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To
              <input
                type="date"
                value={to}
                min={from}
                max={iso(new Date())}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <button
              className="ls-btn ls-btn--primary ls-btn--sm"
              disabled={!from || !to}
              onClick={() => {
                onChange({ from, to, preset: null });
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlatformSelect({ value, onChange, small }) {
  return (
    <label className={`ls-ctl ls-select ${small ? "ls-ctl--sm" : ""}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Platform">
        <option value="">All platforms</option>
        {Object.entries(PLAT).map(([k, m]) => (
          <option key={k} value={k}>
            {m.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}

function CustomersDrawer({ role, ad, range, onClose, onOpenChat }) {
  const [page, setPage] = useState(1);
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setD(null);
    api(
      `/api/omni_leads/customers?source_id=${encodeURIComponent(ad.source_id ?? "")}&from=${range.from}&to=${range.to}&page=${page}`,
      role,
    )
      .then((r) => live && (r?.success ? setD(r.data) : setErr(r?.msg || "Could not load")))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [role, ad.source_id, range.from, range.to, page]);
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const pages = d ? Math.max(1, Math.ceil(d.total / d.size)) : 1;
  return (
    <div className="ls-drawer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="ls-drawer" role="dialog" aria-modal="true" aria-label="Customers from this ad">
        <div className="ls-drawer-head">
          <PlatformIcon p={ad.platform} size={32} />
          <div>
            <h3>{ad.title || "Untitled ad"}</h3>
            <p>
              {PLAT[ad.platform]?.label} · {ad.source_id ? `ID ${ad.source_id}` : "No ad ID"} ·{" "}
              {fmt(ad.leads)} customers
            </p>
          </div>
          <button className="ls-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {ad.url && (
          <a className="ls-adlink" href={ad.url} target="_blank" rel="noreferrer">
            Open the ad <ExternalLink size={13} />
          </a>
        )}
        <div className="ls-drawer-body">
          {err && <div className="ls-err">{err}</div>}
          {!d ? (
            <p className="ls-muted">
              <Loader size={14} className="ls-spin" /> Loading customers…
            </p>
          ) : !d.rows.length ? (
            <p className="ls-muted">No customers in this period.</p>
          ) : (
            <ul className="ls-cust">
              {d.rows.map((c) => {
                const w = when(c.createdAt);
                return (
                  <li key={`${c.chat_id}-${c.createdAt}`}>
                    <span className="ls-av">
                      {String(c.sender_name || "?")
                        .trim()
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    <span className="ls-cust-who">
                      <b>{c.sender_name || c.sender_mobile || "Unknown"}</b>
                      <small>{c.sender_mobile}</small>
                    </span>
                    <span className="ls-cust-when">
                      {w.day}
                      <small>{w.time}</small>
                    </span>
                    <button className="ls-btn ls-btn--sm" onClick={() => onOpenChat(c)}>
                      Open chat
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {d && d.total > d.size && (
          <div className="ls-drawer-foot">
            <span className="ls-muted-sm">
              {(page - 1) * d.size + 1}–{Math.min(d.total, page * d.size)} of {fmt(d.total)}
            </span>
            <button className="ls-btn ls-btn--sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={14} /> Previous
            </button>
            <button className="ls-btn ls-btn--sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

export default function LeadSources({ role, onNavigate }) {
  const [range, setRange] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("omni.leads.days"));
      if (PRESETS.some((p) => p.id === saved)) return presetRange(saved);
    } catch {}
    return presetRange(30);
  });
  const [platform, setPlatform] = useState("");
  const [ov, setOv] = useState(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [tPlatform, setTPlatform] = useState("");
  const [page, setPage] = useState(1);
  const [ads, setAds] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef(null);
  const SIZE = 6;

  const qs = `from=${range.from}&to=${range.to}`;

  const loadOv = useCallback(async () => {
    setErr("");
    try {
      const r = await api(`/api/omni_leads/overview?${qs}&platform=${platform}`, role);
      if (r?.missing) return setMissing(true);
      if (!r?.success) throw new Error(r?.msg || "Could not load");
      setOv(r.data);
    } catch (e) {
      if (e.signedOut) location.href = "/user/login";
      setErr(e.message);
    }
  }, [qs, platform, role]);

  useEffect(() => {
    loadOv();
  }, [loadOv]);

  useEffect(() => {
    try {
      if (range.preset) localStorage.setItem("omni.leads.days", String(range.preset));
    } catch {}
  }, [range.preset]);

  const effPlatform = tPlatform || platform;
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await api(
          `/api/omni_leads/ads?${qs}&platform=${effPlatform}&q=${encodeURIComponent(q.trim())}&page=${page}&size=${SIZE}`,
          role,
        );
        if (live && r?.success && r.data) setAds(r.data);
      } catch {}
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [qs, effPlatform, q, page, role]);

  useEffect(() => setPage(1), [qs, effPlatform, q]);

  // ⌘K / Ctrl+K focuses the ad search
  useEffect(() => {
    const h = (e) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "k" &&
        document.activeElement !== searchRef.current
      ) {
        if (!searchRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        searchRef.current.focus();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await api(
        `/api/omni_leads/ads?${qs}&platform=${effPlatform}&q=${encodeURIComponent(q.trim())}&all=1`,
        role,
      );
      const rows = r?.data?.rows || [];
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [
        [
          "Advertisement",
          "Platform",
          "Ad ID",
          "Customers",
          "Conversion share %",
          "Last customer",
          "Status",
          "Link",
        ]
          .map(esc)
          .join(","),
        ...rows.map((a) =>
          [
            a.title || "Untitled ad",
            PLAT[a.platform]?.label,
            a.source_id,
            a.leads,
            a.share.toFixed(1),
            new Date(a.last_at).toISOString(),
            a.active ? "Active" : "No recent leads",
            a.url,
          ]
            .map(esc)
            .join(","),
        ),
      ];
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `lead-sources_${range.from}_${range.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } finally {
      setExporting(false);
    }
  };

  const openChat = (c) => {
    try {
      sessionStorage.setItem("omni.inbox.open", c.chat_id);
    } catch {}
    onNavigate?.("inbox");
  };

  if (missing) {
    return (
      <main className="ls-page">
        <div className="ls-inner">
          <header className="ls-head">
            <div>
              <h1>Lead Sources</h1>
              <p>
                Track incoming customers, advertising performance, and lead sources across every connected
                platform.
              </p>
            </div>
          </header>
          <div className="ls-card ls-empty">
            <Megaphone size={28} />
            <b>Ad tracking isn’t set up on this server yet</b>
            <p>Run database/chat_ad_source.sql once, then customers who arrive from ads will appear here.</p>
          </div>
        </div>
      </main>
    );
  }

  const platsShown = ov ? ov.platforms.filter((p) => p.leads > 0 || p.platform !== "other") : [];
  const pages = ads ? Math.max(1, Math.ceil(ads.total / ads.size)) : 1;
  const nPlat = ov ? ov.platforms.filter((p) => p.ads > 0).length : 0;

  return (
    <main className="ls-page">
      <div className="ls-inner">
        <header className="ls-head">
          <div>
            <div className="ls-title">
              <h1>Lead Sources</h1>
              <span className="ls-live">
                <i /> Live tracking
              </span>
            </div>
            <p>
              Track incoming customers, advertising performance, and lead sources across every connected
              platform.
            </p>
          </div>
          <div className="ls-controls">
            <RangePicker value={range} onChange={setRange} />
            <PlatformSelect value={platform} onChange={setPlatform} />
            <button className="ls-ctl ls-ctl--icon" onClick={loadOv} aria-label="Refresh" title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button
              className="ls-btn ls-btn--primary"
              onClick={exportCsv}
              disabled={exporting || !ads?.total}
            >
              {exporting ? <Loader size={15} className="ls-spin" /> : <Download size={15} />} Export CSV
            </button>
          </div>
        </header>

        {err && (
          <div className="ls-err">
            {err}
            <button onClick={loadOv}>
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        <section className="ls-kpis" aria-label="Lead source overview">
          <article className="ls-card ls-kpi">
            <div className="ls-kpi-top">
              <span className="ls-ico">
                <Users size={16} />
              </span>
              {ov && <Delta v={ov.leadsDelta} />}
            </div>
            <span className="ls-kpi-label">Total Ad Leads</span>
            <b className="ls-kpi-val">{ov ? fmt(ov.leads) : "—"}</b>
            <small>{ov ? `vs. ${fmt(ov.prevLeads)} previous period` : " "}</small>
          </article>
          <article className="ls-card ls-kpi">
            <div className="ls-kpi-top">
              <span className="ls-ico">
                <Megaphone size={16} />
              </span>
              {ov && <span className="ls-chip">{ov.adsDelta >= 0 ? `+${ov.adsDelta}` : ov.adsDelta}</span>}
            </div>
            <span className="ls-kpi-label">Total Advertisements</span>
            <b className="ls-kpi-val">{ov ? fmt(ov.ads) : "—"}</b>
            <small>
              {ov
                ? `${fmt(ov.activeAds)} active · ${fmt(Math.max(0, ov.ads - ov.activeAds))} no recent leads`
                : " "}
            </small>
          </article>
          <article className="ls-card ls-kpi">
            <div className="ls-kpi-top">
              <span className="ls-ico">
                <TrendingUp size={16} />
              </span>
              {ov && (
                <span className={`ls-delta ${ov.activePlatforms ? "is-up" : ""}`}>
                  {ov.activePlatforms ? "Receiving leads" : "Quiet"}
                </span>
              )}
            </div>
            <span className="ls-kpi-label">Active Platforms</span>
            <b className="ls-kpi-val">{ov ? ov.activePlatforms : "—"}</b>
            <small>Brought customers in the last 7 days</small>
          </article>
          <article className="ls-card ls-kpi">
            <div className="ls-kpi-top">
              <span className="ls-ico ls-ico--gold">
                <Star size={16} />
              </span>
              {ov?.best && <span className="ls-delta is-up">Top {ov.best.share.toFixed(1)}%</span>}
            </div>
            <span className="ls-kpi-label">Best Performing Ad</span>
            <b className="ls-kpi-best" title={ov?.best?.title || ""}>
              {ov?.best ? ov.best.title || "Untitled ad" : "—"}
            </b>
            <small className="ls-dark">
              {ov?.best ? `${fmt(ov.best.leads)} customers generated` : "No ad leads in this period"}
            </small>
          </article>
        </section>

        <section className="ls-card ls-sec">
          <div className="ls-sec-head">
            <div>
              <h2>Advertising sources</h2>
              <p>Customer contribution by platform</p>
            </div>
            <span className="ls-total">
              Total tracked leads <b>{ov ? fmt(ov.leads) : "—"}</b>
            </span>
          </div>
          <div className="ls-plats">
            {(ov ? platsShown : Object.keys(PLAT).map((p) => ({ platform: p }))).map((p) => (
              <button
                key={p.platform}
                className={`ls-plat ${tPlatform === p.platform ? "is-on" : ""}`}
                onClick={() => setTPlatform((t) => (t === p.platform ? "" : p.platform))}
                aria-pressed={tPlatform === p.platform}
                title={`Show ${PLAT[p.platform].label} ads in the table`}
              >
                <span className="ls-plat-top">
                  <PlatformIcon p={p.platform} />
                  <span>{PLAT[p.platform].label}</span>
                  {ov && <Delta v={p.delta} />}
                </span>
                <span className="ls-plat-num">
                  <b>{ov ? fmt(p.leads) : "—"}</b>
                  <span>{ov ? `${Math.round(p.share)}%` : ""}</span>
                </span>
                <span className="ls-bar">
                  <i
                    style={{
                      width: `${ov ? Math.max(p.leads ? 2 : 0, p.share) : 0}%`,
                      background: PLAT[p.platform].color,
                    }}
                  />
                </span>
                <small>
                  {ov ? `${fmt(p.ads)} ${p.ads === 1 ? "advertisement" : "advertisements"}` : " "}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="ls-card ls-table-card">
          <div className="ls-table-head">
            <div>
              <h2>Advertisement performance</h2>
              <p>
                {ads
                  ? `${fmt(ads.total)} tracked ${ads.total === 1 ? "advertisement" : "advertisements"}`
                  : "Loading…"}
                {ov && !effPlatform
                  ? ` across ${nPlat} ${nPlat === 1 ? "platform" : "platforms"}`
                  : effPlatform
                    ? ` on ${PLAT[effPlatform].label}`
                    : ""}
              </p>
            </div>
            <div className="ls-table-tools">
              <label className="ls-ctl ls-search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search advertisements…"
                />
                {q ? (
                  <button onClick={() => setQ("")} aria-label="Clear search">
                    <X size={13} />
                  </button>
                ) : (
                  <kbd>⌘ K</kbd>
                )}
              </label>
              <PlatformSelect value={tPlatform} onChange={setTPlatform} small />
            </div>
          </div>
          <div className="ls-table-wrap">
            <table className="ls-table">
              <thead>
                <tr>
                  <th>Advertisement</th>
                  <th>Platform</th>
                  <th>Ad ID</th>
                  <th className="num">Customers</th>
                  <th>Conversion share</th>
                  <th>Last customer</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {!ads ? (
                  <tr>
                    <td colSpan={8} className="ls-td-empty">
                      <Loader size={14} className="ls-spin" /> Loading…
                    </td>
                  </tr>
                ) : !ads.rows.length ? (
                  <tr>
                    <td colSpan={8} className="ls-td-empty">
                      {q || effPlatform
                        ? "No advertisements match."
                        : "No customers came from ads in this period."}
                    </td>
                  </tr>
                ) : (
                  ads.rows.map((a) => {
                    const w = when(a.last_at);
                    return (
                      <tr key={`${a.source_id}-${a.platform}`} onClick={() => setOpen(a)}>
                        <td>
                          <span className="ls-ad">
                            <PlatformIcon p={a.platform} size={28} />
                            <span>
                              <b>{a.title || "Untitled ad"}</b>
                              <small>
                                {a.body ||
                                  (a.type === "post"
                                    ? "Post"
                                    : a.url
                                      ? new URL(a.url, location.origin).hostname.replace(/^www\./, "")
                                      : "—")}
                              </small>
                            </span>
                          </span>
                        </td>
                        <td>{PLAT[a.platform]?.label}</td>
                        <td className="ls-mono">{a.source_id || "—"}</td>
                        <td className="num">
                          <b>{fmt(a.leads)}</b>
                        </td>
                        <td>
                          <span className="ls-share">
                            <span className="ls-bar ls-bar--sm">
                              <i
                                style={{
                                  width: `${Math.max(2, a.share)}%`,
                                  background: PLAT[a.platform]?.color,
                                }}
                              />
                            </span>
                            {a.share.toFixed(1)}%
                          </span>
                        </td>
                        <td>
                          <span className="ls-when">
                            {w.day}
                            <small>{w.time}</small>
                          </span>
                        </td>
                        <td>
                          <span className={`ls-status ${a.active ? "is-on" : ""}`}>
                            <i /> {a.active ? "Active" : "No recent leads"}
                          </span>
                        </td>
                        <td className="ls-td-act">
                          <button
                            className="ls-btn ls-btn--sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpen(a);
                            }}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {ads && ads.total > 0 && (
            <div className="ls-table-foot">
              <span>
                Showing {(page - 1) * ads.size + 1}–{Math.min(ads.total, page * ads.size)} of {fmt(ads.total)}{" "}
                results
              </span>
              <div className="ls-pager">
                <button className="ls-btn ls-btn--sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <ChevronLeft size={14} /> Previous
                </button>
                {Array.from({ length: pages }, (_, i) => i + 1)
                  .filter((p) => pages <= 7 || Math.abs(p - page) <= 2 || p === 1 || p === pages)
                  .map((p, i, arr) => (
                    <span key={p} className="ls-pg-wrap">
                      {i > 0 && p - arr[i - 1] > 1 && <span className="ls-muted-sm">…</span>}
                      <button
                        className={`ls-pg ${p === page ? "is-on" : ""}`}
                        onClick={() => setPage(p)}
                        aria-current={p === page ? "page" : undefined}
                      >
                        {p}
                      </button>
                    </span>
                  ))}
                <button
                  className="ls-btn ls-btn--sm"
                  disabled={page >= pages}
                  onClick={() => setPage(page + 1)}
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </section>

        <footer className="ls-foot">
          Counts each customer once per ad. An ad is “Active” while it brought a customer in the last 7 days.{" "}
          <a href="/ad-sources.html" target="_blank" rel="noreferrer">
            Classic report <ExternalLink size={11} />
          </a>
        </footer>
      </div>

      {open && (
        <CustomersDrawer
          role={role}
          ad={open}
          range={range}
          onClose={() => setOpen(null)}
          onOpenChat={openChat}
        />
      )}
    </main>
  );
}

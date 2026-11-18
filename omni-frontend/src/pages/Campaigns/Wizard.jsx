import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check as CheckIcon,
  Clock,
  Search,
  X,
  Sparkles,
  TriangleAlert,
  Pencil,
  CalendarDays,
  Info,
  Loader,
  ChevronDown,
} from "lucide-react";
import {
  TYPES,
  typeOf,
  CHANNEL_TABS,
  tabOfChannel,
  tabOfKey,
  fmtRange,
  fmtDay,
  daysBetween,
  todayStr,
  previewStatus,
  loadOptions,
  saveCampaign,
} from "./meta.js";
import { Logo, StatusPill, Avatar, Check } from "./bits.jsx";

const STEPS = ["Details", "Accounts", "Agents", "Review"];
const STEP_TEXT = ["Campaign details", "Accounts & channels", "Agents", "Review & create"];
const SUBTITLE = [
  "Set up the basics. You can change these later.",
  "Choose the accounts that are part of this campaign.",
  "Choose who will handle this campaign's conversations.",
  "Check everything once. You can still edit after creating.",
];

function Stepper({ step, done, onGo }) {
  return (
    <ol className="cmp-stepper">
      {STEPS.map((s, i) => {
        const state = i === step ? "is-current" : done[i] ? "is-done" : "";
        return (
          <li key={s} className={state}>
            <button onClick={() => onGo(i)} disabled={i > step && !done.slice(0, i).every(Boolean)}>
              <span>{done[i] && i !== step ? <CheckIcon size={13} strokeWidth={3} /> : i + 1}</span>
              {s}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function SectionHead({ n, title, sub, right }) {
  return (
    <div className="cmp-sec">
      <span className="cmp-sec-n">{String(n).padStart(2, "0")}</span>
      <div>
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      {right}
    </div>
  );
}

function Summary({ form, accounts, onRemove, onClear }) {
  const status = previewStatus(form.start_date, form.end_date, false);
  const groups = CHANNEL_TABS.map((t) => ({
    ...t,
    keys: form.accounts.filter((k) => tabOfKey(k) === t.id),
  })).filter((g) => g.keys.length);
  return (
    <aside className="cmp-panel">
      <div className="cmp-panel-head">
        <h4>Campaign summary</h4>
        <StatusPill status={status === "completed" ? "completed" : status} />
      </div>
      <div className="cmp-sum">
        <small>Name</small>
        <b>{form.name || <span className="cmp-muted">Not named yet</span>}</b>
      </div>
      <div className="cmp-sum">
        <small>Type</small>
        <b>{typeOf(form.type).label}</b>
      </div>
      <div className="cmp-sum">
        <small>Dates</small>
        <b>
          {form.start_date && form.end_date ? (
            `${fmtRange(form.start_date, form.end_date)} · ${daysBetween(form.start_date, form.end_date) + 1} days`
          ) : (
            <span className="cmp-muted">Not set</span>
          )}
        </b>
      </div>
      <div className="cmp-sum">
        <small>Accounts &amp; channels</small>
        {groups.length ? (
          <>
            {groups.map((g) => (
              <div key={g.id} className="cmp-sum-group">
                <span className="cmp-dl-head">
                  <Logo tab={g.id} /> {g.label} <em>{g.keys.length}</em>
                </span>
                <span className="cmp-chips">
                  {g.keys.map((k) => (
                    <span key={k} className="cmp-chip">
                      {accounts.get(k)?.name || k}
                      {onRemove && (
                        <button
                          onClick={() => onRemove(k)}
                          aria-label={`Remove ${accounts.get(k)?.name || k}`}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            <div className="cmp-sum-foot">
              <span>{form.accounts.length} accounts selected</span>
              {onClear && <button onClick={onClear}>Clear all</button>}
            </div>
          </>
        ) : (
          <span className="cmp-pending">
            <Clock size={13} /> Chosen in the next step
          </span>
        )}
      </div>
      <div className="cmp-sum">
        <small>Agents</small>
        <span className="cmp-pending">
          <Clock size={13} /> Chosen after accounts
        </span>
      </div>
    </aside>
  );
}

export default function Wizard({ role, initial, onClose, onSaved, onNavigate }) {
  const editing = !!initial?.id;
  const wasLive = editing && initial.status !== "draft";
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(() => ({
    id: initial?.id || 0,
    name: initial?.name || "",
    type: initial?.type || "white_friday",
    description: initial?.description || "",
    start_date: initial?.start_date || "",
    end_date: initial?.end_date || "",
    accounts: initial?.accounts || [],
    agents: initial?.agents || [],
  }));
  const [opts, setOpts] = useState(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  // step 2 / 3 local UI
  const [tab, setTab] = useState("whatsapp");
  const [accQ, setAccQ] = useState("");
  const [accFilter, setAccFilter] = useState("all");
  const [agentTab, setAgentTab] = useState("suggested");
  const [agentQ, setAgentQ] = useState("");
  const [beforeSuggest, setBeforeSuggest] = useState(null);

  useEffect(() => {
    loadOptions(role, form.id)
      .then((o) => {
        setOpts(o);
        const first = CHANNEL_TABS.find((t) => o.accounts.some((a) => t.channels.includes(a.channel)));
        if (first) setTab(first.id);
      })
      .catch((e) => setErr(e.message));
  }, [role, form.id]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const accounts = useMemo(() => new Map((opts?.accounts || []).map((a) => [a.key, a])), [opts]);
  const agentsList = opts?.agents || [];
  const today = todayStr();

  const errors = {
    name: !form.name.trim() ? "Give the campaign a name" : "",
    dates:
      !form.start_date || !form.end_date
        ? "Pick a start and end date"
        : form.end_date < form.start_date
          ? "End date is before start date"
          : "",
    accounts: !form.accounts.length ? "Pick at least one account" : "",
  };
  const stepOk = [
    !errors.name && !errors.dates,
    !errors.accounts,
    true,
    !errors.name && !errors.dates && !errors.accounts,
  ];
  const done = [stepOk[0], stepOk[0] && stepOk[1], stepOk[0] && stepOk[1] && step > 2, false];

  const selectedAcc = new Set(form.accounts);
  const handles = (a) => a.accounts.filter((k) => selectedAcc.has(k));
  const suggested = agentsList.filter((a) => Number(a.is_active) !== 0 && handles(a).length);
  const covered = new Set(
    form.agents.flatMap((u) => handles(agentsList.find((a) => a.uid === u) || { accounts: [] })),
  );
  const uncovered = form.accounts.filter((k) => !covered.has(k));

  // First time on step 3 with nobody chosen: pre-select the agents who already handle the accounts
  useEffect(() => {
    if (step === 2 && !form.agents.length && suggested.length && beforeSuggest === null && !editing) {
      setBeforeSuggest([]);
      set({ agents: suggested.map((a) => a.uid) });
    }
  }, [step, opts]);

  const save = async (draft) => {
    setTouched(true);
    if (!form.name.trim()) {
      setStep(0);
      setErr(errors.name);
      return;
    }
    if (!draft && !stepOk[3]) {
      setStep(errors.name || errors.dates ? 0 : 1);
      setErr(errors.name || errors.dates || errors.accounts);
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const saved = await saveCampaign(role, { ...form, draft });
      onSaved(saved, draft ? "Saved as draft" : editing && wasLive ? "Changes saved" : "Campaign created");
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    setTouched(true);
    if (!stepOk[step]) {
      setErr(step === 0 ? errors.name || errors.dates : errors.accounts);
      return;
    }
    setErr("");
    setTouched(false);
    setStep((s) => Math.min(3, s + 1));
  };

  if (!opts && !err) {
    return (
      <main className="cmp-page">
        <div className="cmp-center">
          <Loader size={18} className="cmp-spin" /> Loading accounts and agents…
        </div>
      </main>
    );
  }

  const status = previewStatus(form.start_date, form.end_date, false);
  const runDays =
    form.start_date && form.end_date && form.end_date >= form.start_date
      ? daysBetween(form.start_date, form.end_date) + 1
      : 0;

  const tabAccounts = (opts?.accounts || []).filter((a) => tabOfChannel(a.channel) === tab);
  const needle = accQ.trim().toLowerCase();
  const visibleAccounts = tabAccounts
    .filter((a) => !needle || `${a.name} ${a.detail}`.toLowerCase().includes(needle))
    .filter((a) => accFilter === "all" || (accFilter === "selected") === selectedAcc.has(a.key));
  const allTabOn = tabAccounts.length > 0 && tabAccounts.every((a) => selectedAcc.has(a.key));
  const toggleAcc = (k) =>
    set({ accounts: selectedAcc.has(k) ? form.accounts.filter((x) => x !== k) : [...form.accounts, k] });

  const agentNeedle = agentQ.trim().toLowerCase();
  const agentRows = (agentTab === "suggested" ? suggested : agentsList).filter(
    (a) => !agentNeedle || `${a.name} ${a.email}`.toLowerCase().includes(agentNeedle),
  );
  const toggleAgent = (u) =>
    set({ agents: form.agents.includes(u) ? form.agents.filter((x) => x !== u) : [...form.agents, u] });

  return (
    <main className="cmp-page cmp-page--wizard">
      <div className="cmp-scroll">
        <header className="cmp-head">
          <div>
            <button className="cmp-back" onClick={onClose}>
              <ArrowLeft size={14} /> Campaigns
            </button>
            <h1>{editing ? "Edit campaign" : "Create campaign"}</h1>
            <p>{SUBTITLE[step]}</p>
          </div>
          <Stepper
            step={step}
            done={done}
            onGo={(i) => (i <= step || done.slice(0, i).every(Boolean) ? setStep(i) : null)}
          />
        </header>

        {err && (
          <div className="cmp-alert" role="alert">
            <TriangleAlert size={15} /> {err}
          </div>
        )}

        <div className="cmp-split">
          {step === 0 && (
            <section className="cmp-form">
              <SectionHead
                n={1}
                title="Campaign details"
                sub="Name it the way your team will recognise it."
              />
              <label className="cmp-field">
                <span>
                  Campaign name <em>*</em>
                </span>
                <span className={`cmp-input cmp-input--lg ${touched && errors.name ? "is-error" : ""}`}>
                  <input
                    value={form.name}
                    maxLength={60}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder="e.g. White Friday 2026"
                    autoFocus
                  />
                  <small>{form.name.length}/60</small>
                </span>
              </label>
              <div className="cmp-field">
                <span>
                  Campaign type <em>*</em>
                </span>
                <div className="cmp-types" role="radiogroup">
                  {TYPES.map((t) => {
                    const Icon = t.icon;
                    const on = form.type === t.id;
                    return (
                      <button
                        key={t.id}
                        role="radio"
                        aria-checked={on}
                        className={on ? "is-on" : ""}
                        onClick={() => set({ type: t.id })}
                      >
                        <span className="cmp-types-ico">
                          <Icon size={16} />
                        </span>
                        {t.label}
                        {on && <CheckIcon size={16} className="cmp-types-check" />}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="cmp-field">
                <span>
                  Short description <i>(optional)</i>
                </span>
                <span className="cmp-input cmp-input--area">
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={form.description}
                    onChange={(e) => set({ description: e.target.value })}
                    placeholder="e.g. 30% off kitchen appliances for registered customers"
                  />
                </span>
              </label>
              <div className="cmp-dates">
                <label className="cmp-field">
                  <span>
                    Start date <em>*</em>
                  </span>
                  <span
                    className={`cmp-input cmp-input--lg ${touched && errors.dates && !form.start_date ? "is-error" : ""}`}
                  >
                    <input
                      type="date"
                      value={form.start_date}
                      onChange={(e) => set({ start_date: e.target.value })}
                    />
                  </span>
                </label>
                <label className="cmp-field">
                  <span>
                    End date <em>*</em>
                  </span>
                  <span
                    className={`cmp-input cmp-input--lg ${touched && errors.dates && (!form.end_date || form.end_date < form.start_date) ? "is-error" : ""}`}
                  >
                    <input
                      type="date"
                      value={form.end_date}
                      min={form.start_date || undefined}
                      onChange={(e) => set({ end_date: e.target.value })}
                    />
                  </span>
                </label>
              </div>
              {runDays > 0 && (
                <div className="cmp-hint">
                  <Clock size={15} />
                  {status === "upcoming" &&
                    `Runs for ${runDays} days. It shows as Upcoming until ${fmtDay(form.start_date)}, then turns Active.`}
                  {status === "active" &&
                    `Runs for ${runDays} days and is Active right away (today is inside the dates).`}
                  {status === "completed" &&
                    `These dates are in the past — the campaign will show as Completed (useful for keeping a record).`}
                </div>
              )}
            </section>
          )}

          {step === 1 && (
            <section className="cmp-form">
              <SectionHead
                n={2}
                title="Select accounts & channels"
                sub="Pick as many as you need, across channels."
                right={
                  tabAccounts.length > 0 && (
                    <button
                      className="cmp-link"
                      onClick={() =>
                        set({
                          accounts: allTabOn
                            ? form.accounts.filter((k) => tabOfKey(k) !== tab)
                            : [...new Set([...form.accounts, ...tabAccounts.map((a) => a.key)])],
                        })
                      }
                    >
                      {allTabOn ? "Unselect" : "Select all"} {CHANNEL_TABS.find((t) => t.id === tab).label}
                    </button>
                  )
                }
              />
              <div className="cmp-tabs" role="tablist">
                {CHANNEL_TABS.map((t) => {
                  const total = (opts?.accounts || []).filter((a) => tabOfChannel(a.channel) === t.id).length;
                  const sel = form.accounts.filter((k) => tabOfKey(k) === t.id).length;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={tab === t.id}
                      className={tab === t.id ? "is-on" : ""}
                      onClick={() => setTab(t.id)}
                    >
                      <Logo tab={t.id} size={24} />
                      <span>
                        <b>{t.label}</b>
                        <small>
                          {sel} of {total} selected
                        </small>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="cmp-row">
                <label className="cmp-input cmp-input--search cmp-grow">
                  <Search size={16} />
                  <input
                    value={accQ}
                    onChange={(e) => setAccQ(e.target.value)}
                    placeholder="Search by account name or number"
                  />
                </label>
                <label className="cmp-input cmp-input--select">
                  <select value={accFilter} onChange={(e) => setAccFilter(e.target.value)} aria-label="Show">
                    <option value="all">All accounts</option>
                    <option value="selected">Selected</option>
                    <option value="unselected">Not selected</option>
                  </select>
                  <ChevronDown size={16} />
                </label>
              </div>
              {tabAccounts.length ? (
                <ul className="cmp-acc-grid">
                  {visibleAccounts.map((a) => {
                    const on = selectedAcc.has(a.key);
                    const used = opts.usedBy?.[a.key];
                    return (
                      <li key={a.key}>
                        <button
                          className={`cmp-acc ${on ? "is-on" : ""}`}
                          onClick={() => toggleAcc(a.key)}
                          aria-pressed={on}
                        >
                          <Check on={on} />
                          <span className="cmp-acc-info">
                            <b>{a.name}</b>
                            <small>{a.detail || "All chats on this channel"}</small>
                          </span>
                          {used && <em title={`Also in: ${used.join(", ")}`}>In {used[0]}</em>}
                        </button>
                      </li>
                    );
                  })}
                  {!visibleAccounts.length && <li className="cmp-muted">No accounts match.</li>}
                </ul>
              ) : (
                <div className="cmp-tab-empty">
                  <Logo tab={tab} size={36} />
                  <p>No {CHANNEL_TABS.find((t) => t.id === tab).label} accounts connected.</p>
                </div>
              )}
            </section>
          )}

          {step === 2 && (
            <section className="cmp-form">
              <SectionHead n={3} title="Assign agents" sub="Based on who already handles these accounts." />
              {suggested.length > 0 && beforeSuggest !== null && (
                <div className="cmp-suggest">
                  <Sparkles size={16} />
                  <span>
                    <b>
                      {suggested.length}{" "}
                      {suggested.length === 1 ? "agent already handles" : "agents already handle"} these
                      accounts
                    </b>
                    <small>From your “Agents &amp; Channels” page — we selected them for you.</small>
                  </span>
                  <button
                    className="cmp-btn cmp-btn--gold cmp-btn--sm"
                    onClick={() => {
                      set({ agents: beforeSuggest });
                      setBeforeSuggest(null);
                    }}
                  >
                    Undo
                  </button>
                </div>
              )}
              <div className="cmp-row">
                <div className="cmp-seg" role="tablist">
                  <button
                    role="tab"
                    aria-selected={agentTab === "suggested"}
                    className={agentTab === "suggested" ? "is-on" : ""}
                    onClick={() => setAgentTab("suggested")}
                  >
                    Suggested <span>{suggested.length}</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={agentTab === "all"}
                    className={agentTab === "all" ? "is-on" : ""}
                    onClick={() => setAgentTab("all")}
                  >
                    All agents <span>{agentsList.length}</span>
                  </button>
                </div>
                <label className="cmp-input cmp-input--search cmp-grow">
                  <Search size={16} />
                  <input
                    value={agentQ}
                    onChange={(e) => setAgentQ(e.target.value)}
                    placeholder="Search agents by name or email"
                  />
                </label>
              </div>
              <ul className="cmp-agents">
                {agentRows.map((a) => {
                  const on = form.agents.includes(a.uid);
                  const h = handles(a);
                  const tabs = CHANNEL_TABS.filter((t) => h.some((k) => tabOfKey(k) === t.id));
                  return (
                    <li key={a.uid}>
                      <button
                        className={`cmp-agent ${on ? "is-on" : ""}`}
                        onClick={() => toggleAgent(a.uid)}
                        aria-pressed={on}
                      >
                        <Check on={on} />
                        <Avatar uid={a.uid} name={a.name} size={34} />
                        <span className="cmp-agent-info">
                          <b>
                            {a.name}
                            {Number(a.is_active) === 0 && <em className="cmp-tag">Inactive</em>}
                          </b>
                          <small>{a.email}</small>
                        </span>
                        {h.length ? (
                          <span className="cmp-agent-handles">
                            {tabs.map((t) => (
                              <Logo key={t.id} tab={t.id} />
                            ))}
                            <small>
                              Handles {h.length} of {form.accounts.length}
                            </small>
                          </span>
                        ) : (
                          <small className="cmp-muted">No access to these accounts</small>
                        )}
                      </button>
                    </li>
                  );
                })}
                {!agentRows.length && (
                  <li className="cmp-muted cmp-pad">
                    {agentTab === "suggested"
                      ? "Nobody handles these accounts yet — check the All agents tab."
                      : "No agents match."}
                  </li>
                )}
              </ul>
            </section>
          )}

          {step === 3 && (
            <section className="cmp-form">
              <SectionHead n={4} title="Review & create" sub="Everything this campaign includes." />
              <div className="cmp-review">
                <header>
                  <h4>Campaign details</h4>
                  <button className="cmp-link" onClick={() => setStep(0)}>
                    <Pencil size={13} /> Edit
                  </button>
                </header>
                <dl className="cmp-review-grid">
                  <dt>Name</dt>
                  <dd>{form.name}</dd>
                  <dt>Type</dt>
                  <dd>{typeOf(form.type).label}</dd>
                  <dt>Dates</dt>
                  <dd>{fmtRange(form.start_date, form.end_date)}</dd>
                  <dt>Duration</dt>
                  <dd>{runDays} days</dd>
                  {form.description && (
                    <>
                      <dt>Description</dt>
                      <dd>{form.description}</dd>
                    </>
                  )}
                </dl>
              </div>
              <div className="cmp-review">
                <header>
                  <h4>Accounts &amp; channels · {form.accounts.length}</h4>
                  <button className="cmp-link" onClick={() => setStep(1)}>
                    <Pencil size={13} /> Edit
                  </button>
                </header>
                {CHANNEL_TABS.map((t) => {
                  const keys = form.accounts.filter((k) => tabOfKey(k) === t.id);
                  if (!keys.length) return null;
                  return (
                    <div key={t.id} className="cmp-sum-group">
                      <span className="cmp-dl-head">
                        <Logo tab={t.id} /> {t.label} · {keys.length}
                      </span>
                      <span className="cmp-chips">
                        {keys.map((k) => (
                          <span key={k} className="cmp-chip">
                            {accounts.get(k)?.name || k}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="cmp-review">
                <header>
                  <h4>Agents · {form.agents.length}</h4>
                  <button className="cmp-link" onClick={() => setStep(2)}>
                    <Pencil size={13} /> Edit
                  </button>
                </header>
                {form.agents.length ? (
                  <ul className="cmp-review-agents">
                    {form.agents.map((u) => {
                      const a = agentsList.find((x) => x.uid === u);
                      return (
                        <li key={u}>
                          <Avatar uid={u} name={a?.name || "?"} size={30} />
                          <b>{a?.name || "Removed agent"}</b>
                          <small>{a ? `${handles(a).length} accounts` : ""}</small>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="cmp-muted">No agents assigned.</p>
                )}
              </div>
            </section>
          )}

          {step < 2 && (
            <Summary
              form={form}
              accounts={accounts}
              onRemove={step === 1 ? toggleAcc : null}
              onClear={step === 1 ? () => set({ accounts: [] }) : null}
            />
          )}

          {step === 2 && (
            <aside className="cmp-panel">
              <div className="cmp-panel-head">
                <h4>Account coverage</h4>
                <StatusPill status={status} />
              </div>
              <div className="cmp-cover">
                <b>{form.accounts.length - uncovered.length}</b>
                <span>of {form.accounts.length} accounts have an agent</span>
              </div>
              <span className="cmp-progress cmp-progress--wide cmp-progress--green">
                <i
                  style={{
                    width: `${form.accounts.length ? ((form.accounts.length - uncovered.length) / form.accounts.length) * 100 : 0}%`,
                  }}
                />
              </span>
              {uncovered.length > 0 && (
                <div className="cmp-uncovered">
                  <span className="cmp-uncovered-head">
                    <TriangleAlert size={14} /> {uncovered.length}{" "}
                    {uncovered.length === 1 ? "account has" : "accounts have"} no agent
                  </span>
                  {uncovered.slice(0, 5).map((k) => (
                    <span key={k} className="cmp-uncovered-row">
                      <Logo tab={tabOfKey(k)} /> {accounts.get(k)?.name || k}
                    </span>
                  ))}
                  <button className="cmp-btn cmp-btn--sm" onClick={() => onNavigate?.("agent-accounts")}>
                    Give access in Agents &amp; Channels
                  </button>
                  <small>You can still create the campaign and fix this later.</small>
                </div>
              )}
              <div className="cmp-sum">
                <small>Selected agents · {form.agents.length}</small>
                <ul className="cmp-sel-agents">
                  {form.agents.map((u) => {
                    const a = agentsList.find((x) => x.uid === u);
                    return (
                      <li key={u}>
                        <Avatar uid={u} name={a?.name || "?"} size={24} />
                        <span className="cmp-sel-name">{a?.name || "Removed agent"}</span>
                        <button onClick={() => toggleAgent(u)} aria-label={`Remove ${a?.name || ""}`}>
                          <X size={13} />
                        </button>
                      </li>
                    );
                  })}
                  {!form.agents.length && <li className="cmp-muted">Nobody yet</li>}
                </ul>
              </div>
              <p className="cmp-panel-note">
                <Info size={13} /> Campaigns don't change who can see chats. Access is set in Agents &amp;
                Channels.
              </p>
            </aside>
          )}

          {step === 3 && (
            <aside className="cmp-panel cmp-panel--ready">
              <h4>Ready to {editing && wasLive ? "save" : "create"}</h4>
              <div className="cmp-ready-when">
                <CalendarDays size={16} />
                <span>
                  {status === "upcoming" && (
                    <>
                      <b>
                        Starts {fmtDay(form.start_date)} · in {daysBetween(today, form.start_date)}{" "}
                        {daysBetween(today, form.start_date) === 1 ? "day" : "days"}
                      </b>
                      <small>Shows as Upcoming until then.</small>
                    </>
                  )}
                  {status === "active" && (
                    <>
                      <b>Active right away</b>
                      <small>Runs until {fmtDay(form.end_date, true)}.</small>
                    </>
                  )}
                  {status === "completed" && (
                    <>
                      <b>Saved as Completed</b>
                      <small>The dates are already in the past.</small>
                    </>
                  )}
                </span>
              </div>
              <ul className="cmp-checks">
                <li className="ok">
                  <CheckIcon size={14} /> Campaign details complete
                </li>
                <li className="ok">
                  <CheckIcon size={14} /> {form.accounts.length} accounts across{" "}
                  {CHANNEL_TABS.filter((t) => form.accounts.some((k) => tabOfKey(k) === t.id)).length}{" "}
                  channels
                </li>
                <li className={form.agents.length ? "ok" : "warn"}>
                  {form.agents.length ? <CheckIcon size={14} /> : <TriangleAlert size={14} />}
                  {form.agents.length ? `${form.agents.length} agents assigned` : "No agents assigned"}
                </li>
                {uncovered.length > 0 && (
                  <li className="warn">
                    <TriangleAlert size={14} /> {uncovered.length}{" "}
                    {uncovered.length === 1 ? "account" : "accounts"} without an agent
                    <small>Optional — you can fix it later.</small>
                  </li>
                )}
              </ul>
            </aside>
          )}
        </div>
      </div>

      <footer className="cmp-bar">
        <div>
          {step === 0 && (
            <>
              <b>Step 1 of 4 · Campaign details</b>
              <span>
                {editing
                  ? "Editing an existing campaign"
                  : "Nothing is saved until you save a draft or create it"}
              </span>
            </>
          )}
          {step === 1 && (
            <>
              <b>
                {form.accounts.length} {form.accounts.length === 1 ? "account" : "accounts"} selected
              </b>
              <span>
                {CHANNEL_TABS.map((t) => [t.label, form.accounts.filter((k) => tabOfKey(k) === t.id).length])
                  .filter(([, n]) => n)
                  .map(([l, n]) => `${l} ${n}`)
                  .join(" · ") || "Pick at least one"}
              </span>
            </>
          )}
          {step === 2 && (
            <>
              <b>
                {form.agents.length} {form.agents.length === 1 ? "agent" : "agents"} selected
              </b>
              <span>
                {form.accounts.length - uncovered.length} of {form.accounts.length} accounts covered
              </span>
            </>
          )}
          {step === 3 && (
            <>
              <b>Everything looks good</b>
              <span>
                Status after {editing && wasLive ? "saving" : "creating"}:{" "}
                {status[0].toUpperCase() + status.slice(1)}
              </span>
            </>
          )}
        </div>
        <div className="cmp-bar-btns">
          {step === 0 ? (
            <button className="cmp-btn cmp-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          ) : (
            <button className="cmp-btn cmp-btn--ghost" onClick={() => setStep(step - 1)}>
              <ArrowLeft size={15} /> Back
            </button>
          )}
          {!wasLive && (
            <button className="cmp-btn" disabled={saving} onClick={() => save(true)}>
              Save as draft
            </button>
          )}
          {step < 3 ? (
            <button className="cmp-btn cmp-btn--primary" onClick={next}>
              Continue <ArrowRight size={15} />
            </button>
          ) : (
            <button className="cmp-btn cmp-btn--primary" disabled={saving} onClick={() => save(false)}>
              {saving ? <Loader size={15} className="cmp-spin" /> : <CheckIcon size={15} />}{" "}
              {editing && wasLive ? "Save changes" : "Create campaign"}
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}

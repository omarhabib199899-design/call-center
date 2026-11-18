import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Info,
  Loader,
  Lock,
  Minus,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { Avatar, Logo, Modal, Radio } from "./ui.jsx";
import {
  accountImpact,
  deactivateAccount,
  deleteAccount,
  firstName,
  inviteAgent,
  joinNames,
  markCustom,
  plural,
  removeAgent,
  renameAccount,
  searchAgents,
  tabOf,
  TABS,
  updateAgent,
} from "./model.js";

const tabLabel = (acc) => TABS.find((t) => t.id === tabOf(acc?.channel))?.label || "";

function Field({ label, req, optional, hint, error, children, extra }) {
  return (
    <label className={`ac-field ${error ? "has-error" : ""}`}>
      <span className="ac-field-label">
        {label}
        {req && <em>*</em>}
        {optional && <i>(optional)</i>}
        {extra}
      </span>
      {children}
      {error ? (
        <span className="ac-field-err">
          <AlertTriangle size={14} /> {error}
        </span>
      ) : (
        hint && <span className="ac-field-hint">{hint}</span>
      )}
    </label>
  );
}

const COUNTRIES = [
  ["EG", "Egypt", "20"],
  ["SA", "Saudi Arabia", "966"],
  ["AE", "United Arab Emirates", "971"],
  ["KW", "Kuwait", "965"],
  ["QA", "Qatar", "974"],
  ["BH", "Bahrain", "973"],
  ["OM", "Oman", "968"],
  ["JO", "Jordan", "962"],
  ["LB", "Lebanon", "961"],
  ["IQ", "Iraq", "964"],
  ["LY", "Libya", "218"],
  ["SD", "Sudan", "249"],
  ["MA", "Morocco", "212"],
  ["DZ", "Algeria", "213"],
  ["TN", "Tunisia", "216"],
  ["TR", "Türkiye", "90"],
  ["GB", "United Kingdom", "44"],
  ["DE", "Germany", "49"],
  ["FR", "France", "33"],
  ["US", "United States / Canada", "1"],
];
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

// "+20 100 734 5521" -> { cc: "EG", rest: "100 734 5521" }
function splitPhone(v) {
  const digits = String(v || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const d = digits.slice(1);
    const hit = [...COUNTRIES].sort((a, b) => b[2].length - a[2].length).find((c) => d.startsWith(c[2]));
    if (hit) {
      const rest = String(v)
        .replace(/^\s*\+\s*/, "")
        .replace(new RegExp("^" + hit[2] + "\\s*"), "");
      return { cc: hit[0], rest: rest.trim() };
    }
  }
  return { cc: "EG", rest: String(v || "").trim() };
}

export function PhoneInput({ value, onChange, invalid }) {
  const { cc, rest } = splitPhone(value);
  const code = COUNTRIES.find((c) => c[0] === cc)?.[2] || "20";
  const emit = (ncc, nrest) => {
    const ncode = COUNTRIES.find((c) => c[0] === ncc)?.[2] || "20";
    const local = nrest.replace(/^0+/, "");
    onChange(local ? `+${ncode} ${local}` : "");
  };
  return (
    <span className={`ac-phone ${invalid ? "is-invalid" : ""}`}>
      <span className="ac-phone-cc">
        <span aria-hidden>{flag(cc)}</span>
        <b>+{code}</b>
        <ChevronDown size={14} />
        <select value={cc} onChange={(e) => emit(e.target.value, rest)} aria-label="Country code">
          {COUNTRIES.map(([c, n, d]) => (
            <option key={c} value={c}>
              {flag(c)} {n} (+{d})
            </option>
          ))}
        </select>
      </span>
      <input
        value={rest}
        onChange={(e) => emit(cc, e.target.value)}
        inputMode="tel"
        placeholder="100 734 5521"
        aria-label="Phone number"
      />
    </span>
  );
}

export function AddCustomAgent({ role, customCount, onClose, onDone }) {
  const [step, setStep] = useState("choose");
  const [pick, setPick] = useState("existing");
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [sel, setSel] = useState(null);
  const [f, setF] = useState({ name: "", email: "", mobile: "", limit: "" });
  const [errs, setErrs] = useState({});
  const [existing, setExisting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (step !== "existing") return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await searchAgents(role, q.trim());
        if (live) setResults(r);
      } catch (e) {
        if (live) setResults([]);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, step, role]);

  const addExisting = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await markCustom(role, sel.uid);
      onDone({ uid: sel.uid, name: sel.name, toast: `${sel.name} added as a custom agent` });
    } catch (e) {
      setErrs({ form: e.message });
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrs((x) => ({ ...x, [k]: "" }));
    if (k === "email") setExisting(null);
  };
  const check = () => {
    const e = {};
    const name = f.name.trim();
    if (name.length < 2 || name.length > 50) e.name = "Use 2–50 characters";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = "Enter a valid email";
    if (f.mobile.replace(/\D/g, "").length < 8) e.mobile = "Enter a valid phone number";
    if (f.limit !== "" && !(Number(f.limit) >= 1 && Number(f.limit) <= 1000))
      e.limit = "Use a number from 1 to 1000";
    return e;
  };
  const valid = !Object.keys(check()).length;
  const invite = async (ev) => {
    ev?.preventDefault();
    const e = check();
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await inviteAgent(role, { ...f, name: f.name.trim(), email: f.email.trim().toLowerCase() });
      if (r.password) {
        setDone({
          uid: r.uid,
          name: f.name.trim(),
          email: f.email.trim().toLowerCase(),
          password: r.password,
        });
        setStep("password");
      } else
        onDone({ uid: r.uid, name: f.name.trim(), toast: `Invite sent to ${f.email.trim().toLowerCase()}` });
    } catch (e2) {
      setErrs({ [e2.field || "form"]: e2.message });
      if (e2.existing) setExisting(e2.existing);
    } finally {
      setBusy(false);
    }
  };

  if (step === "password") {
    return (
      <Modal
        title="Agent created"
        sub="The invite email couldn't be sent, so pass these details to them yourself."
        onClose={() =>
          onDone({ uid: done.uid, name: done.name, toast: `${done.name} added as a custom agent` })
        }
        footer={
          <button
            className="ac-btn ac-btn--primary"
            onClick={() =>
              onDone({ uid: done.uid, name: done.name, toast: `${done.name} added as a custom agent` })
            }
          >
            <Check size={16} /> Done
          </button>
        }
      >
        <div className="ac-cred">
          <span>Login page</span>
          <b>{location.origin}/agent/login</b>
          <span>Email</span>
          <b>{done.email}</b>
          <span>Temporary password</span>
          <b className="ac-cred-pass">
            {done.password}
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(done.password)}
              aria-label="Copy password"
            >
              <Copy size={14} />
            </button>
          </b>
        </div>
        <p className="ac-note">This password is shown only once. Ask them to change it after signing in.</p>
      </Modal>
    );
  }

  if (step === "existing") {
    const chosen = sel && results?.find((r) => r.uid === sel.uid);
    return (
      <Modal
        title="Add existing agent"
        sub="Search your agents by name or email."
        width={600}
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="ac-back" onClick={() => setStep("choose")}>
              <ArrowLeft size={14} /> Back
            </button>
            <span className="ac-grow" />
            <button type="button" className="ac-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="ac-btn ac-btn--primary"
              disabled={!chosen || busy}
              onClick={addExisting}
            >
              {busy ? <Loader size={16} className="ac-spin" /> : <Plus size={16} />} Add{" "}
              {chosen ? firstName(chosen.name) : "agent"}
            </button>
          </>
        }
      >
        <label className="ac-search ac-search--lg">
          <Search size={16} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email" />
        </label>
        <ul className="ac-results">
          {results === null && (
            <li className="ac-none">
              <Loader size={14} className="ac-spin" /> Searching…
            </li>
          )}
          {results?.length === 0 && (
            <li className="ac-none">No agents match. Use “New agent” to invite someone.</li>
          )}
          {results?.map((r) => {
            const can = r.status === "available";
            const on = sel?.uid === r.uid && can;
            return (
              <li key={r.uid || r.email}>
                <button
                  type="button"
                  className={`ac-result ${on ? "is-on" : ""} ${can ? "" : "is-off"}`}
                  disabled={!can}
                  onClick={() => setSel(r)}
                >
                  <Radio on={on} />
                  <span className="ac-result-who">
                    <b>{r.name || r.email}</b>
                    <small>{r.name ? r.email : "Agent of another client"}</small>
                  </span>
                  {r.status !== "other_client" && (
                    <span className="ac-result-n">
                      {r.limit != null
                        ? `${r.accounts} / ${r.limit} accounts`
                        : plural(r.accounts, "account")}
                    </span>
                  )}
                  <span
                    className={`ac-pill ${
                      r.status === "available"
                        ? "ac-pill--gold"
                        : r.status === "other_client"
                          ? "ac-pill--red"
                          : "ac-pill--grey"
                    }`}
                  >
                    {
                      {
                        available: "Available",
                        full: "At account limit",
                        custom: "Already custom",
                        other_client: "Works for another client",
                      }[r.status]
                    }
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {chosen && (
          <div className="ac-callout ac-callout--gold">
            <Info size={16} />
            {chosen.limit != null
              ? `${firstName(chosen.name)} can take ${chosen.limit - chosen.accounts} more ${chosen.limit - chosen.accounts === 1 ? "account" : "accounts"}.`
              : `${firstName(chosen.name)} has no account limit.`}
          </div>
        )}
        {errs.form && <div className="ac-error-box">{errs.form}</div>}
      </Modal>
    );
  }

  if (step === "new") {
    return (
      <Modal
        as="form"
        onSubmit={invite}
        title="Invite new agent"
        sub="They’ll receive an email with a link and a temporary password to sign in."
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="ac-back" onClick={() => setStep("choose")}>
              <ArrowLeft size={14} /> Back
            </button>
            <span className="ac-grow" />
            <button type="button" className="ac-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="ac-btn ac-btn--primary" disabled={!valid || busy}>
              {busy ? <Loader size={16} className="ac-spin" /> : null} Send invite
            </button>
          </>
        }
      >
        <div className="ac-form">
          <Field
            label="Full name"
            req
            hint="2–50 characters. Customers may see this name in chats."
            error={errs.name}
          >
            <input autoFocus value={f.name} onChange={set("name")} maxLength={50} />
          </Field>
          <Field label="Work email" req hint="This is their login." error={errs.email}>
            <input type="email" value={f.email} onChange={set("email")} />
          </Field>
          {existing && (
            <button
              type="button"
              className="ac-linkline"
              onClick={() => {
                setStep("existing");
                setQ(f.email.trim());
                setSel({ uid: existing.uid, name: existing.name });
              }}
            >
              Add {existing.name} as an existing agent <ArrowRight size={14} />
            </button>
          )}
          <Field label="Phone number" req error={errs.mobile}>
            <PhoneInput
              value={f.mobile}
              invalid={!!errs.mobile}
              onChange={(v) => set("mobile")({ target: { value: v } })}
            />
          </Field>
          <Field label="Account limit" optional hint="Leave empty for no limit." error={errs.limit}>
            <span className="ac-inline">
              <input className="ac-num-in" value={f.limit} onChange={set("limit")} inputMode="numeric" />
              <span>accounts</span>
            </span>
          </Field>
          {errs.form && <div className="ac-error-box">{errs.form}</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add custom agent"
      sub="Custom agents work only on this workspace and see just the accounts you assign them."
      onClose={onClose}
      footer={
        <>
          <span className="ac-grow" />
          <button type="button" className="ac-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ac-btn ac-btn--primary" onClick={() => setStep(pick)}>
            Continue <ArrowRight size={16} />
          </button>
        </>
      }
    >
      <div className="ac-seats">
        <Users size={16} />
        <span>
          <b>{plural(customCount, "custom agent")}</b> on this workspace
        </span>
      </div>
      <div className="ac-options">
        <button
          type="button"
          className={`ac-option ${pick === "existing" ? "is-on" : ""}`}
          onClick={() => setPick("existing")}
        >
          <Radio on={pick === "existing"} />
          <span>
            <b>
              <Users size={16} /> Existing agent
            </b>
            <small>
              Already has a login on this workspace. They keep their login and inbox, and appear under Custom.
            </small>
            <em>Instant — no invite needed</em>
          </span>
        </button>
        <button
          type="button"
          className={`ac-option ${pick === "new" ? "is-on" : ""}`}
          onClick={() => setPick("new")}
        >
          <Radio on={pick === "new"} />
          <span>
            <b>
              <UserPlus size={16} /> New agent
            </b>
            <small>Not on Omni yet. They’ll get an email with a link and a temporary password.</small>
            <em>Needs: name, email, phone</em>
          </span>
        </button>
      </div>
    </Modal>
  );
}

export function EditAgent({ role, agent, nAccounts, onClose, onSaved }) {
  const [f, setF] = useState({
    name: agent.name || "",
    mobile: agent.mobile || "",
    limit: agent.limit ?? "",
    target: agent.target ?? "",
  });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrs((x) => ({ ...x, [k]: "" }));
  };
  const phoneChanged = f.mobile.replace(/\s/g, "") !== String(agent.mobile || "").replace(/\s/g, "");
  const dirty =
    f.name.trim() !== (agent.name || "") ||
    phoneChanged ||
    String(f.limit) !== String(agent.limit ?? "") ||
    String(f.target) !== String(agent.target ?? "");
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await updateAgent(role, {
        uid: agent.uid,
        name: f.name.trim(),
        mobile: f.mobile,
        limit: f.limit === "" ? "" : Number(f.limit),
        sales_target: f.target === "" ? "" : f.target,
      });
      onSaved(`${f.name.trim()} updated`);
    } catch (e2) {
      setErrs({ [e2.field || "form"]: e2.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      as="form"
      onSubmit={save}
      title="Edit agent details"
      sub={`${agent.name} · ${plural(nAccounts, "account")}`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="ac-note ac-grow">Changes apply right away.</span>
          <button type="button" className="ac-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ac-btn ac-btn--primary" disabled={!dirty || busy}>
            {busy ? <Loader size={16} className="ac-spin" /> : <Check size={16} />} Save changes
          </button>
        </>
      }
    >
      <div className="ac-form">
        <Field
          label="Full name"
          hint="2–50 characters. Customers may see this name in chats."
          error={errs.name}
        >
          <input value={f.name} onChange={set("name")} maxLength={50} autoFocus />
        </Field>
        <Field label="Email" hint="Email is the agent’s login, so it can’t be changed here.">
          <span className="ac-locked">
            <input value={agent.email || ""} disabled readOnly />
            <Lock size={15} />
          </span>
        </Field>
        <Field
          label="Phone number"
          extra={phoneChanged && <span className="ac-pill ac-pill--gold">Changed</span>}
          hint={phoneChanged ? `Was ${agent.mobile || "empty"}.` : undefined}
          error={errs.mobile}
        >
          <PhoneInput
            value={f.mobile}
            invalid={!!errs.mobile}
            onChange={(v) => set("mobile")({ target: { value: v } })}
          />
        </Field>
        <Field label="Account limit" optional hint="Leave empty for no limit." error={errs.limit}>
          <span className="ac-inline">
            <input className="ac-num-in" value={f.limit} onChange={set("limit")} inputMode="numeric" />
            <span>accounts</span>
          </span>
        </Field>
        <Field
          label="Monthly sales target"
          optional
          hint="Shown as “Target achievement” in Team Performance on Home."
          error={errs.target}
        >
          <span className="ac-inline">
            <input className="ac-num-in" value={f.target} onChange={set("target")} inputMode="decimal" />
            <span>per month</span>
          </span>
        </Field>
        {errs.form && <div className="ac-error-box">{errs.form}</div>}
      </div>
    </Modal>
  );
}

export function RemoveAgent({ role, agent, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true);
    try {
      await removeAgent(role, agent.uid);
      onDone(`${agent.name} removed`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Remove ${agent.name}?`}
      sub={agent.email}
      width={480}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="ac-grow" />
          <button className="ac-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="ac-btn ac-btn--danger" onClick={go} disabled={busy}>
            {busy ? <Loader size={16} className="ac-spin" /> : <Trash2 size={16} />} Remove agent
          </button>
        </>
      }
    >
      <div className="ac-callout ac-callout--red">
        <AlertTriangle size={16} />
        <span>
          Their login is deleted and they lose access to every account. Conversations they handled stay in
          your inbox.
        </span>
      </div>
      {err && <div className="ac-error-box">{err}</div>}
    </Modal>
  );
}

export function RenameAccount({ role, acc, onClose, onDone }) {
  const [v, setV] = useState(acc.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await renameAccount(role, acc.key, v.trim());
      onDone(`Renamed to ${v.trim()}`);
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      as="form"
      onSubmit={go}
      title="Rename account"
      sub={`${tabLabel(acc)} · ${acc.detail || acc.account_id}`}
      width={460}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="ac-grow" />
          <button type="button" className="ac-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="ac-btn ac-btn--primary"
            disabled={!v.trim() || v.trim() === acc.name || busy}
          >
            Save name
          </button>
        </>
      }
    >
      <div className="ac-form">
        <Field label="Name" hint="Only you and your agents see this name." error={err}>
          <input value={v} onChange={(e) => setV(e.target.value)} maxLength={60} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

function useImpact(role, key) {
  const [d, setD] = useState(null);
  useEffect(() => {
    accountImpact(role, key)
      .then(setD)
      .catch(() => setD({ agents: [], chats: 0, vip: 0, canDelete: false }));
  }, [role, key]);
  return d;
}

const REASONS = [
  { id: "unused", label: "No longer used" },
  { id: "seasonal", label: "Seasonal — we’ll bring it back" },
  { id: "moving", label: "Moving to another number" },
  { id: "other", label: "Other" },
];

export function DeactivateAccount({ role, acc, onClose, onDone }) {
  const impact = useImpact(role, acc.key);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const names = impact?.agents.map((a) => firstName(a.name)) || [];
  const go = async () => {
    setBusy(true);
    try {
      await deactivateAccount(role, acc.key, reason, note.trim());
      onDone(acc);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Pause ${acc.name}?`}
      sub={`${tabLabel(acc)} · ${acc.detail || acc.account_id}`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="ac-grow" />
          <button className="ac-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="ac-btn ac-btn--primary" disabled={!reason || busy} onClick={go}>
            {busy ? <Loader size={16} className="ac-spin" /> : null} Pause channel
          </button>
        </>
      }
    >
      <div className="ac-impact">
        <span className="ac-impact-title">What happens</span>
        {!impact ? (
          <p className="ac-muted-line">
            <Loader size={14} className="ac-spin" /> Checking…
          </p>
        ) : (
          <ul>
            <li>
              {names.length ? (
                <>
                  <b>{joinNames(names)}</b> stop seeing its conversations in their inbox.
                </>
              ) : (
                "No agent has this account right now."
              )}
            </li>
            <li>New messages still arrive. You still see them in your own inbox.</li>
            <li>
              Conversation history{impact.chats ? ` (${impact.chats.toLocaleString()} conversations)` : ""}{" "}
              and contacts are kept.
            </li>
            <li>You can resume it any time and agents get it back.</li>
          </ul>
        )}
      </div>
      <div className="ac-field">
        <span className="ac-field-label">
          Reason<em>*</em> <i>— saved in History</i>
        </span>
        <div className="ac-reasons">
          {REASONS.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`ac-reason ${reason === r.id ? "is-on" : ""}`}
              onClick={() => setReason(r.id)}
            >
              <Radio on={reason === r.id} /> {r.label}
            </button>
          ))}
        </div>
      </div>
      <label className="ac-field">
        <span className="ac-field-label">Add a note (optional)</span>
        <textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {err && <div className="ac-error-box">{err}</div>}
    </Modal>
  );
}

export function DeleteAccount({ role, acc, onClose, onDone, onDeactivate }) {
  const impact = useImpact(role, acc.key);
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const match = v.trim() === acc.name.trim();
  const go = async () => {
    setBusy(true);
    try {
      await deleteAccount(role, acc.key, v.trim());
      onDone(`${acc.name} deleted`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete ${acc.name} permanently`}
      sub={`${tabLabel(acc)} · ${acc.detail || acc.account_id}`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="ac-grow" />
          <button className="ac-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ac-btn ac-btn--danger"
            disabled={!match || busy || impact?.canDelete === false}
            onClick={go}
          >
            {busy ? <Loader size={16} className="ac-spin" /> : <Trash2 size={16} />} Delete account
          </button>
        </>
      }
    >
      <div className="ac-callout ac-callout--red">
        <AlertTriangle size={16} />
        <span>
          <b>This can’t be undone.</b> The account is disconnected
          {acc.channel === "qr" && acc.sessions > 1 ? ` (all ${acc.sessions} sessions)` : ""} and removed from{" "}
          {impact?.agents.length ? joinNames(impact.agents.map((a) => firstName(a.name))) : "every agent"}.
          {impact?.chats
            ? ` Its ${impact.chats.toLocaleString()} conversations stay in your inbox, but you can’t reply from this account any more.`
            : ""}
        </span>
      </div>
      {impact?.canDelete === false && (
        <div className="ac-error-box">Disconnect this account from its Channels page instead.</div>
      )}
      {!acc.off && (
        <div className="ac-suggest">
          <span>
            <b>Just want to stop using it for now?</b>
            <small>Pausing keeps the history and lets you bring it back.</small>
          </span>
          <button type="button" className="ac-btn ac-btn--sm" onClick={onDeactivate}>
            Pause instead
          </button>
        </div>
      )}
      <label className="ac-field">
        <span className="ac-field-label">Type “{acc.name}” to confirm</span>
        <input value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" />
      </label>
      {err && <div className="ac-error-box">{err}</div>}
    </Modal>
  );
}

export function ReviewRemovals({
  changes,
  vipChanges,
  accountByKey,
  agentByUid,
  holdersAfter,
  saving,
  onBack,
  onSave,
}) {
  const rows = (kind) => {
    const m = new Map();
    for (const c of changes) for (const k of c[kind]) m.set(k, [...(m.get(k) || []), c.uid]);
    return [...m.entries()];
  };
  const removing = rows("removed");
  const adding = rows("added");
  const nRem = removing.reduce((s, [, u]) => s + u.length, 0);
  const nAdd = adding.reduce((s, [, u]) => s + u.length, 0);
  const orphans = removing
    .filter(([k]) => !(holdersAfter.get(k) || []).length)
    .map(([k]) => accountByKey.get(k)?.name || k);
  const list = (items, kind) =>
    items.map(([k, uids]) => {
      const acc = accountByKey.get(k);
      return (
        <li key={k}>
          <Logo tab={tabOf(acc?.channel)} size={22} />
          <span className="ac-rv-acc">
            <b>{acc?.name || k}</b>
            <small>{acc?.detail}</small>
          </span>
          <span className={kind === "removed" ? "ac-removed" : "ac-added"}>
            {kind === "removed" ? (
              <Minus size={11} strokeWidth={2.5} />
            ) : (
              <Plus size={11} strokeWidth={2.5} />
            )}
            {kind === "removed" ? "Will be removed" : "Will be assigned"}
          </span>
          <span className="ac-stack">
            {uids.slice(0, 3).map((u) => (
              <Avatar key={u} name={agentByUid.get(u)?.name} size={26} />
            ))}
            {uids.length > 3 && <span className="ac-av ac-av--more">+{uids.length - 3}</span>}
          </span>
        </li>
      );
    });
  const busy = !!saving;
  return (
    <Modal
      title="Review before saving"
      sub="You’re removing access, so here’s a quick check."
      busy={busy}
      onClose={onBack}
      footer={
        <>
          <span className="ac-grow" />
          <button className="ac-btn" disabled={busy} onClick={onBack}>
            <ArrowLeft size={16} /> Back to editing
          </button>
          <button className="ac-btn ac-btn--primary" disabled={busy} onClick={onSave}>
            {busy ? <Loader size={16} className="ac-spin" /> : <Check size={16} />} Save changes
          </button>
        </>
      }
    >
      <div className="ac-rv-sec">
        <span className="ac-rv-cap ac-rv-cap--red">REMOVING ACCESS · {plural(nRem, "assignment")}</span>
        <ul className="ac-rv-list">{list(removing, "removed")}</ul>
        <p className="ac-rv-who-line">
          {joinNames(
            changes.filter((c) => c.removed.length).map((c) => firstName(agentByUid.get(c.uid)?.name)),
          )}{" "}
          lose these conversations from their inbox as soon as you save.
        </p>
        {orphans.length > 0 && (
          <div className="ac-callout ac-callout--red">
            <AlertTriangle size={16} />
            <span>{joinNames(orphans)} will have no agent. New conversations there will only reach you.</span>
          </div>
        )}
      </div>
      {(nAdd > 0 || vipChanges.length > 0) && (
        <div className="ac-rv-sec">
          <span className="ac-rv-cap">
            ADDING ACCESS ·{" "}
            {plural(nAdd + vipChanges.reduce((s, v) => s + v.chat_ids.length, 0), "assignment")}
          </span>
          <ul className="ac-rv-list">{list(adding, "added")}</ul>
        </div>
      )}
      {saving?.error && <div className="ac-error-box">{saving.error}</div>}
    </Modal>
  );
}

export function HowItWorks({ onClose }) {
  return (
    <Modal title="How assignment works" width={520} onClose={onClose}>
      <ol className="ac-how">
        <li>
          <b>Select agents</b> on the left — one or several.
        </li>
        <li>
          <b>Check the accounts</b> they should handle. Every conversation that arrives on a checked account
          shows up in their inbox. With one agent selected you can also give them only specific customers of
          an account.
        </li>
        <li>
          <b>Save.</b> Nothing changes until you save, and every save can be undone from History.
        </li>
      </ol>
      <p className="ac-note">
        Accounts are the WhatsApp numbers, Facebook pages, Instagram and Telegram accounts connected to this
        workspace. You can still assign single conversations by hand from the inbox.
      </p>
    </Modal>
  );
}

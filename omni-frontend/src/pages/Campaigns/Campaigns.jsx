import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Loader, RefreshCw } from "lucide-react";
import { listCampaigns, loadOptions, deleteCampaign, duplicateCampaign, endCampaign } from "./meta.js";
import { CampaignTable, EmptyCampaigns } from "./CampaignList.jsx";
import CampaignView from "./CampaignView.jsx";
import Wizard from "./Wizard.jsx";
import "./Campaigns.css";

export default function Campaigns({ role, onNavigate }) {
  const [list, setList] = useState(null);
  const [opts, setOpts] = useState({ accounts: [], agents: [] });
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, o] = await Promise.all([listCampaigns(role), loadOptions(role)]);
      setList(l);
      setOpts(o);
      setError("");
      return l;
    } catch (e) {
      if (e.signedOut) location.href = "/user/login";
      setError(e.message);
      return null;
    }
  }, [role]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const accounts = useMemo(() => new Map(opts.accounts.map((a) => [a.key, a])), [opts]);
  const agents = useMemo(() => new Map(opts.agents.map((a) => [a.uid, a])), [opts]);

  const run = async (kind, c) => {
    setBusy(true);
    try {
      if (kind === "delete") {
        await deleteCampaign(role, c.id);
        setViewing(null);
        setToast(`“${c.name}” deleted`);
      } else if (kind === "duplicate") {
        const copy = await duplicateCampaign(role, c.id);
        setViewing(null);
        setToast("Copy saved as draft — pick new dates");
        await load();
        setEditing(copy);
        return;
      } else if (kind === "end") {
        const after = await endCampaign(role, c.id);
        setToast(
          after.status === "completed"
            ? `“${c.name}” ended`
            : `“${c.name}” started today, so it ends tonight`,
        );
      }
      const l = await load();
      if (viewing && l) setViewing(l.find((x) => x.id === viewing.id) || null);
    } catch (e) {
      setToast(e.message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const onAction = (kind, c) => (kind === "duplicate" ? run(kind, c) : setConfirm({ kind, c }));

  if (editing) {
    return (
      <Wizard
        role={role}
        initial={editing}
        onNavigate={onNavigate}
        onClose={() => setEditing(null)}
        onSaved={async (saved, msg) => {
          setEditing(null);
          setToast(msg);
          const l = await load();
          if (l && saved.status !== "draft") setViewing(l.find((x) => x.id === saved.id) || null);
        }}
      />
    );
  }

  return (
    <main className="cmp-page">
      <div className="cmp-scroll">
        <header className="cmp-head">
          <div>
            <h1>Campaigns</h1>
            <p>Group the accounts, channels and agents working on one promotion.</p>
          </div>
          {list?.length > 0 && (
            <button className="cmp-btn cmp-btn--primary" onClick={() => setEditing({})}>
              <Plus size={16} /> Create campaign
            </button>
          )}
        </header>

        {error && (
          <div className="cmp-center">
            <p className="cmp-error">{error}</p>
            <button className="cmp-btn" onClick={load}>
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        )}
        {!list && !error && (
          <div className="cmp-center">
            <Loader size={18} className="cmp-spin" /> Loading campaigns…
          </div>
        )}
        {list && !list.length && <EmptyCampaigns onCreate={(preset) => setEditing(preset || {})} />}
        {list?.length > 0 && (
          <CampaignTable
            campaigns={list}
            agents={agents}
            onOpen={setViewing}
            onEdit={setEditing}
            onAction={onAction}
          />
        )}
      </div>

      {viewing && (
        <CampaignView
          c={viewing}
          accounts={accounts}
          agents={agents}
          onClose={() => setViewing(null)}
          onEdit={(c) => {
            setViewing(null);
            setEditing(c);
          }}
          onAction={onAction}
        />
      )}

      {confirm && (
        <div className="cmp-modal-back" onClick={() => !busy && setConfirm(null)}>
          <div
            className="cmp-modal"
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{confirm.kind === "delete" ? "Delete campaign?" : "End campaign now?"}</h3>
            <p>
              {confirm.kind === "delete"
                ? `“${confirm.c.name}” will be removed. Chats and messages are not affected.`
                : `“${confirm.c.name}” will move to Completed. Chats and agent access are not affected.`}
            </p>
            <footer>
              <button className="cmp-btn cmp-btn--ghost" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className={`cmp-btn ${confirm.kind === "delete" ? "cmp-btn--danger" : "cmp-btn--primary"}`}
                disabled={busy}
                onClick={() => run(confirm.kind, confirm.c)}
              >
                {busy && <Loader size={14} className="cmp-spin" />}{" "}
                {confirm.kind === "delete" ? "Delete" : "End now"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {toast && <div className="cmp-toast">{toast}</div>}
    </main>
  );
}

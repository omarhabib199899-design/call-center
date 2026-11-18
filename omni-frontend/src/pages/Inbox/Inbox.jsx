import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, MessageSquare, WifiOff, X } from "lucide-react";
import ChatList from "./ChatList.jsx";
import ChatView from "./ChatView.jsx";
import CustomerPanel from "./CustomerPanel.jsx";
import NewConversation from "./NewConversation.jsx";
import {
  loadAccounts,
  loadActivity,
  loadAgents,
  loadChat,
  loadChats,
  openSocket,
  setPriority,
  setStatus,
} from "./model.js";
import "./Inbox.css";

const PAGE = 30;
const DEFAULT_PARAMS = { view: "all", platform: "", account: "", q: "", sort: "newest", labeled: "" };

function readParams() {
  try {
    const s = JSON.parse(localStorage.getItem("omni.inbox.params") || "{}");
    return { ...DEFAULT_PARAMS, ...s, q: "" };
  } catch {
    return DEFAULT_PARAMS;
  }
}

export default function Inbox({ role, onNavigate }) {
  const isAgent = role === "agent";
  const [params, setParams] = useState(readParams);
  const [list, setList] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [active, setActive] = useState(null);
  const [conv, setConv] = useState(null);
  const [activity, setActivity] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [agents, setAgents] = useState([]);
  const small = () => window.innerWidth < 1080;
  const [showCustomer, setShowCustomer] = useState(() => {
    if (small()) return false;
    try {
      return localStorage.getItem("omni.inbox.customer") !== "0";
    } catch {
      return true;
    }
  });
  const [newOpen, setNewOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [offline, setOffline] = useState(false);
  const [lastError, setLastError] = useState("");

  const activeRef = useRef(null);
  const convRef = useRef(null);
  const sockRef = useRef(null);
  const searchRef = useRef(null);
  const listTimer = useRef(null);
  activeRef.current = active;
  convRef.current = conv;

  useEffect(() => {
    try {
      const { q, ...rest } = params;
      localStorage.setItem("omni.inbox.params", JSON.stringify(rest));
    } catch {}
  }, [params]);
  useEffect(() => {
    if (small()) return;
    try {
      localStorage.setItem("omni.inbox.customer", showCustomer ? "1" : "0");
    } catch {}
  }, [showCustomer]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchList = useCallback(
    async (opts = {}) => {
      setListLoading(true);
      try {
        const d = await loadChats(role, { ...params, limit: opts.limit || limit, offset: 0 });
        setList(d);
        // Keep the open chat's row (status, labels, agents) in sync
        const a = activeRef.current;
        if (a) {
          const row = d.rows.find((r) => r.chat_id === a.chat_id);
          if (row)
            setActive((cur) => (cur && cur.chat_id === row.chat_id ? { ...row, unread_count: 0 } : cur));
        }
      } catch (e) {
        if (e.signedOut) location.href = isAgent ? "/agent/login" : "/user/login";
        setToast({ text: e.message, error: true });
      } finally {
        setListLoading(false);
      }
    },
    [role, params, limit, isAgent],
  );

  useEffect(() => {
    const t = setTimeout(() => fetchList(), params.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [fetchList, params.q]);

  const refreshListSoon = useCallback(() => {
    clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => fetchList(), 350);
  }, [fetchList]);

  const requestConv = useCallback((chatRow, offset = 0, lim = 30) => {
    if (!sockRef.current || !chatRow?.id) return;
    sockRef.current.send("load_conversation", {
      chat: { id: chatRow.id, chat_id: chatRow.chat_id },
      filters: { limit: lim, offset },
    });
  }, []);

  const refreshActivity = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    loadActivity(role, a.chat_id)
      .then((d) => activeRef.current?.chat_id === a.chat_id && setActivity(d))
      .catch(() => {});
  }, [role]);

  const reloadOpen = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    const c = convRef.current;
    const have = c?.chatId === a.chat_id ? c.messages.length : 0;
    requestConv(a, 0, Math.min(200, Math.max(30, have)));
  }, [requestConv]);

  useEffect(() => {
    const s = openSocket(role, {
      onConnect: () => {
        setOffline(false);
        if (activeRef.current) reloadOpen();
      },
      onDisconnect: () => setOffline(true),
      onConnectError: (msg) => {
        console.warn("[inbox] live connection failed:", msg);
        setOffline(true);
      },
      onConversation: (d) => {
        const a = activeRef.current;
        if (!a || d?.chatInfo?.chat_id !== a.chat_id) return;
        const rows = (d.conversation || []).slice().reverse();
        setConv((cur) => {
          const same = cur && cur.chatId === a.chat_id;
          if (d.offset > 0 && same) {
            return {
              ...cur,
              messages: [...rows, ...cur.messages],
              total: d.total,
              loadingOlder: false,
              olderLoaded: true,
              version: cur.version + 1,
            };
          }
          return {
            chatId: a.chat_id,
            messages: rows,
            total: d.total,
            chatInfo: d.chatInfo,
            labels: d.labelsAdded || [],
            countDownTimer: d.countDownTimer,
            loadingOlder: false,
            olderLoaded: false,
            version: (same ? cur.version : 0) + 1,
            sending: same && rows.length <= cur.messages.length ? cur.sending : [],
          };
        });
      },
      onListChanged: (d) => {
        refreshListSoon();
        const a = activeRef.current;
        if (a && (!d?.chatId || d.chatId === a.chat_id)) reloadOpen();
      },
      onOpenedChanged: () => {
        reloadOpen();
        refreshListSoon();
        refreshActivity();
      },
      onLabels: (labels) => setConv((c) => (c ? { ...c, labels } : c)),
      onError: (msg) => {
        setLastError(msg + ` (${Date.now()})`);
        setConv((c) => (c ? { ...c, sending: [] } : c));
        setToast({ text: msg, error: true });
      },
    });
    sockRef.current = s;
    return () => s.close();
  }, [role, reloadOpen, refreshListSoon, refreshActivity]);

  const open = useCallback(
    (row) => {
      if (!row) return;
      if (small()) setShowCustomer(false);
      setActive({ ...row, unread_count: 0 });
      setConv(null);
      setActivity(null);
      setList((l) =>
        l
          ? { ...l, rows: l.rows.map((r) => (r.chat_id === row.chat_id ? { ...r, unread_count: 0 } : r)) }
          : l,
      );
      requestConv(row, 0, 30);
      loadActivity(role, row.chat_id)
        .then((d) => setActivity(d))
        .catch(() => setActivity({ events: [], sales: [] }));
    },
    [requestConv, role],
  );

  // Retry a few times, then show a Retry button instead of spinning forever
  const [convFailed, setConvFailed] = useState(false);
  useEffect(() => {
    setConvFailed(false);
    if (active && !conv) {
      const t1 = setTimeout(() => !convRef.current && requestConv(activeRef.current, 0, 30), 1500);
      const t2 = setTimeout(() => !convRef.current && requestConv(activeRef.current, 0, 30), 5000);
      const t3 = setTimeout(() => !convRef.current && setConvFailed(true), 12000);
      return () => [t1, t2, t3].forEach(clearTimeout);
    }
  }, [active, conv, requestConv]);
  const retryConv = useCallback(() => {
    setConvFailed(false);
    const s = sockRef.current?.socket;
    if (s && !s.connected) s.connect();
    requestConv(activeRef.current, 0, 30);
    setTimeout(() => !convRef.current && setConvFailed(true), 12000);
  }, [requestConv]);

  // Opened from another page (Lead Sources, Home)
  useEffect(() => {
    let id = null;
    try {
      id = sessionStorage.getItem("omni.inbox.open");
      sessionStorage.removeItem("omni.inbox.open");
    } catch {}
    if (id)
      loadChat(role, id)
        .then(open)
        .catch(() => setToast({ text: "That conversation isn’t available to you.", error: true }));
  }, [role, open]);

  useEffect(() => {
    loadAccounts(role)
      .then(setAccounts)
      .catch(() => {});
    loadAgents(role).then(setAgents);
  }, [role]);

  // ⌘K / Ctrl+K: search conversations (the app's command palette stays on other pages)
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && searchRef.current) {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current.focus();
        searchRef.current.select();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) searchRef.current.blur();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const send = (type, payload) => sockRef.current?.send(type, payload);

  const onSend = (type, msgCon, replyTo) => {
    const c = convRef.current;
    if (!c?.chatInfo) return;
    const tmp = Math.random().toString(36).slice(2);
    setConv((cur) => (cur ? { ...cur, sending: [...cur.sending, { tmp, msgCon, at: Date.now() }] } : cur));
    send("send_chat_message", {
      type,
      msgCon,
      chatInfo: c.chatInfo,
      replyTo: replyTo?.metaChatId ? { id: replyTo.id, metaChatId: replyTo.metaChatId } : null,
    });
    // Safety net: if the server never answers, drop the spinner
    setTimeout(
      () => setConv((cur) => (cur ? { ...cur, sending: cur.sending.filter((x) => x.tmp !== tmp) } : cur)),
      20000,
    );
  };

  const onStatus = async (status) => {
    const a = activeRef.current;
    if (!a) return;
    setActive((x) => ({ ...x, status }));
    try {
      await setStatus(role, a.chat_id, status);
      setToast({
        text:
          status === "resolved"
            ? "Conversation resolved"
            : status === "pending"
              ? "Marked as pending"
              : "Conversation reopened",
      });
      refreshListSoon();
      refreshActivity();
    } catch (e) {
      setToast({ text: e.message, error: true });
      fetchList();
    }
  };

  const onPriority = async (on) => {
    const a = activeRef.current;
    if (!a) return;
    setActive((x) => ({ ...x, priority: on }));
    try {
      await setPriority(role, a.chat_id, on);
      refreshListSoon();
      refreshActivity();
    } catch (e) {
      setToast({ text: e.message, error: true });
    }
  };

  const onAssign = (agentUid, isOn) => {
    const a = activeRef.current;
    if (!a) return;
    if (isOn) send("unasign_chat_agent", { cId: a.chat_id, aUid: agentUid });
    else send("assign_agent_to_chat", { chatId: a.chat_id, agentUid });
    setTimeout(() => fetchList(), 500);
  };

  const openContacts = () => onNavigate?.("contacts");

  return (
    <main className={`ib-page ${active ? "has-chat" : ""} ${showCustomer && active ? "has-cust" : ""}`}>
      <div className="ib-shell">
        <ChatList
          isAgent={isAgent}
          data={list}
          loading={listLoading}
          params={params}
          setParams={(fn) => {
            setLimit(PAGE);
            setParams(fn);
          }}
          accounts={accounts}
          activeId={active?.chat_id}
          onOpen={open}
          onNew={() => setNewOpen(true)}
          onMore={() => {
            setLimit((l) => l + PAGE);
          }}
          searchRef={searchRef}
        />

        {active ? (
          <ChatView
            role={role}
            isAgent={isAgent}
            chat={active}
            conv={conv?.chatId === active.chat_id ? conv : null}
            convFailed={convFailed}
            onRetryConv={retryConv}
            agents={agents}
            onLoadOlder={() => {
              const c = convRef.current;
              if (!c || c.loadingOlder) return;
              setConv({ ...c, loadingOlder: true });
              requestConv(activeRef.current, c.messages.length, 30);
            }}
            onSend={onSend}
            onStatus={onStatus}
            onPriority={onPriority}
            onAssign={onAssign}
            showCustomer={showCustomer}
            onToggleCustomer={() => setShowCustomer((s) => !s)}
            onBack={() => setActive(null)}
          />
        ) : (
          <section className="ib-chat ib-chat--empty">
            <span className="ib-empty-ico">
              <MessageSquare size={26} />
            </span>
            <b>Select a conversation</b>
            <p>
              Pick a conversation from the list to read and reply. New messages from every connected channel
              show up here in real time.
            </p>
            <button className="ib-btn" onClick={() => setNewOpen(true)}>
              Start a new conversation
            </button>
            <a
              className="ib-classic"
              href={isAgent ? "/agent?page=chat" : "/user?page=inbox"}
              target="_blank"
              rel="noreferrer"
            >
              Open the classic inbox <ExternalLink size={11} />
            </a>
          </section>
        )}

        {active && showCustomer && (
          <CustomerPanel
            role={role}
            isAgent={isAgent}
            me={list?.me}
            chat={active}
            conv={conv?.chatId === active.chat_id ? conv : null}
            activity={activity}
            onReloadActivity={refreshActivity}
            send={(type, payload) => {
              send(type, payload);
              if (type === "save_chat_note" || type === "delete_chat_note") setTimeout(refreshActivity, 600);
            }}
            onClose={() => setShowCustomer(false)}
            onOpenContacts={openContacts}
          />
        )}
      </div>

      {offline && (
        <div className="ib-offline" role="status">
          <WifiOff size={14} /> Reconnecting… new messages will appear when the connection is back.
        </div>
      )}

      {newOpen && (
        <NewConversation
          role={role}
          send={send}
          lastError={lastError}
          onClose={() => setNewOpen(false)}
          onOpenChat={async (target) => {
            if (target.chat_id) {
              setNewOpen(false);
              open(target);
              return;
            }
            // A chat we just created: find it once the list has it
            setNewOpen(false);
            for (let i = 0; i < 6; i++) {
              const d = await loadChats(role, { q: target.phone, limit: 5 }).catch(() => null);
              const row =
                d?.rows?.find((r) => String(r.chat_id).startsWith(target.startsWith)) || d?.rows?.[0];
              if (row) {
                open(row);
                fetchList();
                return;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          }}
        />
      )}

      {toast && (
        <div className={`ib-toast ${toast.error ? "is-error" : ""}`} role="status">
          {toast.error && <AlertTriangle size={14} />}
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}
    </main>
  );
}

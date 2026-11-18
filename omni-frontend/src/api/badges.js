import { io } from "socket.io-client";
import { api, tokenFor } from "./session";

// Live sidebar counters
export function watchBadges(role, onChange) {
  const counts = { inbox: 0, channels: 0 };
  const push = (patch) => {
    Object.assign(counts, patch);
    onChange({ ...counts });
  };

  const socket = io({
    path: "/socket.io",
    query: { token: tokenFor(role) },
    transports: ["websocket", "polling"],
  });

  let pending = null;
  const askUnread = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      socket.emit("message", {
        type: "get_chat_list",
        payload: { unreadOnly: true, limit: 1, offset: 0 },
      });
    }, 400);
  };

  socket.on("connect", askUnread);
  socket.on("chat_list", (data) => {
    if (typeof data?.total === "number") push({ inbox: data.total });
  });
  socket.on("request_update_chat_list", askUnread);

  // The tab was in the background: the socket may have missed updates
  const onVisible = () => {
    if (!document.hidden) askUnread();
  };
  document.addEventListener("visibilitychange", onVisible);

  let timer = null;
  const loadChannels = async () => {
    try {
      const res = await api("/api/qr_pairing/alerts", role);
      if (res?.success && Array.isArray(res.data)) push({ channels: res.data.length });
    } catch {}
  };
  if (role === "owner") {
    loadChannels();
    timer = setInterval(loadChannels, 60000);
  }

  return () => {
    clearTimeout(pending);
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    socket.close();
  };
}

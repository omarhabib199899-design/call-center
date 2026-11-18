import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar/Sidebar.jsx";
import ClassicFrame from "./components/ClassicFrame.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import AgentChannels from "./pages/AgentChannels/AgentChannels.jsx";
import Home from "./pages/Home/Home.jsx";
import Campaigns from "./pages/Campaigns/Campaigns.jsx";
import LeadSources from "./pages/LeadSources/LeadSources.jsx";
import Inbox from "./pages/Inbox/Inbox.jsx";
import { NAV, allLeaves, legacyUrl, itemForUrl, visibleFor } from "./components/Sidebar/navConfig.js";
import { detectRole, loadMe, loginUrl, logout } from "./api/session.js";
import { watchBadges } from "./api/badges.js";

const role = detectRole();

// Leaves with the name of the menu group they sit under (for the search list)
function searchItems(r) {
  const out = [];
  NAV.filter((g) => visibleFor(r, g)).forEach((g) =>
    g.items
      .filter((i) => visibleFor(r, i) && !i.soon)
      .forEach((i) => {
        if (i.children) i.children.forEach((c) => out.push({ ...c, group: i.label }));
        else out.push({ ...i, group: g.title || "" });
      }),
  );
  return out;
}

export default function App() {
  // Not signed in to the classic panel: go sign in there first
  useEffect(() => {
    if (!role) location.href = loginUrl("owner");
  }, []);

  const leaves = useMemo(() => (role ? allLeaves(role) : []), []);
  const startId = () => {
    const h = decodeURIComponent(location.hash.slice(1));
    return leaves.find((l) => l.id === h)?.id || leaves[0]?.id;
  };

  const [activeId, setActiveId] = useState(startId);
  const [frameSrc, setFrameSrc] = useState(() => {
    const item = leaves.find((l) => l.id === activeId);
    return item && !item.native ? legacyUrl(item, role) : null;
  });
  // The classic app stays loaded after its first use, so coming back to it is instant
  const [classicSrc, setClassicSrc] = useState(frameSrc);
  useEffect(() => {
    if (frameSrc) setClassicSrc(frameSrc);
  }, [frameSrc]);
  const [user, setUser] = useState({ name: "…", roleLabel: "" });
  const [badges, setBadges] = useState({});
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (!role) return;
    loadMe(role)
      .then(setUser)
      .catch((e) => {
        if (e.signedOut) location.href = loginUrl(role);
      });
    return watchBadges(role, setBadges);
  }, []);

  const navigate = useCallback((item) => {
    if (typeof item === "string") item = leaves.find((l) => l.id === item);
    if (!item) return;
    const url = item.native ? null : legacyUrl(item, role);
    if (!item.native && !url) return;
    setActiveId(item.id);
    setFrameSrc(url);
    history.replaceState(null, "", `#${item.id}`);
  }, []);

  // Back/forward or a pasted link with #page
  useEffect(() => {
    const onHash = () => {
      const item = leaves.find((l) => l.id === decodeURIComponent(location.hash.slice(1)));
      if (item && item.id !== activeId) navigate(item);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [leaves, activeId, navigate]);

  // The user moved around inside the classic page: follow the highlight
  const onFrameUrl = useCallback((href) => {
    const item = itemForUrl(href, role);
    if (item) {
      setActiveId(item.id);
      history.replaceState(null, "", `#${item.id}`);
    }
  }, []);

  const onSignedOut = useCallback(() => {
    location.href = loginUrl(role);
  }, []);

  const activeItem = leaves.find((l) => l.id === activeId);
  const items = useMemo(() => (role ? searchItems(role) : []), []);

  if (!role) return null;

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <Sidebar
        activeId={activeId}
        onNavigate={navigate}
        role={role}
        user={user}
        workspace={{ name: "Omni", subtitle: user.email || "" }}
        badges={badges}
        onSearch={() => setSearchOpen(true)}
        onLogout={() => logout(role)}
        classicUrl={role === "agent" ? "/agent" : "/user"}
      />
      {activeItem?.native === "home" ? (
        <Home role={role} user={user} badges={badges} onNavigate={navigate} />
      ) : activeItem?.native === "campaigns" ? (
        <Campaigns role={role} onNavigate={navigate} />
      ) : activeItem?.native === "inbox" ? (
        <Inbox role={role} onNavigate={navigate} />
      ) : activeItem?.native === "lead-sources" ? (
        <LeadSources role={role} onNavigate={navigate} />
      ) : activeItem?.native === "agent-channels" ? (
        <AgentChannels role={role} onNavigate={navigate} />
      ) : frameSrc ? null : (
        <main style={{ flex: 1 }} />
      )}
      {classicSrc && (
        <ClassicFrame
          src={classicSrc}
          hidden={!frameSrc}
          onUrlChange={onFrameUrl}
          onSignedOut={onSignedOut}
        />
      )}
      <CommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={items}
        onPick={navigate}
      />
    </div>
  );
}

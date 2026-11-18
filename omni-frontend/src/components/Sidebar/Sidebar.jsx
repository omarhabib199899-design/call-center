import { useEffect, useRef, useState } from "react";
import {
  ChevronsUpDown,
  PanelLeft,
  Search,
  ChevronDown,
  Ellipsis,
  LogOut,
  ExternalLink,
  Sun,
  Moon,
} from "lucide-react";
import { getTheme, applyTheme } from "../../theme.js";
import { NAV, visibleFor } from "./navConfig";
import "./Sidebar.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function Badge({ value, tone }) {
  if (!value) return null;
  return (
    <span className={`sb-badge ${tone === "warn" ? "sb-badge--warn" : ""}`}>
      {value > 99 ? "99+" : value}
    </span>
  );
}

// Omni sidebar
export default function Sidebar({
  activeId,
  onNavigate = () => {},
  role = "owner",
  user = { name: "", roleLabel: "" },
  workspace = { name: "Omni", subtitle: "" },
  badges = {},
  onSearch = () => {},
  onLogout = () => {},
  classicUrl = "/user",
}) {
  const [collapsed, setCollapsed] = useState(() => {
    // Small screens start collapsed so the page keeps its width
    if (window.innerWidth < 900) return true;
    try {
      return localStorage.getItem("omni.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [openGroups, setOpenGroups] = useState({});
  const [tip, setTip] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme);
  const asideRef = useRef(null);

  useEffect(() => {
    if (window.innerWidth >= 900) {
      try {
        localStorage.setItem("omni.sidebar.collapsed", collapsed ? "1" : "0");
      } catch {}
    }
    setTip(null);
  }, [collapsed]);

  // Open the group that holds the current page
  useEffect(() => {
    NAV.forEach((g) =>
      g.items.forEach((i) => {
        if (i.children?.some((c) => c.id === activeId)) {
          setOpenGroups((o) => (o[i.id] ? o : { ...o, [i.id]: true }));
        }
      }),
    );
  }, [activeId]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onSearch();
      }
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSearch]);

  const showTip = (e, item) => {
    if (!collapsed) return;
    const box = e.currentTarget.getBoundingClientRect();
    const top = box.top - asideRef.current.getBoundingClientRect().top + box.height / 2;
    setTip({ label: item.soon ? `${item.label} · soon` : item.label, badge: badges[item.badgeKey], top });
  };
  const hideTip = () => setTip(null);

  const renderItem = (item) => {
    const Icon = item.icon;
    const kids = item.children ? item.children.filter((c) => visibleFor(role, c)) : null;
    const hasChildren = !!kids?.length;
    const open = hasChildren && openGroups[item.id];
    const childActive = hasChildren && kids.some((c) => c.id === activeId);
    const active = item.id === activeId || (collapsed && childActive);

    const handleClick = () => {
      if (item.soon) return;
      if (hasChildren && !collapsed) setOpenGroups((g) => ({ ...g, [item.id]: !g[item.id] }));
      else if (hasChildren) onNavigate(kids[0]);
      else onNavigate(item);
    };

    return (
      <li key={item.id}>
        <button
          type="button"
          className={`sb-item ${active ? "is-active" : ""} ${childActive && !collapsed ? "has-active" : ""} ${item.soon ? "is-soon" : ""}`}
          aria-current={active ? "page" : undefined}
          aria-expanded={hasChildren && !collapsed ? !!open : undefined}
          aria-disabled={item.soon || undefined}
          aria-label={collapsed ? item.label : undefined}
          onClick={handleClick}
          onMouseEnter={(e) => showTip(e, item)}
          onMouseLeave={hideTip}
          onFocus={(e) => showTip(e, item)}
          onBlur={hideTip}
        >
          <Icon className="sb-icon" size={17} strokeWidth={2} aria-hidden="true" />
          {!collapsed && <span className="sb-label">{item.label}</span>}
          {!collapsed && item.soon && <span className="sb-soon">Soon</span>}
          {!collapsed && <Badge value={badges[item.badgeKey]} tone={item.badgeTone} />}
          {!collapsed && hasChildren && (
            <ChevronDown className={`sb-chevron ${open ? "" : "is-closed"}`} size={14} aria-hidden="true" />
          )}
          {collapsed && badges[item.badgeKey] ? (
            <span className={`sb-dot ${item.badgeTone === "warn" ? "sb-dot--warn" : ""}`} />
          ) : null}
        </button>

        {hasChildren && open && !collapsed && (
          <ul className="sb-sub">
            {kids.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`sb-subitem ${c.id === activeId ? "is-active" : ""}`}
                  aria-current={c.id === activeId ? "page" : undefined}
                  onClick={() => onNavigate(c)}
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  const initials =
    (user.name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <aside ref={asideRef} className={`sb ${collapsed ? "sb--collapsed" : ""}`} aria-label="Main navigation">
      <div className="sb-head">
        {collapsed && (
          <button
            type="button"
            className="sb-iconbtn"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
        )}
        <div className="sb-workspace">
          <span className="sb-logo">{(workspace.name || "O")[0]}</span>
          {!collapsed && (
            <>
              <span className="sb-ws-text">
                <span className="sb-ws-name">{workspace.name}</span>
                {workspace.subtitle && <span className="sb-ws-sub">{workspace.subtitle}</span>}
              </span>
              <ChevronsUpDown className="sb-ws-chev" size={14} aria-hidden="true" />
            </>
          )}
        </div>
        {!collapsed && (
          <button
            type="button"
            className="sb-iconbtn"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {collapsed ? (
        <button type="button" className="sb-item sb-item--icon" onClick={onSearch} aria-label="Search">
          <Search className="sb-icon" size={17} aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className="sb-search" onClick={onSearch}>
          <Search size={15} aria-hidden="true" />
          <span className="sb-search-text">Search or jump to…</span>
          <kbd className="sb-kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      )}

      <nav className="sb-nav">
        {NAV.filter((g) => visibleFor(role, g)).map((group, gi) => {
          const items = group.items.filter((i) => visibleFor(role, i));
          if (!items.length) return null;
          return (
            <div key={gi} className="sb-group">
              {group.title && !collapsed && <p className="sb-section">{group.title}</p>}
              {group.title && collapsed && <hr className="sb-sep" />}
              <ul>{items.map(renderItem)}</ul>
            </div>
          );
        })}
      </nav>

      <div className="sb-foot">
        <span className="sb-avatar" aria-hidden="true">
          {initials}
        </span>
        {!collapsed && (
          <span className="sb-user">
            <span className="sb-user-name">{user.name}</span>
            <span className="sb-user-role">{user.roleLabel}</span>
          </span>
        )}
        <button
          type="button"
          className="sb-iconbtn"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={() => {
            const t = theme === "dark" ? "light" : "dark";
            applyTheme(t);
            setTheme(t);
          }}
        >
          {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="sb-iconbtn"
          aria-label="Account menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="sb-menu" role="menu">
            <a role="menuitem" className="sb-menu-item" href={classicUrl}>
              <ExternalLink size={14} aria-hidden="true" /> Classic panel
            </a>
            <button type="button" role="menuitem" className="sb-menu-item" onClick={onLogout}>
              <LogOut size={14} aria-hidden="true" /> Log out
            </button>
          </div>
        )}
      </div>

      {collapsed && tip && (
        <div className="sb-tip" role="tooltip" style={{ top: tip.top }}>
          <span>{tip.label}</span>
          {tip.badge ? <span className="sb-badge sb-badge--sm">{tip.badge}</span> : null}
        </div>
      )}
    </aside>
  );
}

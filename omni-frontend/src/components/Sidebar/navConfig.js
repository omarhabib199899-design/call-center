import {
  LayoutDashboard,
  Inbox,
  Phone,
  Users,
  Megaphone,
  Workflow,
  ChartColumn,
  Plug,
  Code,
  Settings,
  KanbanSquare,
  UserCog,
  ListChecks,
  Link2,
  MessageSquareCode,
  BadgePercent,
  Bell,
} from "lucide-react";

// Sidebar structure
export const NAV = [
  {
    items: [
      {
        id: "home",
        label: "Home",
        icon: LayoutDashboard,
        native: "home",
        page: "dashboard",
        roles: ["owner"],
      },
      {
        id: "inbox",
        label: "Inbox",
        icon: Inbox,
        native: "inbox",
        page: "inbox",
        agentPage: "chat",
        badgeKey: "inbox",
      },
      { id: "kanban", label: "Kanban", icon: KanbanSquare, page: "kabnan", roles: ["owner"] },
      { id: "calls", label: "Calls", icon: Phone, page: "wa-call-logs", roles: ["owner"] },
      { id: "contacts", label: "Contacts", icon: Users, page: "phonebook", roles: ["owner"] },
      { id: "my-tasks", label: "My tasks", icon: ListChecks, agentPage: "my-task", roles: ["agent"] },
    ],
  },
  {
    title: "Engage",
    roles: ["owner"],
    items: [
      {
        id: "campaigns",
        label: "Campaigns",
        icon: Megaphone,
        children: [
          { id: "omni-campaigns", label: "All campaigns", native: "campaigns" },
          { id: "send-campaign", label: "Send campaign", page: "send-campaign" },
          { id: "campaign-dashboard", label: "Campaign dashboard", page: "campaign-dashboard" },
          { id: "qr-bulk-campaign", label: "WhatsApp QR bulk", page: "qr-bulk-campaign" },
          { id: "meta-templates", label: "Meta templates", page: "create-meta-template" },
        ],
      },
      {
        id: "automation",
        label: "Automation",
        icon: Workflow,
        children: [
          { id: "flows", label: "Flows", page: "automation-flows" },
          { id: "chatbots", label: "Chatbots", page: "wa-chatbot" },
          { id: "insta-dm-bot", label: "Instagram DM bot", page: "insta-autoreply" },
          { id: "messenger-bot", label: "Messenger chatbot", page: "messenger-chatbot" },
          { id: "call-flows", label: "Call flows", page: "create-call-flow" },
          { id: "wa-forms", label: "WhatsApp forms", page: "wa-forms" },
          { id: "comment-dm", label: "Comment to DM", page: "insta-comment-autoreply" },
          { id: "webhook-automation", label: "Webhook automation", page: "webhook-automation" },
          { id: "wa-warmer", label: "WhatsApp warmer", page: "wa-warmer" },
        ],
      },
      { id: "reports", label: "Reports", icon: ChartColumn, soon: true },
    ],
  },
  {
    title: "Team",
    roles: ["owner"],
    items: [
      { id: "agents", label: "Agents", icon: UserCog, page: "agent-login" },
      { id: "agent-tasks", label: "Agent tasks", icon: ListChecks, page: "agent-task" },
      {
        id: "agent-accounts",
        label: "Agents & Channels",
        icon: Link2,
        native: "agent-channels",
        href: "/agent-numbers.html",
      },
    ],
  },
  {
    title: "Configure",
    roles: ["owner"],
    items: [
      {
        id: "channels",
        label: "Channels",
        icon: Plug,
        badgeKey: "channels",
        badgeTone: "warn",
        children: [
          { id: "wa-qr-connect", label: "WhatsApp by QR", page: "wa-qr-connect" },
          { id: "wa-meta-manual", label: "Meta WhatsApp", page: "wa-meta-manual" },
          { id: "link-instagram", label: "Instagram", page: "link-instagram" },
          { id: "link-messenger", label: "Messenger", page: "link-messenger" },
          { id: "telegram-sessions", label: "Telegram", page: "telegram-sessions" },
          { id: "setup-wa-call", label: "WhatsApp calls", page: "setup-wa-call" },
        ],
      },
      {
        id: "developers",
        label: "Developers",
        icon: Code,
        children: [
          { id: "wa-qr-rest-api", label: "REST API", page: "wa-qr-rest-api" },
          { id: "conversational-api", label: "Conversational API", page: "conversational-api" },
          { id: "template-api", label: "Template API", page: "template-api" },
          { id: "api-dashboard", label: "API dashboard", page: "api-dashboard" },
          { id: "manage-webhook", label: "Webhooks", page: "manage-webhook" },
          { id: "webhook-logs", label: "Webhook logs", page: "webhook-logs" },
        ],
      },
      { id: "chat-widget", label: "Chat widget", icon: MessageSquareCode, page: "chat-widget" },
      {
        id: "ad-sources",
        label: "Ad sources",
        icon: BadgePercent,
        native: "lead-sources",
        href: "/ad-sources.html",
        roles: ["owner"],
      },
      { id: "web-notifications", label: "Notifications", icon: Bell, page: "web-notificaion" },
      { id: "settings", label: "Settings", icon: Settings, soon: true },
    ],
  },
];

export function visibleFor(role, entry) {
  return !entry.roles || entry.roles.includes(role);
}

// Every clickable leaf, in menu order
export function allLeaves(role) {
  const out = [];
  NAV.filter((g) => visibleFor(role, g)).forEach((g) =>
    g.items
      .filter((i) => visibleFor(role, i))
      .forEach((i) =>
        i.children ? i.children.forEach((c) => out.push({ ...c, parent: i.id })) : out.push(i),
      ),
  );
  return out.filter((l) => !l.soon);
}

// URL of the classic page behind a menu item, or null
export function legacyUrl(item, role) {
  if (item.href) return item.href;
  if (role === "agent") return item.agentPage ? `/agent?page=${item.agentPage}` : null;
  return item.page ? `/user?page=${item.page}` : null;
}

// Find the menu item for a classic URL (to keep the highlight in sync)
export function itemForUrl(url, role) {
  try {
    const u = new URL(url, location.origin);
    const page = u.searchParams.get("page");
    return (
      allLeaves(role).find((l) => {
        if (l.href) return u.pathname === l.href;
        return role === "agent" ? l.agentPage === page : l.page === page;
      }) || null
    );
  } catch {
    return null;
  }
}

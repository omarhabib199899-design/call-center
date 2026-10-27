/**
 * [CUSTOM] Phone / Business Suite -> inbox read sync.
 *
 * When someone reads a chat outside the platform — on the WhatsApp phone, in
 * Meta Business Suite or in the Instagram app — clear that chat's unread
 * counter in the inbox too. (The other direction, inbox -> channel, is
 * helper/markRead.js.)
 *
 *   WhatsApp (QR)  Baileys "chats.update" with unreadCount 0. WhatsApp sends
 *                  this to linked devices whenever the chat is read on the
 *                  phone or another linked device. Instant.
 *   Messenger      No webhook exists for "the Page read this", so the Page's
 *                  conversations are polled (unread_count) every
 *                  READ_SYNC_SECONDS (default 60), only for Pages that have
 *                  unread chats in the inbox.
 *   Instagram      Same poll, for accounts linked through a Facebook Page.
 *                  If Meta does not return unread_count for Instagram, the
 *                  account is skipped quietly.
 *
 * Only ever lowers unread_count to 0; never marks anything unread. Every
 * failure is caught; nothing here can affect message delivery.
 */

const { query } = require("../database/dbpromise");
const fetch = require("node-fetch");

const GRAPH = "https://graph.facebook.com/v21.0";
// A conversation must be at least this fresh compared with our latest
// incoming message, so a Graph response that has not caught up with a brand
// new message cannot clear it.
const CLOCK_SLACK_SECONDS = 5;

function log(...args) {
  console.log("[readSync]", ...args);
}

function notify(uid) {
  try {
    const { getConnectionsByUid, sendToSocket } = require("../socket");
    (getConnectionsByUid(uid, true) || []).forEach((s) =>
      sendToSocket(s?.socketId, {}, "request_update_chat_list"),
    );
  } catch (e) {}
}

async function clearUnread({ uid, chatId }) {
  const res = await query(
    // updatedAt = updatedAt: the column auto-updates on any UPDATE and the
    // chat list is sorted by it; a read must not move the chat to the top.
    `UPDATE beta_chats SET unread_count = 0, updatedAt = updatedAt
     WHERE chat_id = ? AND uid = ? AND unread_count > 0`,
    [chatId, uid],
  );
  return (res?.affectedRows || 0) > 0;
}

// ─── WhatsApp (QR) ───────────────────────────────────────────────────────
async function jidToNumber(sock, jid) {
  let id = String(jid || "");
  if (id.endsWith("@lid")) {
    try {
      id = (await sock?.signalRepository?.lidMapping?.getPNForLID?.(id)) || "";
    } catch (e) {
      id = "";
    }
  }
  if (!id.endsWith("@s.whatsapp.net")) return null; // groups, status, unknown
  const m = id.match(/^(\d+)/);
  return m ? m[1] : null;
}

/** Baileys "chats.update" handler. Never throws. */
async function onWhatsAppChatsUpdate({ updates, uid, sessionId, sock }) {
  try {
    const read = (updates || []).filter((u) => u?.id && u.unreadCount === 0);
    if (!read.length || !uid) return;
    log(`whatsapp ${sessionId}: ${read.length} read signal(s)`);

    const [instance] = await query(
      `SELECT number FROM instance WHERE uniqueId = ? LIMIT 1`,
      [sessionId],
    );
    if (!instance?.number) return;

    let changed = 0;
    for (const u of read) {
      const customer = await jidToNumber(sock, u.id);
      if (!customer) {
        if (String(u.id).endsWith("@lid")) {
          log(`whatsapp ${sessionId}: no phone number known for ${u.id}`);
        }
        continue;
      }
      const chatId = `${instance.number}_${customer}_${uid}`;
      const ok = await clearUnread({ uid, chatId });
      if (ok) changed += 1;
      log(
        `whatsapp ${sessionId}: read on phone ${u.id} -> ${chatId} ` +
          (ok ? "cleared" : "(no unread chat with this id)"),
      );
    }
    if (changed) {
      log(`whatsapp ${sessionId}: ${changed} chat(s) read on the phone`);
      notify(uid);
    }
  } catch (err) {
    log(`whatsapp ${sessionId}:`, err?.message || err);
  }
}

// ─── Messenger / Instagram poll ──────────────────────────────────────────
const igUnsupported = new Set(); // page ids where Instagram unread_count fails

async function lastIncomingTs({ uid, chatId }) {
  const [row] = await query(
    `SELECT MAX(timestamp) AS ts FROM beta_conversation
     WHERE chat_id = ? AND uid = ? AND route = 'INCOMING'`,
    [chatId, uid],
  );
  return Number(row?.ts) || 0;
}

async function fetchConversations({ pageId, token, platform }) {
  const url =
    `${GRAPH}/${pageId}/conversations?platform=${platform}` +
    `&fields=participants,unread_count,updated_time&limit=50` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (data?.error) throw new Error(data.error.message || "Graph error");
  return data?.data || [];
}

async function syncPage({ uid, pageId, token, platform, chatPrefix, selfIds }) {
  const convs = await fetchConversations({ pageId, token, platform });
  let changed = 0;

  for (const c of convs) {
    if (typeof c?.unread_count !== "number" || c.unread_count !== 0) continue;
    const updated = Date.parse(c.updated_time) / 1000 || 0;

    const others = (c.participants?.data || []).filter(
      (p) => p?.id && !selfIds.includes(String(p.id)),
    );
    for (const p of others) {
      const chatId = `${chatPrefix}${p.id}`;
      const lastIn = await lastIncomingTs({ uid, chatId });
      if (lastIn && updated + CLOCK_SLACK_SECONDS < lastIn) continue;
      if (await clearUnread({ uid, chatId })) changed += 1;
    }
  }
  return changed;
}

async function pollOnce() {
  // Messenger: only Pages that currently have unread chats in the inbox.
  const msgr = await query(
    `SELECT DISTINCT uid,
       JSON_UNQUOTE(JSON_EXTRACT(origin_instance_id, '$.id')) AS page_id
     FROM beta_chats WHERE origin = 'messenger' AND unread_count > 0`,
    [],
  );
  for (const row of msgr) {
    if (!row?.page_id) continue;
    try {
      const [acc] = await query(
        `SELECT page_access_token FROM messenger_accounts
         WHERE page_id = ? AND uid = ? LIMIT 1`,
        [row.page_id, row.uid],
      );
      if (!acc?.page_access_token) continue;
      const n = await syncPage({
        uid: row.uid,
        pageId: row.page_id,
        token: acc.page_access_token,
        platform: "messenger",
        chatPrefix: "msng_",
        selfIds: [String(row.page_id)],
      });
      if (n) {
        log(`messenger page ${row.page_id}: ${n} chat(s) read elsewhere`);
        notify(row.uid);
      }
    } catch (err) {
      log(`messenger page ${row.page_id}:`, err?.message || err);
    }
  }

  // Instagram (Page-linked accounts only).
  const ig = await query(
    `SELECT DISTINCT uid,
       JSON_UNQUOTE(JSON_EXTRACT(origin_instance_id, '$.id')) AS ig_id
     FROM beta_chats WHERE origin = 'instagram' AND unread_count > 0`,
    [],
  );
  for (const row of ig) {
    if (!row?.ig_id) continue;
    let acc = null;
    try {
      [acc] = await query(
        `SELECT * FROM instagram_accounts WHERE user_id = ? AND uid = ? LIMIT 1`,
        [row.ig_id, row.uid],
      );
      if (!acc?.access_token || !acc?.page_id) continue;
      if (String(acc.token_type || "").toLowerCase() !== "page") continue;
      if (igUnsupported.has(acc.page_id)) continue;
      const n = await syncPage({
        uid: row.uid,
        pageId: acc.page_id,
        token: acc.access_token,
        platform: "instagram",
        chatPrefix: "ig_",
        selfIds: [String(acc.user_id), String(acc.ig_graph_id), String(acc.page_id)],
      });
      if (n) {
        log(`instagram @${acc.username}: ${n} chat(s) read elsewhere`);
        notify(row.uid);
      }
    } catch (err) {
      if (/unread_count|nonexisting field/i.test(err?.message || "")) {
        igUnsupported.add(acc?.page_id);
      }
      log(`instagram ${row.ig_id}:`, err?.message || err);
    }
  }
}

let started = false;
let running = false;

/** Start the Messenger/Instagram poll. Safe to call more than once. */
function start() {
  if (started) return;
  started = true;
  const seconds = Math.max(30, Number(process.env.READ_SYNC_SECONDS) || 60);
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce();
    } catch (err) {
      log("poll:", err?.message || err);
    }
    try {
      // [CUSTOM] name old Messenger/Instagram chats a few at a time
      await require("./contactNames").backfill(15);
    } catch (err) {
      log("names:", err?.message || err);
    }
    try {
      // [CUSTOM] strip password hashes etc. from old chat assignments
      await require("./agentInstances").scrubAssignedAgents(300);
    } catch (err) {
      log("agents:", err?.message || err);
    } finally {
      running = false;
    }
  }, seconds * 1000);
  log(`started (every ${seconds}s)`);
}

module.exports = { start, onWhatsAppChatsUpdate, pollOnce };

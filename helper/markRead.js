/**
 * [CUSTOM] Tell the channel that the customer's messages were read.
 *
 * Stock WhatsCRM only clears its own unread counter (beta_chats.unread_count).
 * It never told WhatsApp / Facebook / Instagram, so on the phone and in Meta
 * Business Suite every chat stayed "unread" and customers never saw blue ticks,
 * even after an agent had opened the chat and replied.
 *
 * markChatRead() is called when an agent opens a chat that has unread messages
 * and after every successful reply. It is fire-and-forget: every failure is
 * caught and logged, and nothing here can block or break the inbox.
 *
 *   qr        (WhatsApp, Baileys)  read receipts + mark the chat read on the phone
 *   meta      (WhatsApp Cloud API) status: "read" on the latest incoming message
 *   messenger (Facebook Page)      sender_action: "mark_seen"
 *   instagram (DMs)                sender_action: "mark_seen"
 */

const { query } = require("../database/dbpromise");
const fetch = require("node-fetch");

const GRAPH_VERSION = "v21.0";
// How many recent incoming WhatsApp (QR) messages to acknowledge per call.
const QR_READ_BATCH = 20;

function log(...args) {
  console.log("[markRead]", ...args);
}

function parseJson(str) {
  try {
    return typeof str === "string" ? JSON.parse(str) : str || null;
  } catch {
    return null;
  }
}

async function latestIncoming({ uid, chatId, limit = 1 }) {
  return query(
    `SELECT metaChatId, timestamp FROM beta_conversation
     WHERE chat_id = ? AND uid = ? AND route = 'INCOMING'
       AND metaChatId IS NOT NULL AND metaChatId <> ''
     ORDER BY timestamp DESC LIMIT ?`,
    [chatId, uid, limit],
  );
}

// ─── WhatsApp via QR (Baileys) ───────────────────────────────────────────
async function markQrRead({ uid, chat }) {
  // chat_id = <ourNumber>_<customerNumber>_<uid>
  const ourNumber = String(chat.chat_id || "").split("_")[0];
  if (!ourNumber) return;

  const [instance] = await query(
    `SELECT uniqueId FROM instance WHERE number = ? AND uid = ? LIMIT 1`,
    [ourNumber, uid],
  );
  if (!instance?.uniqueId) return;

  const { getSession } = require("./addon/qr");
  const sock = getSession(instance.uniqueId);
  if (!sock) return;

  const isGroup = String(chat.sender_mobile || "").includes("-");
  const jid = `${chat.sender_mobile}@${isGroup ? "g.us" : "s.whatsapp.net"}`;

  const rows = await latestIncoming({
    uid,
    chatId: chat.chat_id,
    limit: QR_READ_BATCH,
  });
  if (!rows.length) return;

  const keys = rows.map((r) => ({
    remoteJid: jid,
    id: r.metaChatId,
    fromMe: false,
  }));

  // Blue ticks for the customer.
  await sock.readMessages(keys);

  // Clear the unread badge on the phone / WhatsApp Business app as well.
  // Needs app-state keys, which a freshly linked session may not have yet.
  try {
    await sock.chatModify(
      {
        markRead: true,
        lastMessages: [
          {
            key: keys[0],
            messageTimestamp: Number(rows[0].timestamp) || undefined,
          },
        ],
      },
      jid,
    );
  } catch (err) {
    log("qr chatModify skipped:", err?.message || err);
  }
}

// ─── WhatsApp Cloud API ──────────────────────────────────────────────────
async function markMetaRead({ uid, chat }) {
  const [api] = await query(`SELECT * FROM meta_api WHERE uid = ? LIMIT 1`, [
    uid,
  ]);
  if (!api?.access_token || !api?.business_phone_number_id) return;

  const [last] = await latestIncoming({ uid, chatId: chat.chat_id });
  if (!last) return;

  // Marking the latest message read also marks every earlier one.
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${api.business_phone_number_id}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.access_token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: last.metaChatId,
      }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (data?.error) log("meta:", data.error.message);
}

// ─── Facebook Messenger ──────────────────────────────────────────────────
async function markMessengerRead({ uid, chat }) {
  const pageId = parseJson(chat.origin_instance_id)?.id;
  if (!pageId) return;

  const [account] = await query(
    `SELECT page_access_token FROM messenger_accounts
     WHERE page_id = ? AND uid = ? LIMIT 1`,
    [pageId, uid],
  );
  if (!account?.page_access_token) return;

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(
      account.page_access_token,
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: chat.sender_mobile },
        sender_action: "mark_seen",
      }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (data?.error) log("messenger:", data.error.message);
}

// ─── Instagram DMs ───────────────────────────────────────────────────────
async function markInstagramRead({ uid, chat }) {
  const myIgUserId = parseJson(chat.origin_instance_id)?.id;
  if (!myIgUserId) return;

  const [igAccount] = await query(
    `SELECT * FROM instagram_accounts WHERE user_id = ? AND uid = ? LIMIT 1`,
    [myIgUserId, uid],
  );
  if (!igAccount?.access_token) return;

  const url = require("./instaViaFacebook").messagesUrl(
    igAccount,
    GRAPH_VERSION,
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: chat.sender_mobile },
      sender_action: "mark_seen",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.error) log("instagram:", data.error.message);
}

const HANDLERS = {
  qr: markQrRead,
  meta: markMetaRead,
  messenger: markMessengerRead,
  instagram: markInstagramRead,
};

/**
 * Mark a chat as read on its channel. `chat` is a beta_chats row (needs
 * chat_id, origin, origin_instance_id, sender_mobile). Never throws.
 */
async function markChatRead({ uid, chat }) {
  try {
    if (!uid || !chat?.chat_id) return;
    const handler = HANDLERS[String(chat.origin || "").toLowerCase()];
    if (!handler) return;
    await handler({ uid, chat });
  } catch (err) {
    log(`${chat?.origin} ${chat?.chat_id}:`, err?.message || err);
  }
}

/** Same as markChatRead but looks the chat up first. Never throws. */
async function markChatReadById({ uid, chatId }) {
  try {
    const [chat] = await query(
      `SELECT chat_id, origin, origin_instance_id, sender_mobile
       FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
      [chatId, uid],
    );
    if (chat) await markChatRead({ uid, chat });
  } catch (err) {
    log(`lookup ${chatId}:`, err?.message || err);
  }
}

module.exports = { markChatRead, markChatReadById };

/**
 * [CUSTOM] Import the message history WhatsApp sends to a newly linked device.
 *
 * Right after a number is (re)linked, WhatsApp pushes recent chats and
 * messages to the new device through Baileys' "messaging-history.set" event.
 * Stock WhatsCRM ignored that event, so every re-linked number started with an
 * empty inbox.
 *
 * What this does:
 *  - keeps one-to-one chats only (no groups, no status/broadcast)
 *  - keeps messages from the last QR_HISTORY_DAYS days (default 30)
 *  - stores each message once (beta_conversation.metaChatId is checked first)
 *  - stores the real send time, so old messages sort in their right place
 *  - creates missing chats with unread_count = 0 and never touches the
 *    unread counter of existing chats
 *  - never triggers the chatbot, automations or notifications
 *
 * How much history WhatsApp sends is decided by WhatsApp, not by us: usually
 * the recent messages of recent chats. QR_FULL_HISTORY=true asks for more.
 */

const { query } = require("../../../database/dbpromise");
const {
  processBaileysMsg,
  getChatId,
  toUnixSeconds,
} = require("./processThings");

const SUPPORTED = [
  "conversation",
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "documentWithCaptionMessage",
  "contactMessage",
  "locationMessage",
];

// One import at a time per session; history arrives in several chunks.
const queues = new Map();

function log(sessionId, ...args) {
  console.log(`[WA ${sessionId}] history:`, ...args);
}

function historyDays() {
  const n = Number(process.env.QR_HISTORY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = String(str).match(/^(\d+)(?=:|@)/);
  return match ? match[1] : null;
}

function unwrap(message) {
  // ephemeral / view-once wrappers hide the real content one level down
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message
  );
}

async function importBatch({ data, uid, sessionId, getSession, normalizeMessageJid }) {
  const messages = data?.messages || [];
  if (!messages.length) return;

  const sock = getSession(sessionId);
  const [instance] = await query(
    `SELECT number FROM instance WHERE uniqueId = ? LIMIT 1`,
    [sessionId],
  );
  const instanceNumber =
    instance?.number || extractPhoneNumber(sock?.user?.id);
  if (!instanceNumber) {
    log(sessionId, "skipped: number not known yet");
    return;
  }
  const originInstanceId = JSON.stringify(
    sock?.authState?.creds?.me || sock?.user || null,
  );

  const names = new Map();
  // [CUSTOM] Baileys v7 keys many history chats by LID ("123@lid") and gives
  // the phone number separately on the contact (lid / phoneNumber). Without
  // this map every LID chat was skipped and nothing was imported.
  const lidToPn = new Map();
  for (const c of data?.contacts || []) {
    const name = c?.name || c?.notify || c?.verifiedName;
    if (c?.id && name) names.set(c.id, name);
    const pn = String(c?.phoneNumber || "");
    const lid = String(c?.lid || (String(c?.id || "").endsWith("@lid") ? c.id : ""));
    if (lid && pn.endsWith("@s.whatsapp.net")) {
      lidToPn.set(lid, pn);
      if (name && !names.has(pn)) names.set(pn, name);
    }
  }
  for (const ch of data?.chats || []) {
    const lid = String(ch?.lidJid || (String(ch?.id || "").endsWith("@lid") ? ch.id : ""));
    const pn = String(ch?.pnJid || "");
    if (lid && pn.endsWith("@s.whatsapp.net") && !lidToPn.has(lid)) lidToPn.set(lid, pn);
  }

  async function toPhoneJid(jid) {
    if (!jid || !jid.endsWith("@lid")) return jid;
    if (lidToPn.has(jid)) return lidToPn.get(jid);
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) {
        const clean = String(pn).replace(/:\d+@/, "@");
        lidToPn.set(jid, clean);
        return clean;
      }
    } catch (e) {}
    return jid;
  }

  const cutoff = Date.now() / 1000 - historyDays() * 86400;

  const candidates = [];
  let unmapped = 0;
  for (let msg of messages) {
    if (!msg?.key || !msg.message) continue;
    msg = normalizeMessageJid(msg);
    if (msg._isStatusBroadcast) continue;
    if (String(msg.key.remoteJid || "").endsWith("@lid")) {
      msg.key.remoteJid = await toPhoneJid(msg.key.remoteJid);
    }
    const jid = msg.key.remoteJid;
    if (!jid || !jid.endsWith("@s.whatsapp.net")) {
      if (String(jid).endsWith("@lid")) unmapped += 1;
      continue;
    }
    msg.message = unwrap(msg.message);
    if (!SUPPORTED.some((k) => msg.message?.[k])) continue;
    const ts = toUnixSeconds(msg.messageTimestamp);
    if (!ts || ts < cutoff) continue;
    if (!msg.key.fromMe && !msg.pushName && names.get(jid)) {
      msg.pushName = names.get(jid);
    }
    candidates.push({ msg, ts });
  }
  log(
    sessionId,
    `received ${messages.length} message(s) (sync type ${data?.syncType}); ` +
      `${candidates.length} in the last ${historyDays()} day(s)` +
      (unmapped ? `, ${unmapped} skipped (no phone number for LID)` : ""),
  );
  if (!candidates.length) return;

  candidates.sort((a, b) => a.ts - b.ts);

  const latestPerChat = new Map();
  let saved = 0;
  let dupes = 0;
  let failed = 0;

  for (const { msg } of candidates) {
    const chatId = getChatId({
      instanceNumber,
      senderMobile: msg.key.remoteJid,
      uid,
    });
    if (!chatId) continue;

    const res = await processBaileysMsg({
      body: msg,
      uid,
      userFromMysql: null,
      chatId,
      useMessageTime: true,
    });
    if (!res) { failed += 1; continue; } // error or unsupported content
    if (!res.newMessage) { dupes += 1; continue; } // already in the inbox

    saved += 1;
    const customer = msg.key.remoteJid.split("@")[0];
    latestPerChat.set(chatId, {
      message: res.newMessage,
      customer,
      name: names.get(msg.key.remoteJid) || (!msg.key.fromMe && msg.pushName) || customer,
    });
  }

  for (const [chatId, { message, customer, name }] of latestPerChat) {
    const [chat] = await query(
      `SELECT id, last_message FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
      [chatId, uid],
    );

    if (!chat) {
      await query(
        `INSERT INTO beta_chats
         (uid, chat_id, last_message, sender_name, sender_mobile, origin, origin_instance_id, unread_count, assigned_agent, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'qr', ?, 0, NULL, FROM_UNIXTIME(?), FROM_UNIXTIME(?))`,
        [
          uid,
          chatId,
          JSON.stringify(message),
          name,
          customer,
          originInstanceId,
          Number(message.timestamp),
          Number(message.timestamp),
        ],
      );
      continue;
    }

    // Only move last_message forward in time.
    let currentTs = 0;
    try {
      currentTs = Number(JSON.parse(chat.last_message || "{}")?.timestamp) || 0;
    } catch (e) {}
    if (Number(message.timestamp) > currentTs) {
      // keep updatedAt: an old message must not move the chat to the top
      await query(`UPDATE beta_chats SET last_message = ?, updatedAt = updatedAt WHERE id = ?`, [
        JSON.stringify(message),
        chat.id,
      ]);
    }
  }

  log(
    sessionId,
    `saved ${saved} of ${candidates.length} messages in ${latestPerChat.size} chats` +
      ` (already there: ${dupes}, failed: ${failed})`,
  );

  if (saved) {
    try {
      const { getConnectionsByUid, sendToSocket } = require("../../../socket");
      (getConnectionsByUid(uid, true) || []).forEach((s) =>
        sendToSocket(s?.socketId, {}, "request_update_chat_list"),
      );
    } catch (e) {}
  }
}

/** Queue one "messaging-history.set" payload for import. Never rejects. */
function importHistory(args) {
  const prev = queues.get(args.sessionId) || Promise.resolve();
  const next = prev
    .then(() => importBatch(args))
    .catch((e) => log(args.sessionId, "failed:", e?.message || e));
  queues.set(args.sessionId, next);
  return next;
}

module.exports = { importHistory };

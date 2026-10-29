const randomstring = require("randomstring");
const moment = require("moment");
const { query } = require("../../../database/dbpromise");
const mime = require("mime-types");
const { fetchProfileUrl } = require("./control");
const fs = require("fs");
// [CUSTOM] Click-to-WhatsApp ad attribution
const { captureFromBaileys } = require("../../adSource");

// Import downloadMediaMessage directly from baileys
let downloadMediaMessage;

// Function to load baileys dynamically
async function loadBaileys() {
  if (!downloadMediaMessage) {
    const baileys = await import("baileys");
    downloadMediaMessage = baileys.downloadMediaMessage;
  }
}

function timeoutPromise(promise, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

// ─── [CUSTOM] WhatsApp groups ────────────────────────────────────────────
// A group chat is stored like a customer chat, with the group id where the
// customer number normally goes (chat_id = <ourNumber>_<groupId>_<uid>,
// sender_mobile = <groupId>), the group name as sender_name, and
// isGroup: true inside origin_instance_id, which the send code already reads
// to reply to the group instead of a phone number.
function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

const groupSubjects = new Map(); // jid -> { subject, at }
const GROUP_SUBJECT_TTL = 6 * 60 * 60 * 1000;

function rememberGroupSubjects(groups) {
  let n = 0;
  for (const g of Array.isArray(groups) ? groups : Object.values(groups || {})) {
    if (g?.id && g?.subject) {
      groupSubjects.set(g.id, { subject: g.subject, at: Date.now() });
      n += 1;
    }
  }
  return n;
}

const lastFetchAll = new WeakMap(); // session -> time of last groupFetchAllParticipating

/** Every group this number is in, with names. At most once per 10 min. */
async function fetchAllGroups(session) {
  if (!session?.groupFetchAllParticipating) return 0;
  const last = lastFetchAll.get(session) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return 0;
  lastFetchAll.set(session, Date.now());
  try {
    const all = await timeoutPromise(session.groupFetchAllParticipating(), 30000);
    const n = rememberGroupSubjects(all);
    console.log(`[groups] fetched ${n} group name(s)`);
    return n;
  } catch (e) {
    console.log("[groups] fetch all failed:", e?.message || e);
    return 0;
  }
}

async function getGroupSubject(session, jid) {
  const hit = groupSubjects.get(jid);
  if (hit && Date.now() - hit.at < GROUP_SUBJECT_TTL) return hit.subject;
  try {
    const meta = await timeoutPromise(session?.groupMetadata?.(jid), 15000);
    if (meta?.subject) {
      groupSubjects.set(jid, { subject: meta.subject, at: Date.now() });
      return meta.subject;
    }
    console.log(`[groups] no name from groupMetadata for ${jid}`);
  } catch (e) {
    console.log(`[groups] groupMetadata failed for ${jid}:`, e?.message || e);
  }
  // fall back to the list of all groups
  await fetchAllGroups(session);
  return groupSubjects.get(jid)?.subject || hit?.subject || null;
}

/**
 * Put the real group names on this number's group chats in the inbox.
 * Used when the number connects and when WhatsApp reports a group change.
 */
async function syncGroupNames({ session, sessionId, groups }) {
  try {
    if (groups) rememberGroupSubjects(groups);
    else await fetchAllGroups(session);

    const [instance] = await query(
      `SELECT uid, number FROM instance WHERE uniqueId = ? LIMIT 1`,
      [sessionId]
    );
    if (!instance?.number) return;

    const rows = await query(
      `SELECT id, sender_mobile, sender_name FROM beta_chats
        WHERE uid = ? AND origin = 'qr' AND chat_id LIKE ?
          AND REPLACE(origin_instance_id, ' ', '') LIKE '%"isGroup":true%'`,
      [instance.uid, `${instance.number}\\_%`]
    );
    let renamed = 0;
    for (const r of rows) {
      const subject = groupSubjects.get(`${r.sender_mobile}@g.us`)?.subject;
      if (subject && subject !== r.sender_name) {
        await query(
          `UPDATE beta_chats SET sender_name = ?, updatedAt = updatedAt WHERE id = ?`,
          [subject, r.id]
        );
        renamed += 1;
      }
    }
    if (renamed) console.log(`[groups] ${sessionId}: renamed ${renamed} group chat(s)`);
  } catch (e) {
    console.log("[groups] syncGroupNames:", e?.message || e);
  }
}

/** Name and phone of the person who wrote a group message. */
async function getGroupSender(session, message) {
  const key = message?.key || {};
  const candidates = [key.participantAlt, key.participant, message?.participant];
  let phone = null;
  for (const c of candidates) {
    if (String(c || "").endsWith("@s.whatsapp.net")) {
      phone = String(c).split("@")[0].split(":")[0];
      break;
    }
  }
  if (!phone) {
    const lid = candidates.find((c) => String(c || "").endsWith("@lid"));
    if (lid) {
      try {
        const pn = await session?.signalRepository?.lidMapping?.getPNForLID?.(lid);
        if (pn) phone = String(pn).split("@")[0].split(":")[0];
      } catch (e) {}
    }
  }
  return { name: message?.pushName || null, phone };
}

function groupSenderLabel(sender) {
  if (!sender) return "";
  const { name, phone } = sender;
  if (name && phone) return `${name} (+${phone})`;
  if (name) return name;
  if (phone) return `+${phone}`;
  return "";
}

async function updateProfileMysql({
  chatId,
  uid,
  getSession,
  remoteJid,
  sessionId,
}) {
  try {
    if (remoteJid.includes("@g.us")) return;

    const session = await timeoutPromise(getSession(sessionId || "a"), 60000);
    if (!session) return;

    const image = await fetchProfileUrl(session, remoteJid);
    if (!image) return;

    // Get existing chat data to preserve other fields
    const [chat] = await query(
      `SELECT * FROM beta_chats WHERE uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (chat) {
      const profile = chat.profile_image
        ? { ...JSON.parse(chat.profile_image), profileImage: image }
        : { profileImage: image };
      await query(
        `UPDATE beta_chats SET last_message = JSON_SET(COALESCE(last_message, '{}'), '$.profileImage', ?), profile = ? WHERE uid = ? AND chat_id = ?`,
        [image, JSON.stringify(profile), uid, chatId]
      );
    }
  } catch (err) {
    console.log("Error updating profile data:", err);
  }
}

async function updateChatInMysql({
  chatId,
  uid,
  senderName,
  senderMobile,
  actualMsg,
  sessionId,
  getSession,
  jid,
  user,
}) {
  try {
    const allowedMessageTypes = ["text", "image", "document", "video", "audio"];
    const isIncoming = actualMsg?.route === "INCOMING";

    // 🔥 Run profile update in background (don't wait for it)
    setImmediate(() => {
      updateProfileMysql({
        chatId,
        uid,
        getSession,
        remoteJid: jid,
        sessionId,
      });
    });

    const sessionData = await getSession(sessionId);
    let originInstanceId =
      sessionData?.authState?.creds?.me || sessionData.user;

    // [CUSTOM] group chat: show the group's name and mark it as a group so
    // replies go to the group
    if (isGroupJid(jid)) {
      originInstanceId = { ...(originInstanceId || {}), isGroup: true };
      const cached = groupSubjects.get(jid)?.subject;
      if (cached) {
        senderName = cached;
      } else {
        // don't hold the message back while WhatsApp is asked for the name:
        // keep the current name now, put the real one on when it arrives
        const [old] = await query(
          `SELECT sender_name FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
          [chatId, uid]
        );
        senderName =
          old?.sender_name && old.sender_name !== "NA" ? old.sender_name : "WhatsApp group";
        setImmediate(async () => {
          const subject = await getGroupSubject(sessionData, jid);
          if (!subject) return;
          await query(
            `UPDATE beta_chats SET sender_name = ?, updatedAt = updatedAt WHERE chat_id = ? AND uid = ?`,
            [subject, chatId, uid]
          ).catch(() => {});
          try {
            const { getConnectionsByUid, sendToSocket } = require("../../../socket");
            (getConnectionsByUid(uid, true) || []).forEach((s) =>
              sendToSocket(s?.socketId, { chatId }, "request_update_chat_list")
            );
          } catch (e) {}
        });
      }
    }

    // Check if chat exists
    const [chat] = await query(
      `SELECT unread_count FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
      [chatId, uid]
    );

    const last_message = JSON.stringify(actualMsg);
    const sender_name = senderName || "NA";
    const sender_mobile = senderMobile || "NA";
    const origin = "qr";
    const origin_instance_id = JSON.stringify(originInstanceId);

    let unread_count = 0;
    if (isIncoming && allowedMessageTypes.includes(actualMsg?.type)) {
      unread_count = chat?.unread_count ? chat.unread_count + 1 : 1;
    }

    if (chat) {
      await query(
        `UPDATE beta_chats 
         SET last_message = ?, 
             sender_name = ?, 
             sender_mobile = ?, 
             origin = ?, 
             origin_instance_id = ?
             ${unread_count > 0 ? ", unread_count = ?" : ""}
         WHERE chat_id = ? AND uid = ?`,
        unread_count > 0
          ? [
              last_message,
              sender_name,
              sender_mobile,
              origin,
              origin_instance_id,
              unread_count,
              chatId,
              uid,
            ]
          : [
              last_message,
              sender_name,
              sender_mobile,
              origin,
              origin_instance_id,
              chatId,
              uid,
            ]
      );
    } else {
      await query(
        `INSERT INTO beta_chats 
         (uid, chat_id, last_message, sender_name, sender_mobile, origin, origin_instance_id, unread_count, assigned_agent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          uid,
          chatId,
          last_message,
          sender_name,
          sender_mobile,
          origin,
          origin_instance_id,
          unread_count,
        ]
      );
    }
  } catch (err) {
    console.log("Error updating chat:", err);
  }
}

function getCurrentTimestampInTimeZone(timezone) {
  if (typeof timezone === "number") {
    return timezone;
  } else if (typeof timezone === "string") {
    const currentTimeInZone = moment.tz(timezone);
    return Math.round(currentTimeInZone.valueOf() / 1000);
  }
  return Math.round(Date.now() / 1000);
}

function saveImageToFile(imageBuffer, filePath, mimetype) {
  try {
    fs.writeFileSync(filePath, imageBuffer);
    console.log(`${mimetype || "IMG"} saved successfully as ${filePath}`);
  } catch (error) {
    console.error(`Error saving image: ${error.message}`);
  }
}

async function downloadMediaPromise(m, mimetype) {
  try {
    // Ensure baileys is loaded
    await loadBaileys();

    const bufferMsg = await downloadMediaMessage(m, "buffer", {}, {});
    const randomSt = randomstring.generate(6);
    const mimeType = mime.extension(mimetype);
    const fileName = `${randomSt}_qr.${mimeType}`;
    const filePath = `${__dirname}/../../../client/public/meta-media/${fileName}`;

    saveImageToFile(bufferMsg, filePath, mimetype);

    return { success: true, fileName };
  } catch (err) {
    console.log("Error in downloadMediaPromise:", err);
    return { err, success: false };
  }
}

function getChatId({ instanceNumber, senderMobile, uid }) {
  try {
    // [CUSTOM] group ids can contain a dash (old style "2010...-1612345678")
    if (isGroupJid(senderMobile)) {
      return `${instanceNumber}_${String(senderMobile).split("@")[0]}_${uid}`;
    }
    return `${instanceNumber}_${extractPhoneNumber(senderMobile)}_${uid}`;
  } catch (error) {
    return null;
  }
}

async function saveMessageToConversation({ uid, chatId, messageData }) {
  try {
    await query(`INSERT INTO beta_conversation SET ?`, {
      type: messageData.type,
      metaChatId: messageData.metaChatId,
      msgContext: JSON.stringify(messageData.msgContext),
      reaction: messageData.reaction || "",
      timestamp: messageData.timestamp,
      senderName: messageData.senderName,
      senderMobile: messageData.senderMobile,
      star: messageData.star ? 1 : 0,
      route: messageData.route,
      context: messageData.context ? JSON.stringify(messageData.context) : null,
      origin: messageData.origin,
      uid,
      chat_id: chatId,
    });
    return true;
  } catch (err) {
    console.log("Error saving message to conversation:", err);
    return false;
  }
}

// [CUSTOM] protobuf timestamps may be a Long object
function toUnixSeconds(t) {
  if (t === null || t === undefined) return null;
  const n = typeof t === "object" && t.toNumber ? t.toNumber() : Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function processBaileysMsg({
  body,
  uid,
  userFromMysql,
  chatId,
  useMessageTime = false, // [CUSTOM] true for offline/history messages
  groupSender = null, // [CUSTOM] { name, phone } of the group member who wrote it
}) {
  try {
    if (!body) return null;

    // Status Update Handling
    if (body.update && typeof body.update.status === "number") {
      if (!body.key?.fromMe) {
        return { newMessage: null, chatId };
      }

      const statusMapping = { 2: "sent", 3: "delivered", 4: "read" };
      const newStatusNumber = body.update.status;
      const newStatus = statusMapping[newStatusNumber] || "";

      await query(
        `UPDATE beta_conversation SET status = ? WHERE metaChatId = ? AND uid = ?`,
        [newStatus, body.key.id, uid]
      );

      return { newMessage: null, chatId };
    }

    // [CUSTOM] Never store the same WhatsApp message twice. Offline
    // ("append") delivery and history sync can both repeat messages the
    // inbox already has.
    if (body.key?.id) {
      const [dupe] = await query(
        `SELECT id FROM beta_conversation WHERE metaChatId = ? AND uid = ? LIMIT 1`,
        [body.key.id, uid]
      );
      if (dupe) return { newMessage: null, chatId };
    }

    let msgContext = null;
    let referencedMessageData = null;

    // console.log({ body: JSON.stringify(body) });

    // Determine message type
    if (body.message.conversation) {
      msgContext = {
        type: "text",
        text: {
          body: body.message.conversation,
          preview_url: true,
        },
      };
    } else if (body.message.reactionMessage) {
      const reaction = body.message.reactionMessage;

      // Find the original message that was reacted to
      const [originalMessage] = await query(
        `SELECT * FROM beta_conversation WHERE metaChatId = ? AND uid = ?`,
        [reaction.key.id, uid]
      );

      if (originalMessage) {
        // Update the reaction field in the original message
        await query(
          `UPDATE beta_conversation SET reaction = ? WHERE metaChatId = ? AND uid = ?`,
          [reaction.text, reaction.key.id, uid]
        );

        // Return null as we don't need to create a new message for reactions
        return { newMessage: null, chatId };
      }

      // If original message not found, log warning
      console.warn(
        `Original message ${reaction.key.id} not found for reaction`
      );
      return { newMessage: null, chatId };
    } else if (body.message.extendedTextMessage) {
      const extText = body.message.extendedTextMessage;
      msgContext = {
        type: "text",
        text: {
          body: extText.text,
          preview_url: true,
        },
      };
      if (extText.contextInfo?.quotedMessage) {
        referencedMessageData = extText.contextInfo.quotedMessage;
      }
    } else if (body.message.imageMessage) {
      const img = body.message.imageMessage;
      const downloadResult = await downloadMediaPromise(body, img.mimetype);
      msgContext = {
        type: "image",
        image: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: img.caption || "",
        },
      };
    } else if (body.message.videoMessage) {
      const vid = body.message.videoMessage;
      const downloadResult = await downloadMediaPromise(body, vid.mimetype);
      msgContext = {
        type: "video",
        video: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: vid.caption || "",
        },
      };
    } else if (body.message.contactMessage) {
      const contact = body.message.contactMessage;
      msgContext = {
        type: "contact",
        contact: {
          name: contact.displayName || "Unknown Contact",
          vcard: contact.vcard || "",
        },
      };
    } else if (body.message.audioMessage) {
      const aud = body.message.audioMessage;
      const downloadResult = await downloadMediaPromise(body, aud.mimetype);
      msgContext = {
        type: "audio",
        audio: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
        },
      };
    } else if (body.message.locationMessage) {
      msgContext = {
        type: "location",
        location: {
          latitude: body.message?.locationMessage?.degreesLatitude,
          longitude: body.message?.locationMessage?.degreesLongitude,
          name: body.message?.locationMessage?.name,
          address: body.message?.locationMessage?.address,
        },
      };
    } else if (body.message.documentWithCaptionMessage) {
      const doc =
        body.message.documentWithCaptionMessage.message.documentMessage;
      const downloadResult = await downloadMediaPromise(
        body,
        body?.message?.documentWithCaptionMessage?.message?.documentMessage?.mimetype?.replace(
          "application/x-javascript",
          "application/javascript"
        )
      );
      msgContext = {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: doc.caption || doc.title || "",
        },
      };
      if (doc.contextInfo?.quotedMessage) {
        referencedMessageData = doc.contextInfo.quotedMessage;
      }
    } else if (body.message.documentMessage) {
      // Handle regular document messages without caption
      const doc = body.message.documentMessage;
      const downloadResult = await downloadMediaPromise(body, doc.mimetype);
      msgContext = {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: doc.caption || doc.title || doc.fileName || "",
        },
      };
      if (doc.contextInfo?.quotedMessage) {
        referencedMessageData = doc.contextInfo.quotedMessage;
      }
    } else {
      console.warn("Unsupported message type in Baileys webhook");
      return null;
    }

    // [CUSTOM] in a group, show who wrote each incoming message
    const senderLabel =
      isGroupJid(body.key?.remoteJid) && !body.key?.fromMe
        ? groupSenderLabel(groupSender)
        : "";
    if (senderLabel) {
      const t = msgContext.type;
      if (t === "text" && msgContext.text) {
        msgContext.text.body = `${senderLabel}:\n${msgContext.text.body || ""}`;
      } else if (msgContext[t] && "caption" in msgContext[t]) {
        const cap = msgContext[t].caption;
        msgContext[t].caption = cap ? `${senderLabel}:\n${cap}` : senderLabel;
      }
    }

    // Determine context from quoted message if available
    let contextData = "";
    if (referencedMessageData?.stanzaId) {
      const [foundMsg] = await query(
        `SELECT * FROM beta_conversation WHERE metaChatId = ? AND uid = ?`,
        [referencedMessageData.stanzaId, uid]
      );
      contextData = foundMsg || referencedMessageData;
    } else if (referencedMessageData) {
      contextData = referencedMessageData;
    }

    // Create the new message object
    const newMessage = {
      type: msgContext.type,
      metaChatId: body.key.id,
      msgContext,
      reaction: "",
      timestamp:
        (useMessageTime && toUnixSeconds(body.messageTimestamp)) ||
        getCurrentTimestampInTimeZone(
          userFromMysql?.timezone || body.messageTimestamp
        ),
      senderName: body.pushName || "NA",
      senderMobile: body.key.remoteJid
        ? body.key.remoteJid.split("@")[0]
        : "NA",
      status: "",
      star: false,
      route: body.key?.fromMe ? "OUTGOING" : "INCOMING",
      context: contextData,
      origin: "qr",
    };

    // Save message to MySQL
    await saveMessageToConversation({
      uid,
      chatId,
      messageData: newMessage,
    });

    // [CUSTOM] Record the ad this customer arrived from, if any. Deliberately
    // not awaited into the return path — attribution must never delay or
    // break message delivery.
    captureFromBaileys({ body, uid, chatId }).catch(() => {});

    return { newMessage, chatId };
  } catch (err) {
    console.error("Error processing Baileys message:", err);
    return null;
  }
}

async function getUserDetails(sessionId, userData) {
  try {
    // Only get instance data, user data is already provided
    const [instance] = await query(
      `SELECT 
        id,
        uid,
        number,
        uniqueId,
        data,
        other
      FROM instance
      WHERE uniqueId = ?
      LIMIT 1`,
      [sessionId]
    );

    if (!instance) return null;

    // Combine userData with instance
    return {
      ...userData,
      instance: {
        id: instance.id,
        uid: instance.uid,
        number: instance.number,
        uniqueId: instance.uniqueId,
        data: instance.data,
        other: instance.other,
        status: instance.status,
      },
    };
  } catch (err) {
    console.error("getUserDetails error:", err);
    return null;
  }
}

async function processMessageQr({
  type,
  message,
  sessionId,
  getSession,
  userData,
  uid,
}) {
  try {
    const userDetails = await getUserDetails(sessionId, userData);

    if (!userDetails) {
      return;
    }

    const instanceNumber = userDetails?.instance?.number;

    if (!instanceNumber || !message.key.remoteJid || !uid) {
      console.log("Details not found to update chat list");
      console.log({
        instanceNumber,
        senderMobile: message.key.remoteJid,
        uid,
      });
    }

    const chatId = getChatId({
      instanceNumber,
      senderMobile: message.key.remoteJid,
      uid,
    });

    // [CUSTOM] who wrote it, for incoming group messages
    let groupSender = null;
    if (isGroupJid(message.key.remoteJid) && !message.key.fromMe && message.message) {
      const session = await timeoutPromise(getSession(sessionId || "a"), 15000);
      groupSender = await getGroupSender(session, message);
    }

    const data = await processBaileysMsg({
      body: message,
      uid: uid,
      userFromMysql: userData,
      chatId,
      useMessageTime: type === "append",
      groupSender,
    });

    // Update chat in MySQL with the latest message
    if (data?.newMessage) {
      await updateChatInMysql({
        chatId,
        uid: uid,
        senderName: data.newMessage.senderName,
        senderMobile: data.newMessage.senderMobile,
        actualMsg: data.newMessage,
        sessionId,
        getSession,
        jid: message?.remoteJid || message?.key?.remoteJid,
        userPromise: userDetails,
        user: userData,
      });
    }

    return data;
  } catch (err) {
    console.error("processMessageQr error:", err);
    return null;
  }
}

module.exports = {
  processMessageQr,
  // [CUSTOM] used by ./historySync.js
  processBaileysMsg,
  getChatId,
  toUnixSeconds,
  isGroupJid,
  syncGroupNames,
};

const { query } = require("../../../database/dbpromise");
const axios = require("axios");
const randomstring = require("randomstring");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const {
  getCurrentTimestampInTimeZone,
} = require("../../../functions/function");

const API_VERSION = "v21.0";

function getCurrentTimestamp() {
  return Math.round(Date.now() / 1000);
}

// ─── Download Instagram media and save locally ────────────
async function downloadAndSaveInstaMedia(mediaUrl, accessToken) {
  try {
    // ── SSRF domain validation ──────────────────────────
    const parsedUrl = new URL(mediaUrl);
    const allowedHosts = ["cdninstagram.com", "fbcdn.net", "instagram.com"];
    const isAllowed = allowedHosts.some((host) =>
      parsedUrl.hostname.endsWith(host),
    );
    if (!isAllowed) return null;
    // ───────────────────────────────────────────────────

    const response = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer",
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    const ext = mime.extension(contentType) || "jpg";
    const fileName = `${randomstring.generate(10)}_ig.${ext}`;
    const filePath = path.resolve(
      __dirname,
      "../../../client/public/meta-media",
      fileName,
    );

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, response.data);
    return fileName;
  } catch (err) {
    return null;
  }
}

// ─── Fetch Instagram media URL from Graph API ─────────────
async function fetchInstaMediaUrl(mediaId, accessToken) {
  try {
    const res = await axios.get(
      `https://graph.instagram.com/${API_VERSION}/${mediaId}?fields=url,mime_type&access_token=${accessToken}`,
    );
    return res.data;
  } catch (err) {
    console.error("fetchInstaMediaUrl error:", err.message);
    return null;
  }
}

// ─── Find which IG account + uid this webhook belongs to ──
async function resolveAccountFromWebhook(igBusinessId) {
  try {
    // webhook_id = user_id (the IG Business Account ID)
    const rows = await query(
      `SELECT * FROM instagram_accounts WHERE webhook_id = ? OR user_id = ? LIMIT 1`,
      [igBusinessId, igBusinessId],
    );
    return rows[0] || null;
  } catch (err) {
    console.error("resolveAccountFromWebhook error:", err);
    return null;
  }
}

// ─── Upsert beta_chats ────────────────────────────────────
async function updateChatInMysql({
  chatId,
  uid,
  senderName,
  senderIgsid,
  actualMsg,
  igAccount,
}) {
  try {
    const allowedTypes = ["text", "image", "video", "audio", "document"];
    const isIncoming = actualMsg?.route === "INCOMING";

    const [chat] = await query(
      `SELECT unread_count FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
      [chatId, uid],
    );

    const last_message = JSON.stringify(actualMsg);
    const sender_name = senderName || "Instagram User";
    const sender_mobile = senderIgsid || "NA";
    const origin = "instagram";
    const origin_instance_id = JSON.stringify({
      id: igAccount?.user_id || igAccount?.webhook_id,
      username: igAccount?.username,
      name: igAccount?.name,
    });

    let unread_count = 0;
    if (isIncoming && allowedTypes.includes(actualMsg?.type)) {
      unread_count = chat?.unread_count ? chat.unread_count + 1 : 1;
    }

    if (chat) {
      await query(
        `UPDATE beta_chats 
         SET last_message = ?, sender_name = ?, sender_mobile = ?,
             origin = ?, origin_instance_id = ?
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
            ],
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
        ],
      );
    }
  } catch (err) {
    console.error("updateChatInMysql (instagram) error:", err);
  }
}

// ─── Save message to beta_conversation ───────────────────
async function saveMessageToConversation({ uid, chatId, messageData }) {
  try {
    await query(`INSERT INTO beta_conversation SET ?`, {
      type: messageData.type,
      metaChatId: messageData.metaChatId,
      msgContext: JSON.stringify(messageData.msgContext),
      reaction: messageData.reaction || "",
      timestamp: messageData.timestamp, // ✅ already normalized above
      senderName: messageData.senderName,
      senderMobile: messageData.senderMobile,
      star: messageData.star ? 1 : 0,
      route: messageData.route,
      context: messageData.context ? JSON.stringify(messageData.context) : null,
      origin: "instagram",
      uid,
      chat_id: chatId,
      status: messageData.status || "",
      createdAt: new Date(),
    });
    return true;
  } catch (err) {
    console.error("saveMessageToConversation (instagram) error:", err);
    return false;
  }
}

// ─── Core: Process one Instagram webhook messaging event ──
async function processInstaMsg({ messagingEvent, igAccount, uid }) {
  try {
    const senderId = messagingEvent?.sender?.id;
    const recipientId = messagingEvent?.recipient?.id;

    // AFTER — convert ms to seconds if needed
    const rawTimestamp =
      messagingEvent?.timestamp || getCurrentTimestamp() * 1000;
    const timestamp =
      rawTimestamp > 9999999999
        ? Math.floor(rawTimestamp / 1000) // ms → seconds
        : rawTimestamp; // already seconds

    const message = messagingEvent?.message;

    if (!message || !senderId) return null;

    const accessToken = igAccount.access_token;
    const myIgId = igAccount.user_id || igAccount.webhook_id;

    // Determine direction
    // If sender is our IG account → OUTGOING (sent from IG app)
    // If sender is someone else → INCOMING
    const isOutgoing = String(senderId) === String(myIgId);
    const route = isOutgoing ? "OUTGOING" : "INCOMING";

    // The "other person" IGSID — always the non-business side
    const otherPersonId = isOutgoing ? recipientId : senderId;

    // chat_id is always keyed on the other person's IGSID
    const chatId = `ig_${otherPersonId}`;

    // Sender display info
    const senderName = isOutgoing
      ? igAccount.name || igAccount.username || "Me"
      : messagingEvent?.sender?.name || `ig_${otherPersonId}`;
    const senderIgsid = otherPersonId;

    // ─── Duplicate check ──────────────────────────────────
    const msgId = message.mid;
    if (msgId) {
      const [existing] = await query(
        `SELECT id FROM beta_conversation WHERE metaChatId = ? AND uid = ? LIMIT 1`,
        [msgId, uid],
      );
      if (existing) return null; // already saved
    }

    // ─── Build msgContext ─────────────────────────────────
    let msgContext = null;
    let msgType = "text";

    if (message.text && !message.attachments) {
      // Plain text
      msgType = "text";
      msgContext = {
        type: "text",
        text: { body: message.text, preview_url: true },
      };
    } else if (message.attachments && message.attachments.length > 0) {
      const attachment = message.attachments[0];
      const attType = attachment.type; // image, video, audio, file, share, fallback

      if (attType === "image") {
        msgType = "image";
        const mediaUrl = attachment.payload?.url;
        let fileName = null;
        if (mediaUrl) {
          fileName = await downloadAndSaveInstaMedia(mediaUrl, accessToken);
        }
        msgContext = {
          type: "image",
          image: {
            link: fileName
              ? `${process.env.FRONTENDURI}/meta-media/${fileName}`
              : mediaUrl || "",
            caption: "",
          },
        };
      } else if (attType === "video") {
        msgType = "video";
        const mediaUrl = attachment.payload?.url;
        let fileName = null;
        if (mediaUrl) {
          fileName = await downloadAndSaveInstaMedia(mediaUrl, accessToken);
        }
        msgContext = {
          type: "video",
          video: {
            link: fileName
              ? `${process.env.FRONTENDURI}/meta-media/${fileName}`
              : mediaUrl || "",
            caption: "",
          },
        };
      } else if (attType === "audio") {
        msgType = "audio";
        const mediaUrl = attachment.payload?.url;
        let fileName = null;
        if (mediaUrl) {
          fileName = await downloadAndSaveInstaMedia(mediaUrl, accessToken);
        }
        msgContext = {
          type: "audio",
          audio: {
            link: fileName
              ? `${process.env.FRONTENDURI}/meta-media/${fileName}`
              : mediaUrl || "",
          },
        };
      } else if (attType === "file") {
        msgType = "document";
        const mediaUrl = attachment.payload?.url;
        let fileName = null;
        if (mediaUrl) {
          fileName = await downloadAndSaveInstaMedia(mediaUrl, accessToken);
        }
        msgContext = {
          type: "document",
          document: {
            link: fileName
              ? `${process.env.FRONTENDURI}/meta-media/${fileName}`
              : mediaUrl || "",
            caption: attachment.payload?.title || "",
          },
        };
      } else if (attType === "share" || attType === "fallback") {
        // Story reply, link share, etc.
        msgType = "text";
        const fallbackTitle = attachment.payload?.title || "Shared content";
        const fallbackUrl = attachment.payload?.url || "";
        msgContext = {
          type: "text",
          text: {
            body: fallbackUrl
              ? `${fallbackTitle}: ${fallbackUrl}`
              : fallbackTitle,
            preview_url: true,
          },
        };
      } else {
        // Unknown attachment — store as text note
        msgType = "text";
        msgContext = {
          type: "text",
          text: { body: `[${attType} attachment]`, preview_url: false },
        };
      }
    } else if (message.is_deleted) {
      // Message was unsent/deleted
      await query(
        `UPDATE beta_conversation SET status = 'deleted' WHERE metaChatId = ? AND uid = ?`,
        [msgId, uid],
      );
      return null;
    } else if (message.is_echo) {
      // Echo of outgoing — already handled via route detection above
      // but if we reach here without text/attachments, skip
      return null;
    }

    if (!msgContext) return null;

    // ─── Handle reply_to (context) ────────────────────────
    let contextData = null;
    if (message.reply_to?.mid) {
      const [replyMsg] = await query(
        `SELECT metaChatId, msgContext, senderName, senderMobile, type, timestamp
         FROM beta_conversation WHERE metaChatId = ? AND uid = ? LIMIT 1`,
        [message.reply_to.mid, uid],
      );
      if (replyMsg) {
        contextData = {
          id: replyMsg.metaChatId,
          msgContext: JSON.parse(replyMsg.msgContext || "{}"),
          senderName: replyMsg.senderName,
          senderMobile: replyMsg.senderMobile,
          type: replyMsg.type,
          timestamp: replyMsg.timestamp,
        };
      }
    }

    // ─── Build final message object ───────────────────────
    const newMessage = {
      type: msgType,
      metaChatId: msgId || `ig_${randomstring.generate(12)}`,
      msgContext,
      reaction: "",
      timestamp,
      senderName,
      senderMobile: senderIgsid,
      status: isOutgoing ? "sent" : "",
      star: false,
      route,
      context: contextData,
      origin: "instagram",
    };

    // ─── Persist ──────────────────────────────────────────
    await saveMessageToConversation({ uid, chatId, messageData: newMessage });
    await updateChatInMysql({
      chatId,
      uid,
      senderName,
      senderIgsid,
      actualMsg: newMessage,
      igAccount,
    });

    return { newMessage, chatId };
  } catch (err) {
    console.error("processInstaMsg error:", err);
    return null;
  }
}

// ─── Handle read receipts ─────────────────────────────────
async function handleInstaRead({ messagingEvent, uid }) {
  try {
    const watermark = messagingEvent?.read?.watermark;
    if (!watermark) return;

    // Mark all messages sent before this watermark as read
    await query(
      `UPDATE beta_conversation 
       SET status = 'read' 
       WHERE uid = ? AND origin = 'instagram' AND route = 'OUTGOING'
         AND timestamp <= ? AND status != 'read'`,
      [uid, Math.round(watermark / 1000)],
    );
  } catch (err) {
    console.error("handleInstaRead error:", err);
  }
}

// ─── Main entry: called from inbox.js processMessage ──────
async function processInstaMessage({ body, uid }) {
  try {
    const entry = body?.entry?.[0];
    if (!entry) return null;

    const igBusinessId = String(entry.id);

    // Resolve which account this belongs to
    const igAccount = await resolveAccountFromWebhook(igBusinessId);
    if (!igAccount) {
      return null;
    }

    // uid from webhook state param — but double-check it matches the account
    const resolvedUid = igAccount.uid;

    const messagingEvents = entry?.messaging || [];
    if (messagingEvents.length === 0) return null;

    let lastResult = null;

    for (const event of messagingEvents) {
      // Read receipt
      if (event.read) {
        await handleInstaRead({ messagingEvent: event, uid: resolvedUid });
        continue;
      }

      // Delivery receipt — update status
      if (event.delivery) {
        const watermark = event.delivery?.watermark;
        if (watermark) {
          await query(
            `UPDATE beta_conversation 
             SET status = 'delivered'
             WHERE uid = ? AND origin = 'instagram' AND route = 'OUTGOING'
               AND timestamp <= ? AND status = 'sent'`,
            [resolvedUid, Math.round(watermark / 1000)],
          );
        }
        continue;
      }

      // Actual message
      if (event.message) {
        const result = await processInstaMsg({
          messagingEvent: event,
          igAccount,
          uid: resolvedUid,
        });
        if (result) lastResult = result;
      }
    }

    return {
      ...lastResult,
      sessionId: igAccount.user_id, // ← add this
    };
  } catch (err) {
    console.error("processInstaMessage error:", err);
    return null;
  }
}

/**
 * Normalise an Instagram comment webhook entry into the same
 * message shape the rest of the automation engine expects.
 */
async function processInstaComment({ igAccount, commentData, uid }) {
  try {
    const commenterId = String(commentData.from?.id || commentData.id);
    const commenterName = commentData.from?.username || "Instagram User";
    const commentText = commentData.text || "";
    const commentId = commentData.id;
    const mediaId = commentData.media?.id || null;

    const senderMobile = `${commenterId}`; // ✅ consistent format

    const chatId = await resolveOrCreateChat({
      uid,
      igAccount,
      senderId: senderMobile, // ✅ same format
      senderName: commenterName,
      origin: "instagram_comment",
    });

    const userTimezone = getCurrentTimestampInTimeZone("Asia/Kolkata");

    await saveMessageToConversation({
      uid,
      chatId,
      messageData: {
        type: "text",
        metaChatId: commentId,
        msgContext: { type: "text", text: { body: commentText } },
        reaction: "",
        timestamp: parseInt(userTimezone),
        senderName: commenterName,
        senderMobile, // ✅ consistent
        star: 0,
        route: "INCOMING",
        context: null,
        origin: "instagram_comment",
      },
    });

    const message = {
      senderMobile, // ✅ consistent
      senderName: commenterName,
      msgContext: { type: "text", text: { body: commentText } },
      commentId,
      mediaId,
      commentText,
    };

    return { message, chatId };
  } catch (err) {
    console.error("[processInstaComment] Error:", err);
    return null;
  }
}

/**
 * Helper — find or create beta_chats row for this commenter
 */
async function resolveOrCreateChat({
  uid,
  igAccount,
  senderId,
  senderName,
  origin,
}) {
  const [existing] = await query(
    `SELECT chat_id FROM beta_chats 
     WHERE uid = ? AND sender_mobile = ? AND origin = ? LIMIT 1`,
    [uid, senderId, origin],
  );

  if (existing) return existing.chat_id;

  const chatId = randomstring.generate(20);

  // ✅ origin_instance_id must match what sendInstaMsg expects:
  // sendInstaMsg does: JSON.parse(chatInfo.origin_instance_id) → .id
  // then queries: instagram_accounts WHERE user_id = parsed.id
  const originInstanceId = JSON.stringify({
    id: igAccount.user_id, // ← must match instagram_accounts.user_id
    username: igAccount.username,
    name: igAccount.name || "",
  });

  await query(
    `INSERT INTO beta_chats 
    (uid, chat_id, sender_mobile, sender_name, origin, origin_instance_id, last_message, createdAt)
   VALUES (?,?,?,?,?,?,?,?)`,
    [
      uid,
      chatId,
      senderId,
      senderName,
      origin,
      JSON.stringify({
        id: igAccount.user_id,
        username: igAccount.username,
        name: igAccount.name || "",
      }),
      JSON.stringify({ type: "text", text: { body: "" } }),
      new Date(),
    ],
  );

  return chatId;
}

module.exports = {
  processInstaMessage,
  resolveAccountFromWebhook,
  processInstaComment,
};

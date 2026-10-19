// helper/inbox/forwardMessage.js

const { query } = require("../../database/dbpromise");
const { getSession, sendMessage } = require("../addon/qr/index");
const randomstring = require("randomstring");
const logger = require("../../utils/logger");
const axios = require("axios");

/**
 * Forward a message to a target chat (QR or Meta)
 */
async function handleForwardMessage({ payload, uid, socket }) {
  try {
    const {
      targetChatId,
      targetOrigin,
      targetSenderMobile,
      targetOriginInstanceId,
      msgContext,
      msgType,
    } = payload;

    if (!targetChatId || !targetOrigin || !targetSenderMobile || !msgContext) {
      socket.emit("error", { msg: "Invalid forward payload" });
      return;
    }

    // Only allow QR and Meta
    if (!["qr", "meta"].includes(targetOrigin)) {
      socket.emit("error", {
        msg: "Forward only supported for QR and Meta channels",
      });
      return;
    }

    // ── QR Forward ──────────────────────────────────────────────────────────
    if (targetOrigin === "qr") {
      let instanceId = null;
      try {
        const parsed =
          typeof targetOriginInstanceId === "string"
            ? JSON.parse(targetOriginInstanceId)
            : targetOriginInstanceId;
        // origin_instance_id stores the session user object: { id: "number@s.whatsapp.net" }
        instanceId = parsed?.id || parsed?.uniqueId || null;
      } catch (_) {}

      if (!instanceId) {
        // Fallback: find any active instance for this uid
        const [inst] = await query(
          `SELECT uniqueId FROM instance WHERE uid = ? AND status = 'ACTIVE' LIMIT 1`,
          [uid],
        );
        if (!inst) {
          socket.emit("error", { msg: "No active QR instance found" });
          return;
        }
        instanceId = inst.uniqueId;
      } else {
        // instanceId might be "number@s.whatsapp.net" — extract uniqueId from instance table
        const phoneNum = instanceId
          .replace("@s.whatsapp.net", "")
          .replace("@c.us", "");
        const [inst] = await query(
          `SELECT uniqueId FROM instance WHERE uid = ? AND number = ? LIMIT 1`,
          [uid, phoneNum],
        );
        if (inst) instanceId = inst.uniqueId;
      }

      const session = getSession(instanceId);
      if (!session) {
        socket.emit("error", { msg: "QR session not active" });
        return;
      }

      const toJid = `${targetSenderMobile}@s.whatsapp.net`;
      let baileysMsg = null;

      switch (msgType) {
        case "text":
          baileysMsg = {
            text: `${msgContext.text?.body || ""}`,
            forward: true,
          };
          break;
        case "image":
          baileysMsg = {
            image: { url: msgContext.image?.link },
            caption: msgContext.image?.caption
              ? `${msgContext.image.caption}`
              : "",
            forward: true,
          };
          break;
        case "video":
          baileysMsg = {
            video: { url: msgContext.video?.link },
            caption: msgContext.video?.caption
              ? `${msgContext.video.caption}`
              : "",
            forward: true,
          };
          break;
        case "audio":
          baileysMsg = {
            audio: { url: msgContext.audio?.link },
            mimetype: "audio/mp4",
            ptt: true,
            forward: true,
          };
          break;
        case "document":
          baileysMsg = {
            document: { url: msgContext.document?.link },
            caption: msgContext.document?.caption || "",
            fileName: msgContext.document?.filename || "document",
            forward: true,
          };
          break;
        default:
          baileysMsg = {
            text: `[Forwarded ${msgType}]`,
            forward: true,
          };
      }

      await session.sendMessage(toJid, baileysMsg);

      // Save forwarded message to conversation
      const timestamp = Math.round(Date.now() / 1000);
      const metaChatId = randomstring.generate(20);

      const forwardedMsg = {
        type: msgType,
        metaChatId,
        msgContext: JSON.stringify(msgContext),
        reaction: "",
        timestamp,
        senderName: "You",
        senderMobile: targetSenderMobile,
        star: 0,
        route: "OUTGOING",
        context: null,
        origin: "qr",
        uid,
        chat_id: targetChatId,
        status: "sent",
      };

      await query(`INSERT INTO beta_conversation SET ?`, forwardedMsg);

      // Update chat last message
      await query(
        `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
        [JSON.stringify({ ...forwardedMsg, msgContext }), targetChatId, uid],
      );

      socket.emit("forward_message_done", { success: true });

      // Notify clients to refresh
      socket.emit("request_update_chat_list", { chatId: targetChatId });
    }

    // ── Meta Forward ─────────────────────────────────────────────────────────
    if (targetOrigin === "meta") {
      const [metaKeys] = await query(
        `SELECT * FROM meta_api WHERE uid = ? LIMIT 1`,
        [uid],
      );

      if (!metaKeys?.access_token || !metaKeys?.business_phone_number_id) {
        socket.emit("error", { msg: "Meta API keys not configured" });
        return;
      }

      const { access_token, business_phone_number_id } = metaKeys;
      const META_VERSION = "v20.0";
      const toPhone = targetSenderMobile;

      let metaPayload = {
        messaging_product: "whatsapp",
        to: toPhone,
      };

      switch (msgType) {
        case "text":
          metaPayload.type = "text";
          metaPayload.text = {
            body: msgContext.text?.body || "",
            preview_url: true,
          };
          break;
        case "image":
          metaPayload.type = "image";
          metaPayload.image = { link: msgContext.image?.link };
          if (msgContext.image?.caption) {
            metaPayload.image.caption = msgContext.image.caption;
          }
          break;
        case "video":
          metaPayload.type = "video";
          metaPayload.video = { link: msgContext.video?.link };
          if (msgContext.video?.caption) {
            metaPayload.video.caption = msgContext.video.caption;
          }
          break;
        case "audio":
          metaPayload.type = "audio";
          metaPayload.audio = { link: msgContext.audio?.link };
          break;
        case "document":
          metaPayload.type = "document";
          metaPayload.document = {
            link: msgContext.document?.link,
            caption: msgContext.document?.caption || "",
            filename: msgContext.document?.filename || "document",
          };
          break;
        default:
          metaPayload.type = "text";
          metaPayload.text = { body: `[Forwarded ${msgType}]` };
      }

      const resp = await axios.post(
        `https://graph.facebook.com/${META_VERSION}/${business_phone_number_id}/messages`,
        metaPayload,
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (resp.data?.error) {
        logger.error("Meta forward error:", resp.data.error);
        socket.emit("error", {
          msg: resp.data.error?.message || "Meta forward failed",
        });
        return;
      }

      const messageId =
        resp.data?.messages?.[0]?.id || randomstring.generate(20);
      const timestamp = Math.round(Date.now() / 1000);

      const forwardedMsg = {
        type: msgType,
        metaChatId: messageId,
        msgContext: JSON.stringify(msgContext),
        reaction: "",
        timestamp,
        senderName: "You",
        senderMobile: targetSenderMobile,
        star: 0,
        route: "OUTGOING",
        context: null,
        origin: "meta",
        uid,
        chat_id: targetChatId,
        status: "sent",
      };

      await query(`INSERT INTO beta_conversation SET ?`, forwardedMsg);

      await query(
        `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
        [JSON.stringify({ ...forwardedMsg, msgContext }), targetChatId, uid],
      );

      socket.emit("forward_message_done", { success: true });
      socket.emit("request_update_chat_list", { chatId: targetChatId });
    }
  } catch (err) {
    logger.error("handleForwardMessage error:", err);
    socket.emit("error", { msg: "Failed to forward message" });
  }
}

module.exports = { handleForwardMessage };

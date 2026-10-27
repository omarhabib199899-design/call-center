/**
 * Click-to-WhatsApp ad attribution.
 *
 * When someone taps a "Click to WhatsApp" ad, the first message they send
 * carries the ad's details. Both transports deliver it, in different shapes:
 *
 *   QR / Baileys  message.<anyType>.contextInfo.externalAdReply
 *                 { title, body, sourceId, sourceUrl, sourceType, ctwaClid, … }
 *
 *   Meta Cloud    message.referral
 *                 { headline, body, source_id, source_url, source_type, … }
 *
 * The stock product only logs the Meta one for debugging and ignores QR
 * entirely. This module normalises both and records them.
 *
 * Nothing here is allowed to break message delivery: every failure is
 * swallowed and logged, because losing a customer's message to save an
 * analytics row would be a bad trade.
 */

const fs = require("fs");
const path = require("path");
const { query } = require("../database/dbpromise");
const logger = require("../utils/logger");

function str(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

/**
 * Pull the ad payload out of a Baileys message, whatever type it is.
 * @returns {object|null} normalized referral, or null when not from an ad
 */
function fromBaileys(body) {
  try {
    const content = body?.message;
    if (!content || typeof content !== "object") return null;

    for (const key of Object.keys(content)) {
      const ad = content[key]?.contextInfo?.externalAdReply;
      if (!ad) continue;

      // showAdAttribution / sourceId is what separates a real ad from an
      // ordinary link preview, which reuses the same envelope.
      if (!ad.sourceId && !ad.ctwaClid && !ad.showAdAttribution) continue;

      return {
        source_id: str(ad.sourceId, 191),
        source_url: str(ad.sourceUrl),
        source_type: str(ad.sourceType, 64),
        ad_title: str(ad.title, 500),
        ad_body: str(ad.body),
        ctwa_clid: str(ad.ctwaClid, 255),
        thumbnail_url: str(ad.thumbnailUrl || ad.mediaUrl),
        // Baileys often carries only an inline JPEG, no URL.
        thumbnail_b64: ad.thumbnail
          ? Buffer.from(ad.thumbnail).toString("base64")
          : null,
        origin: "qr",
      };
    }
  } catch (err) {
    logger.log("[adSource] fromBaileys failed: " + err.message);
  }
  return null;
}

/** Same, for a Meta Cloud API webhook message. */
function fromMeta(message) {
  try {
    const r = message?.referral;
    if (!r) return null;

    return {
      source_id: str(r.source_id, 191),
      source_url: str(r.source_url),
      source_type: str(r.source_type, 64),
      ad_title: str(r.headline, 500),
      ad_body: str(r.body),
      ctwa_clid: str(r.ctwa_clid, 255),
      thumbnail_url: str(r.image_url || r.video_url),
      origin: "meta",
    };
  } catch (err) {
    logger.log("[adSource] fromMeta failed: " + err.message);
  }
  return null;
}


/**
 * [CUSTOM] Put the ad into the conversation itself, the way Messenger and
 * Instagram show it: the ad's picture with "From ad: <title> · ID <id>" and the
 * ad link underneath. Without this WhatsApp only got the top banner.
 *
 * Saved as an INCOMING image (or text, when no picture is available) one second
 * before the customer's first message so it sorts above it. The metaChatId is
 * deterministic, so it can only ever be inserted once per chat + ad.
 */
async function saveAdCard({ uid, chatId, senderMobile, senderName, referral, timestamp }) {
  try {
    const caption = [
      `📢 From ad: ${referral.ad_title || "Ad"}${
        referral.source_id ? " · ID " + referral.source_id : ""
      }`,
      referral.source_url || "",
    ]
      .filter(Boolean)
      .join("\n");

    let imageLink = referral.thumbnail_url || null;

    if (!imageLink && referral.thumbnail_b64 && process.env.FRONTENDURI) {
      try {
        const dir = path.resolve("./client/public/meta-media");
        fs.mkdirSync(dir, { recursive: true });
        const name = `adcard_${Date.now()}_${Math.floor(Math.random() * 1e6)}.jpg`;
        fs.writeFileSync(
          path.join(dir, name),
          Buffer.from(referral.thumbnail_b64, "base64"),
        );
        imageLink = `${process.env.FRONTENDURI}/meta-media/${name}`;
      } catch (e) {
        logger.log("[adSource] could not save thumbnail: " + e.message);
      }
    }

    const msgContext = imageLink
      ? { type: "image", image: { link: imageLink, caption } }
      : { type: "text", text: { body: caption, preview_url: true } };

    const ts = Number(timestamp);
    const metaChatId = `adcard_${chatId}_${referral.source_id || "noid"}`.slice(0, 190);

    const [dupe] = await query(
      `SELECT id FROM beta_conversation WHERE metaChatId = ? AND uid = ? LIMIT 1`,
      [metaChatId, uid],
    );
    if (dupe) return false;

    await query(`INSERT INTO beta_conversation SET ?`, {
      type: msgContext.type,
      metaChatId,
      msgContext: JSON.stringify(msgContext),
      reaction: "",
      timestamp: Number.isFinite(ts) && ts > 0 ? ts - 1 : Math.round(Date.now() / 1000) - 1,
      senderName: str(senderName, 191) || "NA",
      senderMobile: str(senderMobile, 64) || "NA",
      star: 0,
      route: "INCOMING",
      context: null,
      origin: referral.origin === "meta" ? "meta" : "qr",
      uid,
      chat_id: chatId,
    });
    return true;
  } catch (err) {
    logger.log("[adSource] saveAdCard failed: " + err.message);
    return false;
  }
}

/**
 * Store one referral. Deduplicates: the same customer arriving repeatedly
 * through the same ad is recorded once, so the report counts people, not
 * messages.
 */
async function record({ uid, chatId, senderMobile, senderName, referral, timestamp }) {
  if (!uid || !chatId || !referral) return false;

  try {
    const [seen] = await query(
      `SELECT id FROM chat_ad_source
        WHERE uid = ? AND chat_id = ? AND (source_id <=> ?)
        LIMIT 1`,
      [uid, chatId, referral.source_id],
    );

    if (seen) return false;

    await query(
      `INSERT INTO chat_ad_source
        (uid, chat_id, sender_mobile, sender_name, source_id, source_url,
         source_type, ad_title, ad_body, ctwa_clid, thumbnail_url, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uid,
        chatId,
        str(senderMobile, 64),
        str(senderName, 191),
        referral.source_id,
        referral.source_url,
        referral.source_type,
        referral.ad_title,
        referral.ad_body,
        referral.ctwa_clid,
        referral.thumbnail_url,
        referral.origin,
      ],
    );

    // Show the ad inside the chat too (first arrival only: dedupe above).
    await saveAdCard({ uid, chatId, senderMobile, senderName, referral, timestamp });

    logger.log(
      `[adSource] ${senderMobile} arrived from ad ${
        referral.source_id || "(no id)"
      } — ${referral.ad_title || "untitled"}`,
    );
    return true;
  } catch (err) {
    // A missing table must never cost us the message itself.
    if (err?.code === "ER_NO_SUCH_TABLE") {
      logger.log("[adSource] table missing — run database/chat_ad_source.sql");
      return false;
    }
    logger.log("[adSource] record failed: " + err.message);
    return false;
  }
}

/** Convenience wrapper for the QR path. */
async function captureFromBaileys({ body, uid, chatId, timestamp }) {
  const referral = fromBaileys(body);
  if (!referral) return false;

  return record({
    uid,
    chatId,
    senderMobile: body?.key?.remoteJid
      ? String(body.key.remoteJid).split("@")[0]
      : null,
    senderName: body?.pushName,
    referral,
    timestamp,
  });
}

module.exports = {
  fromBaileys,
  fromMeta,
  record,
  saveAdCard,
  captureFromBaileys,
};

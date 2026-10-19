// loops/qrCampaignLoop.js
const { query } = require("../database/dbpromise.js");
const { getSession } = require("../helper/addon/qr/index.js");
const logger = require("../utils/logger.js");

// ── Replace dynamic variables ────────────────────────────────────
function replaceDynamicVars(text, contact) {
  if (!text) return text;
  return text
    .replace(/\{\{name\}\}/gi, contact.name || "")
    .replace(/\{\{mobile\}\}/gi, contact.mobile || "")
    .replace(/\{\{var1\}\}/gi, contact.var1 || "")
    .replace(/\{\{var2\}\}/gi, contact.var2 || "")
    .replace(/\{\{var3\}\}/gi, contact.var3 || "")
    .replace(/\{\{var4\}\}/gi, contact.var4 || "")
    .replace(/\{\{var5\}\}/gi, contact.var5 || "");
}

// ── Add random invisible suffix ──────────────────────────────────
function addRandomSuffix(text) {
  if (!text) return text;
  const chars = ["\u200B", "\u200C", "\u200D", "\uFEFF"];
  return `${text}${chars[Math.floor(Math.random() * chars.length)]}`;
}

// ── Random delay ─────────────────────────────────────────────────
function randomDelay(minSec, maxSec) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Build Baileys message ────────────────────────────────────────
function buildBaileysMessage(campaign, contact) {
  const text = replaceDynamicVars(campaign.message_text, contact);
  const caption = replaceDynamicVars(campaign.media_caption, contact);
  const finalText = campaign.random_suffix ? addRandomSuffix(text) : text;
  const finalCaption = campaign.random_suffix
    ? addRandomSuffix(caption)
    : caption;

  switch (campaign.message_type) {
    case "text":
      return { text: finalText };
    case "image":
      return {
        image: { url: campaign.media_url },
        caption: finalCaption || "",
      };
    case "video":
      return {
        video: { url: campaign.media_url },
        caption: finalCaption || "",
      };
    case "audio":
      return {
        audio: { url: campaign.media_url },
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      };
    case "document":
      return {
        document: { url: campaign.media_url },
        caption: finalCaption || "",
        fileName: campaign.media_url?.split("/").pop() || "document",
      };
    default:
      return { text: finalText || "" };
  }
}

// ── Process one campaign tick ────────────────────────────────────
async function processCampaign(campaign) {
  try {
    const session = getSession(campaign.instance_id);
    if (!session) {
      logger.log(`[QR Campaign] Session not found for ${campaign.id}, pausing`);
      await query(`UPDATE qr_campaigns SET status = 'paused' WHERE id = ?`, [
        campaign.id,
      ]);
      return;
    }

    // Get already-sent mobiles
    const sentLogs = await query(
      `SELECT contact_mobile FROM qr_campaign_logs WHERE campaign_id = ?`,
      [campaign.id],
    );
    const sentMobiles = new Set(sentLogs.map((l) => String(l.contact_mobile)));

    // Get pending contacts
    const contacts = await query(
      `SELECT * FROM contact WHERE uid = ? AND phonebook_id = ?`,
      [campaign.uid, campaign.phonebook_id],
    );
    const pending = contacts.filter((c) => !sentMobiles.has(String(c.mobile)));

    if (pending.length === 0) {
      await query(
        `UPDATE qr_campaigns SET status = 'completed', completed_at = NOW() WHERE id = ?`,
        [campaign.id],
      );
      logger.log(`[QR Campaign] Campaign ${campaign.id} completed`);
      return;
    }

    const contact = pending[0];
    const jid = `${contact.mobile}@s.whatsapp.net`;
    const msgObj = buildBaileysMessage(campaign, contact);

    let status = "sent";
    let errorMsg = null;
    let messageId = null;

    try {
      // ── Send and capture the message key ──────────────────────
      const sendResult = await session.sendMessage(jid, msgObj);
      messageId = sendResult?.key?.id || null;
    } catch (sendErr) {
      status = "failed";
      errorMsg = sendErr?.message || "Send failed";
      logger.error(
        `[QR Campaign] Failed to send to ${contact.mobile}:`,
        sendErr?.message,
      );
    }

    // ── Log with message_id for delivery tracking ──────────────
    await query(
      `INSERT INTO qr_campaign_logs 
        (campaign_id, uid, contact_name, contact_mobile, status, error_msg, message_id, delivery_status) 
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        campaign.id,
        campaign.uid,
        contact.name || "",
        contact.mobile,
        status,
        errorMsg,
        messageId,
        status === "sent" ? "sent" : "failed",
      ],
    );

    // ── Update counters ────────────────────────────────────────
    if (status === "sent") {
      await query(
        `UPDATE qr_campaigns SET sent_count = sent_count + 1 WHERE id = ?`,
        [campaign.id],
      );
    } else {
      await query(
        `UPDATE qr_campaigns SET failed_count = failed_count + 1 WHERE id = ?`,
        [campaign.id],
      );
    }

    // ── Delay before next message ──────────────────────────────
    await randomDelay(campaign.delay_min || 5, campaign.delay_max || 15);
  } catch (err) {
    logger.error(
      `[QR Campaign] Error processing campaign ${campaign.id}:`,
      err,
    );
  }
}

// ── Check scheduled campaigns ────────────────────────────────────
async function checkScheduledCampaigns() {
  try {
    const scheduled = await query(
      `SELECT * FROM qr_campaigns WHERE status = 'scheduled' AND scheduled_at <= NOW()`,
      [],
    );
    for (const c of scheduled) {
      await query(
        `UPDATE qr_campaigns SET status = 'running', started_at = NOW() WHERE id = ?`,
        [c.id],
      );
    }
  } catch (err) {
    logger.error("[QR Campaign] Scheduled check error:", err);
  }
}

// ── Main loop ────────────────────────────────────────────────────
async function qrCampaignLoop() {
  try {
    await checkScheduledCampaigns();

    const running = await query(
      `SELECT * FROM qr_campaigns WHERE status = 'running' LIMIT 5`,
      [],
    );

    for (const campaign of running) {
      const [fresh] = await query(
        `SELECT status FROM qr_campaigns WHERE id = ?`,
        [campaign.id],
      );
      if (fresh?.status === "running") {
        await processCampaign(campaign);
      }
    }
  } catch (err) {
    logger.error("[QR Campaign Loop] Error:", err);
  } finally {
    setTimeout(qrCampaignLoop, 2000);
  }
}

function initQrCampaignLoop() {
  logger.log("[QR Campaign Loop] Starting...");
  setTimeout(qrCampaignLoop, 5000);
}

module.exports = { initQrCampaignLoop };

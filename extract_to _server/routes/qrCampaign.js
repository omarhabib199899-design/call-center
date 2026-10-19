// routes/qrCampaign.js
const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const validateUser = require("../middlewares/user.js");
const { checkPlan } = require("../middlewares/plan.js");
const logger = require("../utils/logger.js");
const { getSession } = require("../helper/addon/qr/index.js");

// ── Tiny inline CSV serializer (replaces json2csv, no extra deps) ──
function toCSV(rows, fields) {
  if (!rows || rows.length === 0) return fields.join(",") + "\n";

  const escape = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    // Wrap in quotes if contains comma, quote, or newline
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = fields.join(",");
  const csvRows = rows.map((row) =>
    fields.map((f) => escape(row[f])).join(","),
  );

  return [header, ...csvRows].join("\n");
}

// ── Create Campaign ──────────────────────────────────────────────
router.post("/create", validateUser, checkPlan, async (req, res) => {
  try {
    const {
      title,
      instance_id,
      phonebook_id,
      message_type,
      message_text,
      media_url,
      media_caption,
      delay_min,
      delay_max,
      random_suffix,
      scheduled_at,
    } = req.body;

    if (!title || !instance_id || !phonebook_id || !message_type) {
      return res.json({
        success: false,
        msg: "Please fill all required fields",
      });
    }

    // Validate instance belongs to user
    const [instance] = await query(
      `SELECT * FROM instance WHERE uniqueId = ? AND uid = ?`,
      [instance_id, req.decode.uid],
    );
    if (!instance) {
      return res.json({ success: false, msg: "Invalid instance selected" });
    }

    // Count contacts in phonebook
    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM contact WHERE uid = ? AND phonebook_id = ?`,
      [req.decode.uid, phonebook_id],
    );
    const total = countResult?.total || 0;

    if (total === 0) {
      return res.json({
        success: false,
        msg: "Selected phonebook has no contacts",
      });
    }

    await query(
      `INSERT INTO qr_campaigns 
        (uid, title, instance_id, phonebook_id, message_type, message_text, media_url, media_caption, delay_min, delay_max, random_suffix, status, total_contacts, scheduled_at) 
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.decode.uid,
        title,
        instance_id,
        phonebook_id,
        message_type,
        message_text || null,
        media_url || null,
        media_caption || null,
        parseInt(delay_min) || 5,
        parseInt(delay_max) || 15,
        random_suffix ? 1 : 0,
        scheduled_at ? "scheduled" : "pending",
        total,
        scheduled_at || null,
      ],
    );

    res.json({ success: true, msg: "Campaign created successfully" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Get All Campaigns ────────────────────────────────────────────
router.get("/get_all", validateUser, async (req, res) => {
  try {
    const campaigns = await query(
      `SELECT c.*, i.title as instance_title, i.number as instance_number
       FROM qr_campaigns c
       LEFT JOIN instance i ON i.uniqueId = c.instance_id
       WHERE c.uid = ?
       ORDER BY c.createdAt DESC`,
      [req.decode.uid],
    );
    res.json({ success: true, data: campaigns });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Get Single Campaign ──────────────────────────────────────────
router.get("/get_one/:id", validateUser, async (req, res) => {
  try {
    const [campaign] = await query(
      `SELECT * FROM qr_campaigns WHERE id = ? AND uid = ?`,
      [req.params.id, req.decode.uid],
    );
    if (!campaign)
      return res.json({ success: false, msg: "Campaign not found" });
    res.json({ success: true, data: campaign });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Pause / Resume Campaign ──────────────────────────────────────
router.post("/toggle_status", validateUser, async (req, res) => {
  try {
    const { id, action } = req.body;
    const allowedActions = ["pause", "resume", "stop"];
    if (!allowedActions.includes(action)) {
      return res.json({ success: false, msg: "Invalid action" });
    }

    const [campaign] = await query(
      `SELECT * FROM qr_campaigns WHERE id = ? AND uid = ?`,
      [id, req.decode.uid],
    );
    if (!campaign)
      return res.json({ success: false, msg: "Campaign not found" });

    let newStatus;
    if (action === "pause") newStatus = "paused";
    else if (action === "resume") newStatus = "running";
    else if (action === "stop") newStatus = "stopped";

    await query(`UPDATE qr_campaigns SET status = ? WHERE id = ? AND uid = ?`, [
      newStatus,
      id,
      req.decode.uid,
    ]);

    res.json({ success: true, msg: `Campaign ${action}d successfully` });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Start Campaign ───────────────────────────────────────────────
router.post("/start", validateUser, checkPlan, async (req, res) => {
  try {
    const { id } = req.body;

    const [campaign] = await query(
      `SELECT * FROM qr_campaigns WHERE id = ? AND uid = ?`,
      [id, req.decode.uid],
    );
    if (!campaign)
      return res.json({ success: false, msg: "Campaign not found" });

    if (["running", "completed"].includes(campaign.status)) {
      return res.json({
        success: false,
        msg: `Campaign is already ${campaign.status}`,
      });
    }

    // Validate session is active
    const session = getSession(campaign.instance_id);
    if (!session) {
      return res.json({
        success: false,
        msg: "WhatsApp instance is not connected. Please connect it first.",
      });
    }

    await query(
      `UPDATE qr_campaigns SET status = 'running', started_at = NOW() WHERE id = ? AND uid = ?`,
      [id, req.decode.uid],
    );

    res.json({ success: true, msg: "Campaign started successfully" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Delete Campaign ──────────────────────────────────────────────
router.post("/delete", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM qr_campaigns WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    await query(
      `DELETE FROM qr_campaign_logs WHERE campaign_id = ? AND uid = ?`,
      [id, req.decode.uid],
    );
    res.json({ success: true, msg: "Campaign deleted" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Get Campaign Logs with delivery stats ────────────────────────
router.get("/get_logs/:campaign_id", validateUser, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM qr_campaign_logs WHERE campaign_id = ? AND uid = ?`,
      [req.params.campaign_id, req.decode.uid],
    );

    const logs = await query(
      `SELECT * FROM qr_campaign_logs 
       WHERE campaign_id = ? AND uid = ? 
       ORDER BY createdAt DESC 
       LIMIT ? OFFSET ?`,
      [req.params.campaign_id, req.decode.uid, parseInt(limit), offset],
    );

    // ── Delivery summary stats ─────────────────────────────────
    const [deliveryStats] = await query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN delivery_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN delivery_status IN ('read','played') THEN 1 ELSE 0 END) as \`read\`,
        SUM(CASE WHEN delivery_status = 'pending' THEN 1 ELSE 0 END) as pending
       FROM qr_campaign_logs 
       WHERE campaign_id = ? AND uid = ?`,
      [req.params.campaign_id, req.decode.uid],
    );

    res.json({
      success: true,
      data: logs,
      total: countResult?.total || 0,
      page: parseInt(page),
      limit: parseInt(limit),
      deliveryStats: deliveryStats || {},
    });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

router.get("/download_report/:campaign_id", validateUser, async (req, res) => {
  try {
    const logs = await query(
      `SELECT 
        contact_name, 
        contact_mobile, 
        status, 
        delivery_status,
        error_msg, 
        sent_at,
        delivered_at,
        read_at
       FROM qr_campaign_logs 
       WHERE campaign_id = ? AND uid = ? 
       ORDER BY sent_at ASC`,
      [req.params.campaign_id, req.decode.uid],
    );

    const [campaign] = await query(
      `SELECT title FROM qr_campaigns WHERE id = ? AND uid = ?`,
      [req.params.campaign_id, req.decode.uid],
    );

    const fields = [
      "contact_name",
      "contact_mobile",
      "status",
      "delivery_status",
      "error_msg",
      "sent_at",
      "delivered_at",
      "read_at",
    ];

    const header = fields.join(",");
    const rows = logs.map((row) =>
      fields
        .map((f) => `"${(row[f] ?? "").toString().replace(/"/g, '""')}"`)
        .join(","),
    );

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="campaign_${campaign?.title || req.params.campaign_id}_report.csv"`,
    );
    res.send(csv);
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Get Phonebooks for Campaign (with contact count) ─────────────
router.get("/get_phonebooks", validateUser, async (req, res) => {
  try {
    let data = await query(`SELECT * FROM phonebook WHERE uid = ?`, [
      req.decode.uid,
    ]);

    data = await Promise.all(
      data.map(async (x) => {
        const [result] = await query(
          `SELECT COUNT(*) AS count FROM contact WHERE phonebook_id = ? AND uid = ?`,
          [x.id, req.decode.uid],
        );
        return { ...x, contactCount: result.count };
      }),
    );

    res.json({ success: true, data });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

module.exports = router;

const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const validateUser = require("../middlewares/user.js");
const { checkPlan } = require("../middlewares/plan.js");
const logger = require("../utils/logger.js");

// ── Move card ─────────────────────────────────────────────────────────────────
router.post("/move_card", validateUser, checkPlan, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const { chatId, newLabelId, kanban_order } = req.body;

    if (!chatId) return res.json({ success: false, msg: "chatId is required" });

    const [chat] = await query(
      `SELECT id, chat_label FROM beta_chats WHERE id = ? AND uid = ?`,
      [chatId, uid],
    );
    if (!chat) return res.json({ success: false, msg: "Chat not found" });

    if (!newLabelId) {
      await query(
        `UPDATE beta_chats SET chat_label = ?, kanban_order = ? WHERE id = ? AND uid = ?`,
        [JSON.stringify([]), kanban_order ?? 0, chatId, uid],
      );
      return res.json({ success: true });
    }

    const [newLabel] = await query(
      `SELECT * FROM chat_tags WHERE id = ? AND uid = ?`,
      [newLabelId, uid],
    );
    if (!newLabel) return res.json({ success: false, msg: "Label not found" });

    let existingLabels = [];
    try {
      const parsed = JSON.parse(chat.chat_label || "[]");
      existingLabels = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}

    const updatedLabels = [newLabel, ...existingLabels.slice(1)];

    await query(
      `UPDATE beta_chats SET chat_label = ?, kanban_order = ? WHERE id = ? AND uid = ?`,
      [JSON.stringify(updatedLabels), kanban_order ?? 0, chatId, uid],
    );

    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Update show_on_kanban for a tag ───────────────────────────────────────────
router.post("/update_tag_kanban_visibility", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const { labelId, show_on_kanban } = req.body;

    if (!labelId)
      return res.json({ success: false, msg: "labelId is required" });

    await query(
      `UPDATE chat_tags SET show_on_kanban = ? WHERE id = ? AND uid = ?`,
      [show_on_kanban ? 1 : 0, labelId, uid],
    );

    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Get board ─────────────────────────────────────────────────────────────────
router.post("/get_board", validateUser, checkPlan, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const {
      search = "",
      limit = 20,
      offset = 0,
      dateFilter = "lifetime", // today | yesterday | last7 | last30 | thisMonth | lifetime | custom
      dateFrom = null,
      dateTo = null,
    } = req.body;

    // Only fetch labels that are shown on kanban
    const labels = await query(
      `SELECT * FROM chat_tags WHERE uid = ? AND show_on_kanban = 1 ORDER BY id ASC`,
      [uid],
    );

    let searchCondition = `WHERE uid = ?`;
    const params = [uid];

    // ── Date filter ──────────────────────────────────────────────────────────
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const toDateStr = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    if (dateFilter === "today") {
      const today = toDateStr(now);
      searchCondition += ` AND DATE(updatedAt) = ?`;
      params.push(today);
    } else if (dateFilter === "yesterday") {
      const yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      searchCondition += ` AND DATE(updatedAt) = ?`;
      params.push(toDateStr(yest));
    } else if (dateFilter === "last7") {
      searchCondition += ` AND updatedAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
    } else if (dateFilter === "last30") {
      searchCondition += ` AND updatedAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    } else if (dateFilter === "thisMonth") {
      searchCondition += ` AND MONTH(updatedAt) = MONTH(NOW()) AND YEAR(updatedAt) = YEAR(NOW())`;
    } else if (dateFilter === "custom" && dateFrom && dateTo) {
      searchCondition += ` AND DATE(updatedAt) BETWEEN ? AND ?`;
      params.push(dateFrom, dateTo);
    }
    // lifetime → no date filter

    if (search) {
      searchCondition += ` AND (
        sender_name LIKE ? OR
        sender_mobile LIKE ? OR
        last_message LIKE ? OR
        chat_label LIKE ?
      )`;
      params.push(
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%"title":"%${search}%"%`,
      );
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM beta_chats ${searchCondition}`,
      params,
    );

    const chats = await query(
      `SELECT id, chat_id, sender_name, sender_mobile, last_message,
              origin, unread_count, assigned_agent, chat_label, kanban_order, updatedAt
       FROM beta_chats ${searchCondition}
       ORDER BY kanban_order ASC, updatedAt DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const parsedChats = chats.map((chat) => {
      try {
        chat.last_message = JSON.parse(chat.last_message);
      } catch {}
      return chat;
    });

    const grouped = {};
    labels.forEach((l) => (grouped[l.id] = []));
    grouped["unlabeled"] = [];

    parsedChats.forEach((chat) => {
      let firstLabel = null;
      try {
        const arr = JSON.parse(
          typeof chat.chat_label === "string" ? chat.chat_label : "[]",
        );
        firstLabel = (Array.isArray(arr) ? arr : [arr])[0] || null;
      } catch {}

      if (firstLabel && grouped[firstLabel.id] !== undefined) {
        grouped[firstLabel.id].push({ ...chat, kanbanLabel: firstLabel });
      } else {
        grouped["unlabeled"].push({ ...chat, kanbanLabel: null });
      }
    });

    res.json({ success: true, labels, grouped, total, offset, limit });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

module.exports = router;

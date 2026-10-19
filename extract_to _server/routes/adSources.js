/**
 * Click-to-WhatsApp ad attribution report.
 *
 * Owner-only. Serves the page at /ad-sources.html.
 */

const express = require("express");
const router = express.Router();

const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const logger = require("../utils/logger");

const MISSING =
  "Table chat_ad_source is missing. Run database/chat_ad_source.sql first.";

function fail(res, err) {
  logger.log(err);
  res.json({
    success: false,
    msg: err?.code === "ER_NO_SUCH_TABLE" ? MISSING : "something went wrong",
  });
}

/** Days filter -> SQL fragment. 0 / missing means all time. */
function sinceClause(days) {
  const n = parseInt(days, 10);
  return Number.isFinite(n) && n > 0
    ? { sql: ` AND createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)`, params: [n] }
    : { sql: "", params: [] };
}

/** One row per ad: how many distinct customers it brought. */
router.get("/summary", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const since = sinceClause(req.query.days);

    const rows = await query(
      `SELECT
         source_id,
         MAX(ad_title)    AS ad_title,
         MAX(source_url)  AS source_url,
         MAX(source_type) AS source_type,
         MAX(origin)      AS origin,
         COUNT(DISTINCT chat_id) AS customers,
         MIN(createdAt)   AS first_seen,
         MAX(createdAt)   AS last_seen
       FROM chat_ad_source
       WHERE uid = ?${since.sql}
       GROUP BY source_id
       ORDER BY customers DESC, last_seen DESC`,
      [uid, ...since.params],
    );

    const total = rows.reduce((n, r) => n + Number(r.customers || 0), 0);

    res.json({ success: true, data: { ads: rows, total } });
  } catch (err) {
    fail(res, err);
  }
});

/** The customers themselves, newest first. Optionally one ad only. */
router.get("/contacts", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const since = sinceClause(req.query.days);

    const params = [uid, ...since.params];
    let adFilter = "";

    if (req.query.source_id) {
      adFilter = " AND source_id = ?";
      params.push(String(req.query.source_id));
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

    const rows = await query(
      `SELECT sender_mobile, sender_name, chat_id, source_id, ad_title,
              source_url, source_type, origin, createdAt
         FROM chat_ad_source
        WHERE uid = ?${since.sql}${adFilter}
        ORDER BY createdAt DESC
        LIMIT ?`,
      [...params, limit],
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * In-chat lookup
 *
 * Used by the badge the panel shows above an open conversation. Agents
 * need it too, so it accepts either an owner or an agent token and scopes
 * the answer to the owner's data either way.
 *
 * The panel masks numbers for agents (+974******13), so a masked pattern
 * is matched here, where the full numbers live. A pattern that matches
 * more than one customer returns nothing rather than guess.
 * ------------------------------------------------------------------ */

const jwt = require("jsonwebtoken");

/** Resolve the owner uid behind either kind of token. */
async function ownerFromToken(req) {
  const header = req.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;

  let decoded;
  try {
    decoded = jwt.verify(header.split(" ")[1], process.env.JWTKEY);
  } catch {
    return null;
  }

  if (decoded?.role === "user" && decoded.uid) {
    const [user] = await query(
      `SELECT uid FROM user WHERE uid = ? AND role = 'user' LIMIT 1`,
      [decoded.uid],
    );
    return user ? user.uid : null;
  }

  if (decoded?.role === "agent" && decoded.uid) {
    const [agent] = await query(
      `SELECT owner_uid FROM agents WHERE uid = ? LIMIT 1`,
      [decoded.uid],
    );
    return agent ? agent.owner_uid : null;
  }

  return null;
}

router.get("/lookup", async (req, res) => {
  try {
    const uid = await ownerFromToken(req);
    if (!uid) return res.json({ success: false, msg: "No token found" });

    const raw = String(req.query.mobile || "");
    const masked = raw.indexOf("*") !== -1;

    // Keep digits and the mask marker only.
    const cleaned = raw.replace(/[^\d*]/g, "");
    if (cleaned.replace(/\*/g, "").length < 4) {
      return res.json({ success: true, data: null });
    }

    let rows;

    if (masked) {
      const head = cleaned.slice(0, cleaned.indexOf("*"));
      const tail = cleaned.slice(cleaned.lastIndexOf("*") + 1);
      if (head.length < 2 || tail.length < 2) {
        return res.json({ success: true, data: null });
      }

      rows = await query(
        `SELECT DISTINCT sender_mobile, source_id, ad_title, source_url, createdAt
           FROM chat_ad_source
          WHERE uid = ? AND sender_mobile LIKE ? AND sender_mobile LIKE ?
          ORDER BY createdAt DESC
          LIMIT 5`,
        [uid, head + "%", "%" + tail],
      );

      // Ambiguous match -> say nothing rather than attribute the wrong ad.
      const distinct = new Set(rows.map((r) => r.sender_mobile));
      if (distinct.size > 1) return res.json({ success: true, data: null });
    } else {
      rows = await query(
        `SELECT sender_mobile, source_id, ad_title, source_url, createdAt
           FROM chat_ad_source
          WHERE uid = ? AND sender_mobile LIKE ?
          ORDER BY createdAt DESC
          LIMIT 1`,
        [uid, "%" + cleaned.slice(-9)],
      );
    }

    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ success: true, data: null });
    }
    logger.log(err);
    res.json({ success: false, msg: "something went wrong" });
  }
});

module.exports = router;

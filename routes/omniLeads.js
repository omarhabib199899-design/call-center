// Lead Sources page (/#ad-sources in the new panel)

const express = require("express");
const router = express.Router();
const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const logger = require("../utils/logger");

const ACTIVE_DAYS = 7;
const PLATFORMS = ["instagram", "facebook", "tiktok", "whatsapp", "other"];

function fail(res, err) {
  if (err?.code === "ER_NO_SUCH_TABLE") {
    return res.json({ success: true, data: null, missing: true });
  }
  logger.log(err);
  res.json({ success: false, msg: "something went wrong" });
}

// SQL expression giving the platform of a row
const PLATFORM_SQL = `CASE
  WHEN source_url LIKE '%instagram.%' THEN 'instagram'
  WHEN source_url LIKE '%facebook.%' OR source_url LIKE '%fb.me%' OR source_url LIKE '%fb.com%' OR source_url LIKE '%fb.watch%' THEN 'facebook'
  WHEN source_url LIKE '%tiktok.%' THEN 'tiktok'
  WHEN origin IN ('instagram','instagram_comment') THEN 'instagram'
  WHEN origin = 'messenger' THEN 'facebook'
  WHEN origin IN ('qr','meta') THEN 'whatsapp'
  ELSE 'other' END`;

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);

// [from, to) as Date objects, plus the previous period of the same length
function range(q) {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  let to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? new Date(q.to + "T00:00:00Z") : today;
  let from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "")
    ? new Date(q.from + "T00:00:00Z")
    : new Date(to - 29 * DAY);
  if (from > to) [from, to] = [to, from];
  if (to - from > 366 * DAY) from = new Date(to - 366 * DAY);
  const end = new Date(+to + DAY);
  const len = end - from;
  return { from, end, prevFrom: new Date(from - len), prevEnd: from, days: Math.round(len / DAY) };
}

function where(uid, a, b, platform, extra = "") {
  const params = [uid, a, b];
  let sql = `uid = ? AND createdAt >= ? AND createdAt < ?`;
  if (PLATFORMS.includes(platform)) {
    sql += ` AND ${PLATFORM_SQL} = ?`;
    params.push(platform);
  }
  return { sql: sql + extra, params };
}

const pct = (now, prev) => (prev ? ((now - prev) / prev) * 100 : now ? null : 0);

router.get("/overview", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const r = range(req.query);
    const platform = String(req.query.platform || "");

    const cur = where(uid, r.from, r.end, platform);
    const prev = where(uid, r.prevFrom, r.prevEnd, platform);

    const [[tot], [ptot]] = await Promise.all([
      query(
        `SELECT COUNT(DISTINCT chat_id) leads, COUNT(DISTINCT source_id) ads FROM chat_ad_source WHERE ${cur.sql}`,
        cur.params,
      ),
      query(
        `SELECT COUNT(DISTINCT chat_id) leads, COUNT(DISTINCT source_id) ads FROM chat_ad_source WHERE ${prev.sql}`,
        prev.params,
      ),
    ]);

    const byPlat = await query(
      `SELECT ${PLATFORM_SQL} platform, COUNT(DISTINCT chat_id) leads, COUNT(DISTINCT source_id) ads
         FROM chat_ad_source WHERE ${cur.sql} GROUP BY platform`,
      cur.params,
    );
    const byPlatPrev = await query(
      `SELECT ${PLATFORM_SQL} platform, COUNT(DISTINCT chat_id) leads
         FROM chat_ad_source WHERE ${prev.sql} GROUP BY platform`,
      prev.params,
    );
    const prevMap = new Map(byPlatPrev.map((p) => [p.platform, Number(p.leads)]));

    // Ads active right now = brought someone in the last 7 days (any period filter aside)
    const act = where(uid, new Date(Date.now() - ACTIVE_DAYS * DAY), new Date(Date.now() + DAY), platform);
    const [[active]] = await Promise.all([
      query(`SELECT COUNT(DISTINCT source_id) n FROM chat_ad_source WHERE ${act.sql}`, act.params),
    ]);
    const activePlat = await query(
      `SELECT COUNT(DISTINCT ${PLATFORM_SQL}) n FROM chat_ad_source WHERE ${act.sql}`,
      act.params,
    );

    const [best] = await query(
      `SELECT source_id, MAX(ad_title) ad_title, ${PLATFORM_SQL} platform, COUNT(DISTINCT chat_id) leads
         FROM chat_ad_source WHERE ${cur.sql}
        GROUP BY source_id, platform ORDER BY leads DESC, MAX(createdAt) DESC LIMIT 1`,
      cur.params,
    );

    const leads = Number(tot.leads || 0);
    const sumPlat = byPlat.reduce((s, p) => s + Number(p.leads), 0) || 1;
    res.json({
      success: true,
      data: {
        from: iso(r.from),
        to: iso(new Date(+r.end - DAY)),
        days: r.days,
        leads,
        prevLeads: Number(ptot.leads || 0),
        leadsDelta: pct(leads, Number(ptot.leads || 0)),
        ads: Number(tot.ads || 0),
        adsDelta: Number(tot.ads || 0) - Number(ptot.ads || 0),
        activeAds: Number(active.n || 0),
        activePlatforms: Number(activePlat[0]?.n || 0),
        best: best
          ? {
              source_id: best.source_id,
              title: best.ad_title || null,
              platform: best.platform,
              leads: Number(best.leads),
              share: leads ? (Number(best.leads) / leads) * 100 : 0,
            }
          : null,
        platforms: PLATFORMS.map((p) => {
          const row = byPlat.find((x) => x.platform === p);
          const n = Number(row?.leads || 0);
          return {
            platform: p,
            leads: n,
            share: (n / sumPlat) * 100,
            ads: Number(row?.ads || 0),
            delta: pct(n, prevMap.get(p) || 0),
          };
        }),
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/ads", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const r = range(req.query);
    const platform = String(req.query.platform || "");
    const q = String(req.query.q || "").trim();
    const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 6));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const all = String(req.query.all || "") === "1";

    let extra = "";
    const xp = [];
    if (q) {
      extra = ` AND (ad_title LIKE ? OR source_id LIKE ? OR ad_body LIKE ?)`;
      xp.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const w = where(uid, r.from, r.end, platform, extra);
    const params = [...w.params, ...xp];

    const [{ leads: total }] = await query(
      `SELECT COUNT(DISTINCT chat_id) leads FROM chat_ad_source WHERE ${where(uid, r.from, r.end, platform).sql}`,
      where(uid, r.from, r.end, platform).params,
    );
    const [{ n }] = await query(
      `SELECT COUNT(DISTINCT source_id) n FROM chat_ad_source WHERE ${w.sql}`,
      params,
    );

    const rows = await query(
      `SELECT source_id, MAX(ad_title) ad_title, MAX(ad_body) ad_body, MAX(source_url) source_url,
              MAX(source_type) source_type, MAX(thumbnail_url) thumbnail_url, MAX(${PLATFORM_SQL}) platform,
              COUNT(DISTINCT chat_id) leads, MIN(createdAt) first_at, MAX(createdAt) last_at
         FROM chat_ad_source WHERE ${w.sql}
        GROUP BY source_id
        ORDER BY leads DESC, last_at DESC
        ${all ? "LIMIT 5000" : `LIMIT ${size} OFFSET ${(page - 1) * size}`}`,
      params,
    );

    // "Active" looks at all time, not just the selected period
    const ids = rows.map((x) => x.source_id).filter((x) => x != null);
    const lastEver = ids.length
      ? await query(
          `SELECT source_id, MAX(createdAt) last_at FROM chat_ad_source WHERE uid = ? AND source_id IN (${ids
            .map(() => "?")
            .join(",")}) GROUP BY source_id`,
          [uid, ...ids],
        )
      : [];
    const lastMap = new Map(lastEver.map((x) => [x.source_id, x.last_at]));
    const cutoff = Date.now() - ACTIVE_DAYS * DAY;

    res.json({
      success: true,
      data: {
        total: Number(n),
        page,
        size,
        rows: rows.map((x) => {
          const last = lastMap.get(x.source_id) || x.last_at;
          return {
            source_id: x.source_id,
            title: x.ad_title || null,
            body: x.ad_body || null,
            url: x.source_url || null,
            type: x.source_type || null,
            thumbnail: x.thumbnail_url || null,
            platform: x.platform,
            leads: Number(x.leads),
            share: Number(total) ? (Number(x.leads) / Number(total)) * 100 : 0,
            first_at: x.first_at,
            last_at: x.last_at,
            active: new Date(last).getTime() >= cutoff,
          };
        }),
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/customers", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const r = range(req.query);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = 10;
    const sid = req.query.source_id;
    const w = where(
      uid,
      r.from,
      r.end,
      "",
      sid === "" || sid == null ? " AND source_id IS NULL" : " AND source_id = ?",
    );
    const params = sid === "" || sid == null ? w.params : [...w.params, String(sid)];
    const [{ n }] = await query(`SELECT COUNT(*) n FROM chat_ad_source WHERE ${w.sql}`, params);
    const rows = await query(
      `SELECT chat_id, sender_name, sender_mobile, origin, createdAt FROM chat_ad_source
        WHERE ${w.sql} ORDER BY createdAt DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
      params,
    );
    res.json({ success: true, data: { total: Number(n), page, size, rows } });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

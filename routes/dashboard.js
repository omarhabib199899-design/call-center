// Home dashboard numbers for the new panel (/new/#home)

const express = require("express");
const router = express.Router();
const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const logger = require("../utils/logger");
const { listOwnerAccounts } = require("../helper/agentAccounts");
const { buildAgentChatCondition } = require("../helper/agentInstances");

const CHANNEL_OF = {
  qr: "whatsapp",
  meta: "whatsapp",
  telegram: "telegram",
  instagram: "instagram",
  instagram_comment: "instagram",
  messenger: "messenger",
};
const CHANNELS = ["whatsapp", "telegram", "instagram", "messenger"];

let msgTimeExpr = null;
// SQL expression giving a DATETIME for a beta_conversation row
async function messageTime() {
  if (msgTimeExpr) return msgTimeExpr;
  let hasCreated = false;
  try {
    const cols = await query(`SHOW COLUMNS FROM beta_conversation LIKE 'createdAt'`);
    hasCreated = cols.length > 0;
  } catch {}
  msgTimeExpr = hasCreated
    ? "createdAt"
    : "FROM_UNIXTIME(IF(CAST(`timestamp` AS UNSIGNED) > 100000000000, CAST(`timestamp` AS UNSIGNED) / 1000, CAST(`timestamp` AS UNSIGNED)))";
  return msgTimeExpr;
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dayKey(d) {
  return fmt(d).slice(0, 10);
}

// Run one block; on error log it and return null instead of failing
async function soft(name, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.log(`[dashboard] ${name}: ${err?.message || err}`);
    return null;
  }
}

// Fill a { 'YYYY-MM-DD': n } map into an array covering every day
function series(map, start, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    out.push(Number(map[dayKey(d)] || 0));
  }
  return out;
}

// Small per-owner cache: the page polls, the queries scan message tables
const cache = new Map();
const TTL = 60 * 1000;

router.get("/overview", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;

    const cacheKey = `${uid}:${days}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < TTL) return res.json(hit.body);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(today.getTime() - (days - 1) * 86400000);
    const prevStart = new Date(start.getTime() - days * 86400000);
    const T = await messageTime();

    // Messages per day and route, current period (feeds 3 blocks)
    const perDay = await soft("perDay", () =>
      query(
        `SELECT DATE_FORMAT(${T}, '%Y-%m-%d') d, route, origin, COUNT(*) n, COUNT(DISTINCT chat_id) c
           FROM beta_conversation
          WHERE uid = ? AND ${T} >= ?
          GROUP BY d, route, origin`,
        [uid, fmt(start)],
      ),
    );

    const conversations = await soft("conversations", async () => {
      const [row] = await query(
        `SELECT COUNT(DISTINCT CASE WHEN ${T} >= ? THEN chat_id END) cur,
                COUNT(DISTINCT CASE WHEN ${T} < ? THEN chat_id END) prev
           FROM beta_conversation
          WHERE uid = ? AND ${T} >= ?`,
        [fmt(start), fmt(start), uid, fmt(prevStart)],
      );
      const daily = {};
      for (const r of perDay || []) daily[r.d] = (daily[r.d] || 0) + Number(r.c);
      return { value: Number(row.cur), prev: Number(row.prev), series: series(daily, start, days) };
    });

    const messagesSent = await soft("messagesSent", async () => {
      const [row] = await query(
        `SELECT SUM(${T} >= ?) cur, SUM(${T} < ?) prev
           FROM beta_conversation
          WHERE uid = ? AND route = 'OUTGOING' AND ${T} >= ?`,
        [fmt(start), fmt(start), uid, fmt(prevStart)],
      );
      const daily = {};
      for (const r of perDay || []) if (r.route === "OUTGOING") daily[r.d] = (daily[r.d] || 0) + Number(r.n);
      return { value: Number(row.cur || 0), prev: Number(row.prev || 0), series: series(daily, start, days) };
    });

    const automations = await soft("automations", async () => {
      const [row] = await query(
        `SELECT SUM(active = 1) active, COUNT(*) total FROM beta_chatbot WHERE uid = ?`,
        [uid],
      );
      return { value: Number(row.active || 0), total: Number(row.total || 0) };
    });

    const agents = await soft("agents", () =>
      query(`SELECT id, uid, name, email, is_active FROM agents WHERE owner_uid = ? ORDER BY name`, [uid]),
    );
    const team = agents && {
      value: agents.filter((a) => Number(a.is_active) === 1).length,
      total: agents.length,
    };

    const channels = await soft("channels", async () => {
      const accounts = await listOwnerAccounts(uid);
      // Channel comes from the chat row (one per chat)
      const counts = await query(
        `SELECT c.origin, COUNT(*) n
           FROM beta_chats c
           JOIN (SELECT DISTINCT chat_id FROM beta_conversation
                  WHERE uid = ? AND ${T} >= ?) m ON m.chat_id = c.chat_id
          WHERE c.uid = ?
          GROUP BY c.origin`,
        [uid, fmt(start), uid],
      );
      return CHANNELS.map((id) => {
        const acc = accounts.filter((a) => CHANNEL_OF[a.channel] === id);
        return {
          id,
          accounts: new Set(acc.map((a) => a.key)).size,
          online: acc.some((a) => a.online),
          conversations: counts
            .filter((c) => CHANNEL_OF[c.origin] === id)
            .reduce((s, c) => s + Number(c.n), 0),
        };
      });
    });

    const activity = await soft("activity", async () => {
      const inc = {};
      const out = {};
      for (const r of perDay || []) {
        const k = r.d;
        if (r.route === "OUTGOING") out[k] = (out[k] || 0) + Number(r.n);
        else inc[k] = (inc[k] || 0) + Number(r.n);
      }
      // Of the chats that wrote in, how many got at least one reply
      const [rr] = await query(
        `SELECT COUNT(*) asked, SUM(replied) replied FROM (
           SELECT chat_id, MAX(route = 'OUTGOING') replied
             FROM beta_conversation
            WHERE uid = ? AND ${T} >= ?
            GROUP BY chat_id
           HAVING SUM(route = 'INCOMING') > 0
         ) x`,
        [uid, fmt(start)],
      );
      const incoming = series(inc, start, days);
      const outgoing = series(out, start, days);
      return {
        start: dayKey(start),
        incoming,
        outgoing,
        incomingTotal: incoming.reduce((a, b) => a + b, 0),
        outgoingTotal: outgoing.reduce((a, b) => a + b, 0),
        responseRate: Number(rr.asked) ? Number(rr.replied || 0) / Number(rr.asked) : null,
      };
    });

    // Sales recorded from the new Inbox (routes/omniInbox.js -> omni_sales)
    const sales = await soft("sales", async () => {
      const rows = await query(
        `SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') d, currency, SUM(amount) amt, COUNT(*) n, createdAt >= ? cur
           FROM omni_sales WHERE owner_uid = ? AND createdAt >= ?
          GROUP BY d, currency, cur`,
        [fmt(start), uid, fmt(prevStart)],
      );
      // One headline currency: the one with the most sales this period
      const byCur = {};
      for (const r of rows) if (Number(r.cur)) byCur[r.currency] = (byCur[r.currency] || 0) + Number(r.amt);
      const currency =
        Object.keys(byCur).sort((a, b) => byCur[b] - byCur[a])[0] || (rows[0]?.currency ?? "EGP");
      const daily = {};
      let value = 0,
        prev = 0,
        orders = 0;
      for (const r of rows) {
        if (r.currency !== currency) continue;
        if (Number(r.cur)) {
          value += Number(r.amt);
          orders += Number(r.n);
          daily[r.d] = (daily[r.d] || 0) + Number(r.amt);
        } else prev += Number(r.amt);
      }
      return {
        value,
        prev,
        orders,
        currency,
        otherCurrencies: Object.keys(byCur).filter((c) => c !== currency),
        series: series(daily, start, days),
      };
    });

    // Workflow runs counted by helper/omniStats.js (automation/automation.js hook)
    const automationPerf = await soft("automationPerf", async () => {
      const week = new Date(today.getTime() - 6 * 86400000);
      const from = week < start ? week : start;
      const rows = await query(
        `SELECT DATE_FORMAT(day, '%Y-%m-%d') d, SUM(ok_count) ok, SUM(fail_count) fail
           FROM omni_flow_daily WHERE owner_uid = ? AND day >= ? GROUP BY d`,
        [uid, dayKey(from)],
      );
      const map = new Map(rows.map((r) => [r.d, r]));
      const last7 = [];
      for (let i = 0; i < 7; i++) {
        const k = dayKey(new Date(week.getTime() + i * 86400000));
        last7.push({ d: k, ok: Number(map.get(k)?.ok || 0), fail: Number(map.get(k)?.fail || 0) });
      }
      let ok = 0,
        fail = 0;
      for (const r of rows) if (r.d >= dayKey(start)) (ok += Number(r.ok)), (fail += Number(r.fail));
      const [prevRow] = await query(
        `SELECT SUM(ok_count) ok, SUM(fail_count) fail FROM omni_flow_daily WHERE owner_uid = ? AND day >= ? AND day < ?`,
        [uid, dayKey(prevStart), dayKey(start)],
      );
      const failing = await query(
        `SELECT f.flow_id, SUM(f.fail_count) fail, MAX(f.day) last FROM omni_flow_daily f
          WHERE f.owner_uid = ? AND f.day >= ? AND f.fail_count > 0 GROUP BY f.flow_id ORDER BY last DESC LIMIT 5`,
        [uid, dayKey(start)],
      );
      return { last7, ok, fail, prevRuns: Number(prevRow?.ok || 0) + Number(prevRow?.fail || 0), failing };
    });

    const recent = await soft("recent", async () => {
      const rows = await query(
        `SELECT chat_id, sender_name, sender_mobile, last_message, origin, unread_count, updatedAt
           FROM beta_chats WHERE uid = ? ORDER BY updatedAt DESC LIMIT 6`,
        [uid],
      );
      const items = rows.map((r) => {
        let text = r.last_message || "";
        try {
          const m = JSON.parse(text);
          text = m?.msgContext?.text?.body || m?.msgContext?.caption || m?.type || "";
        } catch {}
        return {
          chat_id: r.chat_id,
          channel: CHANNEL_OF[r.origin] || "whatsapp",
          name: r.sender_name || "",
          mobile: r.sender_mobile || "",
          text: String(text).slice(0, 80),
          unread: Number(r.unread_count || 0),
          at: r.updatedAt,
          kind: "chat",
        };
      });
      // Sales, assignments/status changes and failing workflows
      const extra = [];
      const s = await query(
        `SELECT chat_key, customer_name, agent_name, amount, currency, createdAt FROM omni_sales WHERE owner_uid = ? ORDER BY id DESC LIMIT 4`,
        [uid],
      ).catch(() => []);
      for (const x of s)
        extra.push({
          kind: "sale",
          chat_id: x.chat_key,
          name: x.customer_name || "",
          text: `${x.agent_name ? `${x.agent_name} closed` : "Sale of"} ${x.currency} ${Number(x.amount).toLocaleString("en-US")}`,
          at: x.createdAt,
        });
      const ev = await query(
        `SELECT chat_key, kind, text, actor, createdAt FROM omni_chat_events WHERE owner_uid = ? AND kind IN ('resolved','open') ORDER BY id DESC LIMIT 3`,
        [uid],
      ).catch(() => []);
      for (const x of ev)
        extra.push({
          kind: x.kind === "resolved" ? "resolved" : "reopened",
          chat_id: x.chat_key,
          name: x.actor || "",
          text: x.text,
          at: x.createdAt,
        });
      for (const f of automationPerf?.failing || []) {
        const [flow] = await query(`SELECT title FROM flow WHERE flow_id = ? AND uid = ? LIMIT 1`, [
          f.flow_id,
          uid,
        ]).catch(() => []);
        extra.push({
          kind: "automation_failed",
          name: flow?.title || "Workflow",
          text: `Failed ${f.fail} ${Number(f.fail) === 1 ? "time" : "times"} this period`,
          at: f.last,
        });
      }
      return [...items, ...extra].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8);
    });

    const teamPerf = await soft("team", async () => {
      const active = (agents || []).filter((a) => Number(a.is_active) === 1).slice(0, 25);
      const rows = [];
      for (const a of active) {
        const cond = await buildAgentChatCondition(a.id, a.uid);
        const [r] = await query(
          `SELECT COUNT(*) n, SUM(unread_count > 0) waiting FROM beta_chats
            WHERE uid = ? AND updatedAt >= ? AND ${cond.sql}`,
          [uid, fmt(start), ...cond.params],
        );
        rows.push({
          uid: a.uid,
          name: a.name,
          email: a.email,
          conversations: Number(r.n),
          waiting: Number(r.waiting || 0),
        });
      }
      // Sales per agent in this period, and this month against the agent's monthly target
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const ss = await query(
        `SELECT agent_uid, SUM(CASE WHEN createdAt >= ? THEN amount ELSE 0 END) period, SUM(CASE WHEN createdAt >= ? THEN amount ELSE 0 END) month
           FROM omni_sales WHERE owner_uid = ? AND createdAt >= ? GROUP BY agent_uid`,
        [fmt(start), fmt(monthStart), uid, fmt(start < monthStart ? start : monthStart)],
      ).catch(() => []);
      const tg = await query(`SELECT agent_uid, sales_target FROM omni_agent_settings WHERE owner_uid = ?`, [
        uid,
      ]).catch(() => []);
      for (const r of rows) {
        const x = ss.find((y) => y.agent_uid === r.uid);
        const t = Number(tg.find((y) => y.agent_uid === r.uid)?.sales_target || 0);
        r.sales = Number(x?.period || 0);
        r.monthSales = Number(x?.month || 0);
        r.target = t || null;
        r.achievement = t ? Number(x?.month || 0) / t : null;
      }
      const total = conversations?.value || rows.reduce((s, r) => s + r.conversations, 0);
      return rows
        .map((r) => ({ ...r, share: total ? r.conversations / total : 0 }))
        .sort((a, b) => b.conversations - a.conversations);
    });

    const body = {
      success: true,
      data: {
        days,
        generatedAt: now.toISOString(),
        kpis: { conversations, automations, team, messagesSent, sales },
        automationPerf,
        channels,
        activity,
        recent,
        team: teamPerf,
      },
    };
    cache.set(cacheKey, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    logger.log(err);
    res.json({ success: false, msg: "something went wrong" });
  }
});

module.exports = router;

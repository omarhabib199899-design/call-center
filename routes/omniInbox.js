/**
 * [CUSTOM] Backend for the new Inbox (/#inbox in the new panel).
 * Accepts an owner token or an agent token. Mounted at /api/omni_inbox.
 *
 * Messages are still loaded and sent over the stock socket
 * (helper/socket/index.js: load_conversation, send_chat_message, notes,
 * labels, assignment), so delivery works exactly as in the classic inbox.
 * This file only adds what the new design needs on top:
 *
 *   GET  /chats          list with platform / account / status filters + counts
 *   GET  /chat?chat_id=  one chat (deep links)
 *   POST /status         {chat_id, status: open|pending|resolved}
 *   POST /priority       {chat_id, on}
 *   GET  /activity?chat_id=   status changes, notes, sales for the customer panel
 *   POST /sale           {chat_id, amount, currency, note}   (Home "Total Sales")
 *   POST /sale/remove    {id}
 *   GET  /accounts       accounts the signed-in person can send from
 *   GET  /customers?q=   existing customers, for "New conversation"
 *
 * Status rules: a chat is Open unless someone set it Pending or Resolved,
 * and a new customer message after that puts it back to Open.
 */

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { query } = require("../database/dbpromise");
const logger = require("../utils/logger");
const { buildAgentChatCondition } = require("../helper/agentInstances");
const A = require("../helper/agentAccounts");

/* ---------- auth: owner or agent ---------- */

async function who(req, res, next) {
  try {
    const h = req.get("Authorization") || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, msg: "No token found" });
    let d;
    try {
      d = jwt.verify(h.split(" ")[1], process.env.JWTKEY);
    } catch {
      return res.status(401).json({ success: false, msg: "Invalid token found" });
    }
    if (d?.role === "user" && d.uid) {
      const [u] = await query(`SELECT * FROM user WHERE uid = ? LIMIT 1`, [d.uid]);
      if (!u) return res.status(401).json({ success: false, msg: "Invalid token found" });
      req.who = { ownerUid: u.uid, isAgent: false, name: u.name || u.email || "Owner", email: u.email, me: u };
      return next();
    }
    if (d?.role === "agent" && d.uid && d.owner_uid) {
      const [a] = await query(`SELECT * FROM agents WHERE uid = ? AND owner_uid = ? LIMIT 1`, [d.uid, d.owner_uid]);
      if (!a || !Number(a.is_active ?? 1)) return res.status(401).json({ success: false, msg: "Invalid agent token" });
      if (typeof d.tokenVersion !== "undefined" && Number(a.tokenVersion || 0) !== Number(d.tokenVersion || 0)) {
        return res.status(401).json({ success: false, msg: "Session expired. Please login again.", logout: true });
      }
      req.who = { ownerUid: a.owner_uid, isAgent: true, agent: a, name: a.name || a.email, email: a.email };
      return next();
    }
    return res.status(401).json({ success: false, msg: "Unauthorized token" });
  } catch (err) {
    fail(res, err);
  }
}

function fail(res, err) {
  logger.log(err);
  res.json({ success: false, msg: "something went wrong" });
}

/* ---------- tables ---------- */

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS omni_chat_state (
        owner_uid VARCHAR(191) NOT NULL,
        chat_key VARCHAR(191) NOT NULL,
        s_status VARCHAR(16) NOT NULL DEFAULT 'open',
        s_priority TINYINT NOT NULL DEFAULT 0,
        s_since BIGINT NOT NULL DEFAULT 0,
        s_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_uid, chat_key)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS omni_chat_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_uid VARCHAR(191) NOT NULL,
        chat_key VARCHAR(191) NOT NULL,
        kind VARCHAR(30) NOT NULL,
        text VARCHAR(500) NULL,
        actor VARCHAR(191) NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_chat (owner_uid, chat_key)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS omni_sales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_uid VARCHAR(191) NOT NULL,
        chat_key VARCHAR(191) NULL,
        customer_name VARCHAR(191) NULL,
        agent_uid VARCHAR(191) NULL,
        agent_name VARCHAR(191) NULL,
        amount DECIMAL(14,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'EGP',
        note VARCHAR(300) NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_owner (owner_uid, createdAt)
      )`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/* ---------- scope ---------- */

const PLATFORM_ORIGINS = {
  whatsapp: ["qr", "meta"],
  instagram: ["instagram", "instagram_comment"],
  messenger: ["messenger"],
  telegram: ["telegram"],
};

/** WHERE fragment for the chats this person may see (columns unqualified, table beta_chats). */
async function scope(w) {
  if (!w.isAgent) return { sql: `uid = ?`, params: [w.ownerUid] };
  const s = await buildAgentChatCondition(w.agent.id, w.agent.uid);
  return { sql: `uid = ? AND ${s.sql}`, params: [w.ownerUid, ...s.params] };
}

/** Last customer message time, in seconds, from beta_chats.last_message. */
const LAST_IN = `(CASE WHEN JSON_VALID(c.last_message) AND JSON_UNQUOTE(JSON_EXTRACT(c.last_message,'$.route')) = 'INCOMING'
  THEN (CASE WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(c.last_message,'$.timestamp')) AS DECIMAL(20,0)) > 100000000000
    THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(c.last_message,'$.timestamp')) AS DECIMAL(20,0)) / 1000
    ELSE CAST(JSON_UNQUOTE(JSON_EXTRACT(c.last_message,'$.timestamp')) AS DECIMAL(20,0)) END)
  ELSE 0 END)`;
const STATUS = `(CASE WHEN s.s_status IN ('pending','resolved') AND ${LAST_IN} <= s.s_since THEN s.s_status ELSE 'open' END)`;

function mineSql(w) {
  if (!w.isAgent) return `(c.assigned_agent IS NULL OR c.assigned_agent IN ('', 'null', '[]'))`;
  const id = String(w.agent.id).replace(/\D/g, "");
  return `(c.assigned_agent LIKE '%"id":${id},%' OR c.assigned_agent LIKE '%"id":${id}}%' OR c.assigned_agent LIKE '%"id":"${id}"%')`;
}

function parse(v, fallback) {
  if (v == null || v === "") return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

async function decorate(w, rows) {
  if (!rows.length) return [];
  const mobiles = [...new Set(rows.map((r) => r.sender_mobile).filter(Boolean))];
  const contacts = mobiles.length
    ? await query(`SELECT mobile, name FROM contact WHERE uid = ? AND mobile IN (${mobiles.map(() => "?").join(",")})`, [w.ownerUid, ...mobiles]).catch(() => [])
    : [];
  const cmap = new Map(contacts.map((c) => [c.mobile, c.name]));
  const accounts = await A.listOwnerAccounts(w.ownerUid).catch(() => []);
  return rows.map((r) => {
    const inst = parse(r.origin_instance_id, {});
    const key = accountKeyOf(r, inst);
    const acc = accounts.find((a) => a.key === key);
    return {
      id: r.id,
      chat_id: r.chat_id,
      origin: r.origin,
      origin_instance_id: r.origin_instance_id,
      sender_name: r.sender_name,
      sender_mobile: r.sender_mobile,
      contact_name: cmap.get(r.sender_mobile) || null,
      last_message: parse(r.last_message, null),
      unread_count: Number(r.unread_count || 0),
      chat_label: [].concat(parse(r.chat_label, []) || []).filter(Boolean),
      assigned_agent: [].concat(parse(r.assigned_agent, []) || []).filter(Boolean).map((a) => ({ id: a.id, uid: a.uid, name: a.name, email: a.email })),
      has_note: !!(r.chat_note && r.chat_note !== "[]"),
      status: r.eff_status || "open",
      priority: !!Number(r.s_priority || 0),
      account_key: key,
      account_name: acc?.name || (inst?.name ? String(inst.name) : null),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

function accountKeyOf(r, inst) {
  const id = String(inst?.id ?? "");
  if (r.origin === "meta") return "meta:all";
  if (r.origin === "telegram") return "telegram:all";
  if (r.origin === "messenger") return `messenger:${id.replace(/[^A-Za-z0-9]/g, "")}`;
  if (r.origin === "instagram" || r.origin === "instagram_comment") return `instagram:${id.replace(/[^A-Za-z0-9]/g, "")}`;
  const num = id.split(/[:@]/)[0].replace(/\D/g, "");
  return num ? `qr:${num}` : null;
}

/* ---------- list ---------- */

router.get("/chats", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const sc = await scope(w);

    // The agent scope uses unqualified columns; they are unique to beta_chats except chat_id.
    const scopeSql = sc.sql.replace(/\bchat_id\b/g, "c.chat_id").replace(/^uid = \?/, "c.uid = ?");
    const where = [scopeSql];
    const params = [...sc.params];

    const platform = String(req.query.platform || "");
    if (PLATFORM_ORIGINS[platform]) {
      where.push(`c.origin IN (${PLATFORM_ORIGINS[platform].map(() => "?").join(",")})`);
      params.push(...PLATFORM_ORIGINS[platform]);
    }
    const acc = A.parseKey(String(req.query.account || ""));
    if (acc) {
      const m = A.accountMatch(acc.channel, acc.account_id);
      if (m) {
        where.push(m.sql.replace(/\borigin_instance_id\b/g, "c.origin_instance_id").replace(/\borigin\b(?!_)/g, "c.origin"));
        params.push(...m.params);
      }
    }
    const q = String(req.query.q || "").trim();
    if (q) {
      where.push(`(c.sender_name LIKE ? OR c.sender_mobile LIKE ? OR c.last_message LIKE ? OR c.chat_label LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%"title":"%${q}%`);
    }
    if (String(req.query.labeled || "") === "1") where.push(`(c.chat_label IS NOT NULL AND c.chat_label NOT IN ('', '[]', 'null'))`);

    const from = `FROM beta_chats c LEFT JOIN omni_chat_state s ON s.owner_uid = c.uid AND s.chat_key = c.chat_id WHERE ${where.join(" AND ")}`;

    const [counts] = await query(
      `SELECT COUNT(*) total,
              SUM(c.unread_count > 0) unread,
              SUM(${STATUS} = 'open') open,
              SUM(${STATUS} = 'pending') pending,
              SUM(${STATUS} = 'resolved') resolved,
              SUM(${mineSql(w)}) mine
         ${from}`,
      params,
    );

    const view = String(req.query.view || "all");
    const vWhere = [];
    if (view === "unread") vWhere.push(`c.unread_count > 0`);
    else if (["open", "pending", "resolved"].includes(view)) vWhere.push(`${STATUS} = '${view}'`);
    else if (view === "mine") vWhere.push(mineSql(w));

    const sort = String(req.query.sort || "newest");
    const order =
      sort === "oldest" ? `c.updatedAt ASC` : sort === "unread" ? `(c.unread_count > 0) DESC, c.updatedAt DESC` : sort === "priority" ? `COALESCE(s.s_priority,0) DESC, c.updatedAt DESC` : `c.updatedAt DESC`;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const fullFrom = vWhere.length ? `${from} AND ${vWhere.join(" AND ")}` : from;
    const [{ n }] = vWhere.length ? await query(`SELECT COUNT(*) n ${fullFrom}`, params) : [{ n: counts.total }];
    const rows = await query(
      `SELECT c.*, ${STATUS} eff_status, s.s_priority ${fullFrom} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    res.json({
      success: true,
      data: {
        rows: await decorate(w, rows),
        total: Number(n || 0),
        offset,
        counts: {
          all: Number(counts.total || 0),
          unread: Number(counts.unread || 0),
          open: Number(counts.open || 0),
          pending: Number(counts.pending || 0),
          resolved: Number(counts.resolved || 0),
          mine: Number(counts.mine || 0),
        },
        me: { isAgent: w.isAgent, uid: w.isAgent ? w.agent.uid : w.ownerUid, name: w.name },
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

async function oneChat(w, chatId) {
  const sc = await scope(w);
  const scopeSql = sc.sql.replace(/\bchat_id\b/g, "c.chat_id").replace(/^uid = \?/, "c.uid = ?");
  const rows = await query(
    `SELECT c.*, ${STATUS} eff_status, s.s_priority FROM beta_chats c
       LEFT JOIN omni_chat_state s ON s.owner_uid = c.uid AND s.chat_key = c.chat_id
      WHERE ${scopeSql} AND c.chat_id = ? LIMIT 1`,
    [...sc.params, String(chatId || "")],
  );
  return (await decorate(w, rows))[0] || null;
}

router.get("/chat", who, async (req, res) => {
  try {
    await ensure();
    const chat = await oneChat(req.who, req.query.chat_id);
    if (!chat) return res.json({ success: false, msg: "Conversation not found" });
    res.json({ success: true, data: chat });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- status / priority ---------- */

async function event(w, chatKey, kind, text) {
  await query(`INSERT INTO omni_chat_events (owner_uid, chat_key, kind, text, actor) VALUES (?,?,?,?,?)`, [w.ownerUid, chatKey, kind, text || null, w.name]);
}

router.post("/status", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const status = String(req.body?.status || "");
    if (!["open", "pending", "resolved"].includes(status)) return res.json({ success: false, msg: "Invalid status" });
    const chat = await oneChat(w, req.body?.chat_id);
    if (!chat) return res.json({ success: false, msg: "Conversation not found" });
    const now = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO omni_chat_state (owner_uid, chat_key, s_status, s_since) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE s_status = VALUES(s_status), s_since = VALUES(s_since)`,
      [w.ownerUid, chat.chat_id, status, now],
    );
    if (chat.status !== status) {
      await event(w, chat.chat_id, status, { open: "Conversation reopened", pending: "Marked as pending", resolved: "Conversation resolved" }[status]);
    }
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/priority", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const chat = await oneChat(w, req.body?.chat_id);
    if (!chat) return res.json({ success: false, msg: "Conversation not found" });
    const on = req.body?.on ? 1 : 0;
    await query(
      `INSERT INTO omni_chat_state (owner_uid, chat_key, s_priority) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE s_priority = VALUES(s_priority)`,
      [w.ownerUid, chat.chat_id, on],
    );
    await event(w, chat.chat_id, "priority", on ? "Marked as priority" : "Priority removed");
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- activity / sales ---------- */

router.get("/activity", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const chat = await oneChat(w, req.query.chat_id);
    if (!chat) return res.json({ success: false, msg: "Conversation not found" });
    const events = await query(
      `SELECT id, kind, text, actor, createdAt FROM omni_chat_events WHERE owner_uid = ? AND chat_key = ? ORDER BY id DESC LIMIT 50`,
      [w.ownerUid, chat.chat_id],
    );
    const sales = await query(
      `SELECT id, amount, currency, note, agent_name, agent_uid, createdAt FROM omni_sales WHERE owner_uid = ? AND chat_key = ? ORDER BY id DESC LIMIT 50`,
      [w.ownerUid, chat.chat_id],
    );
    let source = null;
    try {
      [source] = await query(
        `SELECT source_id, ad_title, source_url, origin, createdAt FROM chat_ad_source WHERE uid = ? AND chat_id = ? ORDER BY createdAt ASC LIMIT 1`,
        [w.ownerUid, chat.chat_id],
      );
    } catch {}
    const [first] = await query(
      `SELECT MIN(timestamp) t, COUNT(*) n FROM beta_conversation WHERE uid = ? AND chat_id = ?`,
      [w.ownerUid, chat.chat_id],
    ).catch(() => [{}]);
    res.json({
      success: true,
      data: { events, sales, source: source || null, firstMessageAt: first?.t || null, messages: Number(first?.n || 0) },
    });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/sale", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const chat = await oneChat(w, req.body?.chat_id);
    if (!chat) return res.json({ success: false, msg: "Conversation not found" });
    const amount = Number(String(req.body?.amount ?? "").replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return res.json({ success: false, field: "amount", msg: "Enter an amount greater than 0" });
    const currency = String(req.body?.currency || "EGP").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8) || "EGP";
    const note = String(req.body?.note || "").trim().slice(0, 300) || null;
    // The agent who handles the chat gets the credit: the person recording it,
    // or (owner recording) the first agent assigned to the chat.
    const credit = w.isAgent ? { uid: w.agent.uid, name: w.agent.name } : chat.assigned_agent[0] ? { uid: chat.assigned_agent[0].uid, name: chat.assigned_agent[0].name } : { uid: null, name: w.name };
    const r = await query(
      `INSERT INTO omni_sales (owner_uid, chat_key, customer_name, agent_uid, agent_name, amount, currency, note) VALUES (?,?,?,?,?,?,?,?)`,
      [w.ownerUid, chat.chat_id, chat.contact_name || chat.sender_name || chat.sender_mobile, credit.uid, credit.name, amount, currency, note],
    );
    await event(w, chat.chat_id, "sale", `Sale recorded: ${currency} ${amount.toLocaleString("en-US")}`);
    res.json({ success: true, data: { id: r.insertId } });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/sale/remove", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const [s] = await query(`SELECT * FROM omni_sales WHERE id = ? AND owner_uid = ? LIMIT 1`, [req.body?.id, w.ownerUid]);
    if (!s) return res.json({ success: false, msg: "Sale not found" });
    if (w.isAgent && s.agent_uid !== w.agent.uid) return res.json({ success: false, msg: "Only the owner can remove another agent's sale" });
    await query(`DELETE FROM omni_sales WHERE id = ? AND owner_uid = ?`, [s.id, w.ownerUid]);
    await event(w, s.chat_key, "sale", `Sale removed: ${s.currency} ${Number(s.amount).toLocaleString("en-US")}`);
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- new conversation ---------- */

router.get("/accounts", who, async (req, res) => {
  try {
    const w = req.who;
    let accounts = await A.listOwnerAccounts(w.ownerUid);
    if (w.isAgent) {
      const mine = new Set(await A.getAgentAccountKeys(w.agent.uid));
      accounts = accounts.filter((a) => mine.has(a.key));
    }
    // WhatsApp numbers: the session to send a first message from.
    const inst = await query(`SELECT uniqueId, number, title, status FROM instance WHERE uid = ? ORDER BY id DESC`, [w.ownerUid]).catch(() => []);
    const seen = new Set();
    const out = [];
    for (const a of accounts) {
      if (seen.has(a.key)) continue;
      seen.add(a.key);
      const item = { key: a.key, channel: a.channel, name: a.name, detail: a.detail, online: a.online, canStart: false };
      if (a.channel === "qr") {
        const s = inst.filter((i) => String(i.number || "").replace(/\D/g, "") === a.account_id);
        const live = s.find((i) => String(i.status || "").toLowerCase().includes("connect")) || s[0];
        if (live) {
          item.instance = { uniqueId: live.uniqueId, number: String(live.number || "").replace(/\D/g, "") };
          item.canStart = true;
        }
      }
      out.push(item);
    }
    res.json({ success: true, data: out });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/customers", who, async (req, res) => {
  try {
    await ensure();
    const w = req.who;
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    const sc = await scope(w);
    const scopeSql = sc.sql.replace(/\bchat_id\b/g, "c.chat_id").replace(/^uid = \?/, "c.uid = ?");
    const rows = await query(
      `SELECT c.*, ${STATUS} eff_status, s.s_priority FROM beta_chats c
         LEFT JOIN omni_chat_state s ON s.owner_uid = c.uid AND s.chat_key = c.chat_id
        WHERE ${scopeSql} AND (c.sender_name LIKE ? OR c.sender_mobile LIKE ?)
        ORDER BY c.updatedAt DESC LIMIT 8`,
      [...sc.params, `%${q}%`, `%${q.replace(/[^\d]/g, "") || q}%`],
    );
    res.json({ success: true, data: await decorate(w, rows) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

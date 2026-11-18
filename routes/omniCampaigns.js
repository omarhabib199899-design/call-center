// Campaigns for the new panel (/new/#campaigns)

const express = require("express");
const router = express.Router();
const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const logger = require("../utils/logger");
const {
  listOwnerAccounts,
  getAgentAccountKeys,
  parseKey,
  toKey,
  accountMatch,
} = require("../helper/agentAccounts");

const TYPES = ["white_friday", "black_friday", "ramadan", "product_launch", "seasonal", "custom"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = query(`CREATE TABLE IF NOT EXISTS omni_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_uid VARCHAR(255) NOT NULL,
      name VARCHAR(120) NOT NULL DEFAULT '',
      type VARCHAR(32) NOT NULL DEFAULT 'custom',
      description VARCHAR(500) NOT NULL DEFAULT '',
      start_date VARCHAR(10) NULL,
      end_date VARCHAR(10) NULL,
      accounts TEXT NULL,
      agents TEXT NULL,
      is_draft TINYINT(1) NOT NULL DEFAULT 1,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_owner (owner_uid)
    )`).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function statusOf(c, now = today()) {
  if (c.is_draft || !c.start_date || !c.end_date) return "draft";
  if (now < c.start_date) return "upcoming";
  if (now > c.end_date) return "completed";
  return "active";
}

function parseList(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function shape(row) {
  const c = {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    start_date: row.start_date,
    end_date: row.end_date,
    accounts: parseList(row.accounts),
    agents: parseList(row.agents),
    is_draft: !!row.is_draft,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  c.status = statusOf(c);
  return c;
}

async function getOwned(ownerUid, id) {
  const [row] = await query(`SELECT * FROM omni_campaigns WHERE id = ? AND owner_uid = ? LIMIT 1`, [
    Number(id) || 0,
    ownerUid,
  ]);
  return row ? shape(row) : null;
}

function fail(res, err) {
  logger.log(err);
  res.json({ success: false, msg: "something went wrong" });
}

// Normalised, de-duplicated account keys the owner really has
async function cleanAccounts(ownerUid, keys) {
  const owned = new Set((await listOwnerAccounts(ownerUid)).map((a) => a.key));
  return [
    ...new Set(
      (Array.isArray(keys) ? keys : [])
        .map(parseKey)
        .filter(Boolean)
        .map((p) => toKey(p.channel, p.account_id))
        .filter((k) => owned.has(k)),
    ),
  ];
}

async function cleanAgents(ownerUid, uids) {
  const list = [...new Set((Array.isArray(uids) ? uids : []).map(String))];
  if (!list.length) return [];
  const rows = await query(`SELECT uid FROM agents WHERE owner_uid = ? AND uid IN (?)`, [ownerUid, list]);
  const ok = new Set(rows.map((r) => r.uid));
  return list.filter((u) => ok.has(u));
}

let msgTime = null;
async function messageTime() {
  if (msgTime) return msgTime;
  let has = false;
  try {
    has = (await query(`SHOW COLUMNS FROM beta_conversation LIKE 'createdAt'`)).length > 0;
  } catch {}
  msgTime = has
    ? "createdAt"
    : "FROM_UNIXTIME(IF(CAST(`timestamp` AS UNSIGNED) > 100000000000, CAST(`timestamp` AS UNSIGNED) / 1000, CAST(`timestamp` AS UNSIGNED)))";
  return msgTime;
}

const statsCache = new Map();

// Conversations and messages on the campaign's accounts within its dates
async function campaignStats(ownerUid, c) {
  if (c.status === "draft" || c.status === "upcoming" || !c.accounts.length) return null;
  const key = `${ownerUid}:${c.id}:${c.updatedAt}:${today()}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;

  const clauses = [];
  const params = [];
  for (const k of c.accounts) {
    const p = parseKey(k);
    const m = p && accountMatch(p.channel, p.account_id);
    if (m) {
      clauses.push(m.sql);
      params.push(...m.params);
    }
  }
  if (!clauses.length) return null;

  const T = await messageTime();
  const from = `${c.start_date} 00:00:00`;
  const to = `${c.status === "active" ? today() : c.end_date} 23:59:59`;

  const chats = await query(`SELECT chat_id FROM beta_chats WHERE uid = ? AND (${clauses.join(" OR ")})`, [
    ownerUid,
    ...params,
  ]);
  const ids = chats.map((r) => r.chat_id);
  let data = { conversations: 0, incoming: 0, outgoing: 0 };
  if (ids.length) {
    const [r] = await query(
      `SELECT COUNT(DISTINCT chat_id) conv, SUM(route = 'INCOMING') inc, SUM(route = 'OUTGOING') outg
         FROM beta_conversation
        WHERE uid = ? AND chat_id IN (?) AND ${T} BETWEEN ? AND ?`,
      [ownerUid, ids, from, to],
    );
    data = {
      conversations: Number(r.conv || 0),
      incoming: Number(r.inc || 0),
      outgoing: Number(r.outg || 0),
    };
  }
  statsCache.set(key, { at: Date.now(), data });
  return data;
}

router.get("/list", validateUser, async (req, res) => {
  try {
    await ensureTable();
    const rows = await query(`SELECT * FROM omni_campaigns WHERE owner_uid = ? ORDER BY updatedAt DESC`, [
      req.decode.uid,
    ]);
    const list = rows.map(shape);
    for (const c of list) {
      c.stats = await campaignStats(req.decode.uid, c).catch((e) => {
        logger.log(e);
        return null;
      });
    }
    res.json({ success: true, data: list, today: today() });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/options", validateUser, async (req, res) => {
  try {
    await ensureTable();
    const uid = req.decode.uid;
    const exclude = Number(req.query.exclude) || 0;

    // Same number with several QR sessions -> one account
    const byKey = new Map();
    for (const a of await listOwnerAccounts(uid)) {
      const cur = byKey.get(a.key);
      if (!cur) byKey.set(a.key, { ...a, names: [a.name] });
      else {
        if (!cur.names.includes(a.name)) cur.names.push(a.name);
        cur.online = cur.online || a.online;
      }
    }
    const accounts = [...byKey.values()].map(({ names, ...a }) => ({ ...a, name: names.join(" · ") }));

    const agentRows = await query(
      `SELECT uid, name, email, is_active FROM agents WHERE owner_uid = ? ORDER BY name ASC`,
      [uid],
    );
    const agents = [];
    for (const a of agentRows) agents.push({ ...a, accounts: await getAgentAccountKeys(a.uid) });

    // Accounts already used by another running or upcoming campaign
    const others = (
      await query(`SELECT * FROM omni_campaigns WHERE owner_uid = ? AND id <> ?`, [uid, exclude])
    )
      .map(shape)
      .filter((c) => c.status === "active" || c.status === "upcoming");
    const usedBy = {};
    for (const c of others) for (const k of c.accounts) (usedBy[k] = usedBy[k] || []).push(c.name);

    res.json({ success: true, data: { accounts, agents, usedBy, today: today() } });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/stats", validateUser, async (req, res) => {
  try {
    await ensureTable();
    const c = await getOwned(req.decode.uid, req.query.id);
    if (!c) return res.json({ success: false, msg: "Campaign not found" });
    res.json({ success: true, data: await campaignStats(req.decode.uid, c) });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/save", validateUser, async (req, res) => {
  try {
    await ensureTable();
    const uid = req.decode.uid;
    const b = req.body || {};

    const name = String(b.name || "")
      .trim()
      .slice(0, 60);
    const type = TYPES.includes(b.type) ? b.type : "custom";
    const description = String(b.description || "")
      .trim()
      .slice(0, 500);
    const start = DAY.test(b.start_date || "") ? b.start_date : null;
    const end = DAY.test(b.end_date || "") ? b.end_date : null;
    const accounts = await cleanAccounts(uid, b.accounts);
    const agents = await cleanAgents(uid, b.agents);
    const draft = !!b.draft;

    if (!name) return res.json({ success: false, msg: "Give the campaign a name" });
    if (start && end && end < start)
      return res.json({ success: false, msg: "End date is before start date" });
    if (!draft) {
      if (!start || !end) return res.json({ success: false, msg: "Pick a start and end date" });
      if (!accounts.length) return res.json({ success: false, msg: "Pick at least one account" });
    }

    const values = {
      name,
      type,
      description,
      start_date: start,
      end_date: end,
      accounts: JSON.stringify(accounts),
      agents: JSON.stringify(agents),
      is_draft: draft ? 1 : 0,
    };

    let id = Number(b.id) || 0;
    if (id) {
      const existing = await getOwned(uid, id);
      if (!existing) return res.json({ success: false, msg: "Campaign not found" });
      await query(`UPDATE omni_campaigns SET ? WHERE id = ? AND owner_uid = ?`, [values, id, uid]);
    } else {
      const r = await query(`INSERT INTO omni_campaigns SET ?`, [{ ...values, owner_uid: uid }]);
      id = r.insertId;
    }
    res.json({ success: true, data: await getOwned(uid, id) });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/delete", validateUser, async (req, res) => {
  try {
    await ensureTable();
    await query(`DELETE FROM omni_campaigns WHERE id = ? AND owner_uid = ?`, [
      Number(req.body?.id) || 0,
      req.decode.uid,
    ]);
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/duplicate", validateUser, async (req, res) => {
  try {
    await ensureTable();
    const c = await getOwned(req.decode.uid, req.body?.id);
    if (!c) return res.json({ success: false, msg: "Campaign not found" });
    // Copies keep accounts, agents and type; dates are picked again
    const r = await query(`INSERT INTO omni_campaigns SET ?`, [
      {
        owner_uid: req.decode.uid,
        name: `${c.name} (copy)`.slice(0, 60),
        type: c.type,
        description: c.description,
        start_date: null,
        end_date: null,
        accounts: JSON.stringify(c.accounts),
        agents: JSON.stringify(c.agents),
        is_draft: 1,
      },
    ]);
    res.json({ success: true, data: await getOwned(req.decode.uid, r.insertId) });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/end_now", validateUser, async (req, res) => {
  try {
    await ensureTable();
    const c = await getOwned(req.decode.uid, req.body?.id);
    if (!c) return res.json({ success: false, msg: "Campaign not found" });
    if (c.status !== "active")
      return res.json({ success: false, msg: "Only an active campaign can be ended" });
    // Ends after today: yesterday as end date makes it Completed right away
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const p = (n) => String(n).padStart(2, "0");
    let end = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (end < c.start_date) end = c.start_date;
    await query(`UPDATE omni_campaigns SET end_date = ? WHERE id = ? AND owner_uid = ?`, [
      end,
      c.id,
      req.decode.uid,
    ]);
    const after = await getOwned(req.decode.uid, c.id);
    // A campaign that started today stays active until tonight
    res.json({ success: true, data: after });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

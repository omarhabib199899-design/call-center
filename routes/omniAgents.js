// Backend for the new Agents & Channels page (/new/#agent-accounts)

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const randomstring = require("randomstring");

const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const { checkPlan } = require("../middlewares/plan");
const logger = require("../utils/logger");
const {
  ensureTables,
  parseKey,
  toKey,
  accountMatch,
  listOwnerAccounts,
  getAgentAccountKeys,
  setAgentAccounts,
} = require("../helper/agentAccounts");
const { invalidate } = require("../helper/omniAccess");

const HISTORY_DAYS = 90;

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      await ensureTables();
      await query(`CREATE TABLE IF NOT EXISTS omni_custom_agents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_uid VARCHAR(255) NOT NULL,
        agent_uid VARCHAR(255) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_agent (owner_uid, agent_uid)
      )`);
      // Added in v4; the table may already exist from the first version
      await query(`ALTER TABLE omni_custom_agents ADD COLUMN invited TINYINT DEFAULT 0`).catch((e) => {
        if (e?.code !== "ER_DUP_FIELDNAME") throw e;
      });
      await query(`CREATE TABLE IF NOT EXISTS omni_agent_settings (
        owner_uid VARCHAR(255) NOT NULL,
        agent_uid VARCHAR(255) NOT NULL,
        account_limit INT NULL,
        PRIMARY KEY (owner_uid, agent_uid)
      )`);
      // Added with the Home "Target achievement" column
      await query(`ALTER TABLE omni_agent_settings ADD COLUMN sales_target DECIMAL(14,2) NULL`).catch((e) => {
        if (e?.code !== "ER_DUP_FIELDNAME") throw e;
      });
      await query(`CREATE TABLE IF NOT EXISTS omni_account_state (
        owner_uid VARCHAR(255) NOT NULL,
        acc_key VARCHAR(255) NOT NULL,
        label VARCHAR(120) NULL,
        deactivated TINYINT DEFAULT 0,
        reason VARCHAR(60) NULL,
        note VARCHAR(500) NULL,
        changedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_uid, acc_key)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS omni_vip (
        owner_uid VARCHAR(255) NOT NULL,
        chat_id VARCHAR(255) NOT NULL,
        agent_uid VARCHAR(255) NOT NULL,
        acc_key VARCHAR(255) NOT NULL,
        exclusive TINYINT DEFAULT 1,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_uid, chat_id),
        KEY idx_agent (owner_uid, agent_uid)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS omni_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_uid VARCHAR(255) NOT NULL,
        actor VARCHAR(255) NULL,
        kind VARCHAR(30) NOT NULL,
        summary VARCHAR(500) NOT NULL,
        added INT DEFAULT 0,
        removed INT DEFAULT 0,
        agents TEXT NULL,
        channels VARCHAR(255) NULL,
        payload MEDIUMTEXT NULL,
        reverted_by INT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_owner (owner_uid, createdAt)
      )`);
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

function fail(res, err) {
  logger.log(err);
  res.json({ success: false, msg: "something went wrong" });
}

const own = (req) => req.decode.uid;

async function ownerName(uid) {
  const [u] = await query(`SELECT name, email FROM user WHERE uid = ? LIMIT 1`, [uid]).catch(() => []);
  return u?.name || u?.email || "Owner";
}

async function getAgents(ownerUid) {
  return query(
    `SELECT id, uid, name, email, mobile, is_active, logs FROM agents WHERE owner_uid = ? ORDER BY name ASC`,
    [ownerUid],
  );
}

const firstName = (n) =>
  String(n || "")
    .trim()
    .split(/\s+/)[0] || "Agent";
function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

// True once the agent has logged in at least once (stock login writes logs)
function hasLoggedIn(logs) {
  try {
    const t = JSON.parse(logs || "{}")?.dateTracking || {};
    return Object.values(t).some((d) => Number(d?.logins) > 0);
  } catch {
    return false;
  }
}

async function log(ownerUid, entry) {
  const actor = await ownerName(ownerUid);
  const r = await query(
    `INSERT INTO omni_history (owner_uid, actor, kind, summary, added, removed, agents, channels, payload)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      ownerUid,
      actor,
      entry.kind,
      String(entry.summary).slice(0, 500),
      entry.added || 0,
      entry.removed || 0,
      JSON.stringify(entry.agents || []),
      (entry.channels || []).join(",").slice(0, 255),
      entry.payload ? JSON.stringify(entry.payload) : null,
    ],
  );
  await query(
    `DELETE FROM omni_history WHERE owner_uid = ? AND createdAt < (NOW() - INTERVAL ${HISTORY_DAYS} DAY)`,
    [ownerUid],
  ).catch(() => {});
  return r.insertId;
}

const channelOf = (key) => {
  const c = String(key).split(":")[0];
  return c === "qr" || c === "meta" ? "whatsapp" : c === "messenger" ? "facebook" : c;
};

async function writeAgentAccounts(ownerUid, agent, keys) {
  const numbers = keys.filter((k) => k.startsWith("qr:"));
  await query(`DELETE FROM agent_instances WHERE owner_uid = ? AND agent_uid = ?`, [
    ownerUid,
    agent.uid,
  ]).catch((err) => {
    if (err?.code !== "ER_NO_SUCH_TABLE") throw err;
  });
  if (numbers.length) {
    const instances = await query(`SELECT uniqueId, number FROM instance WHERE uid = ?`, [ownerUid]);
    const byNumber = new Map(instances.map((i) => [String(i.number || "").replace(/\D/g, ""), i.uniqueId]));
    for (const key of numbers) {
      const number = key.slice(3);
      await query(
        `INSERT INTO agent_instances (owner_uid, agent_id, agent_uid, instance_number, instance_unique_id)
         VALUES (?,?,?,?,?)`,
        [ownerUid, agent.id, agent.uid, number, byNumber.get(number) || null],
      );
    }
  }
  await setAgentAccounts({ ownerUid, agentId: agent.id, agentUid: agent.uid, keys });
}

async function accountStates(ownerUid) {
  const rows = await query(`SELECT * FROM omni_account_state WHERE owner_uid = ?`, [ownerUid]);
  return new Map(rows.map((r) => [r.acc_key, r]));
}

async function limits(ownerUid) {
  const rows = await query(`SELECT agent_uid, account_limit FROM omni_agent_settings WHERE owner_uid = ?`, [
    ownerUid,
  ]);
  return new Map(
    rows.filter((r) => r.account_limit != null).map((r) => [r.agent_uid, Number(r.account_limit)]),
  );
}

async function vipRows(ownerUid, where = "", params = []) {
  return query(`SELECT chat_id, agent_uid, acc_key, exclusive FROM omni_vip WHERE owner_uid = ? ${where}`, [
    ownerUid,
    ...params,
  ]);
}

// Replace one agent's VIP customers on one account
async function setVip(ownerUid, { agent_uid, acc_key, chat_ids, exclusive }) {
  const ids = [...new Set((chat_ids || []).map(String).filter(Boolean))];
  if (ids.length) {
    await query(
      `DELETE FROM omni_vip WHERE owner_uid = ? AND agent_uid = ? AND acc_key = ? AND chat_id NOT IN (${ids
        .map(() => "?")
        .join(",")})`,
      [ownerUid, agent_uid, acc_key, ...ids],
    );
  } else {
    await query(`DELETE FROM omni_vip WHERE owner_uid = ? AND agent_uid = ? AND acc_key = ?`, [
      ownerUid,
      agent_uid,
      acc_key,
    ]);
  }
  for (const id of ids) {
    await query(
      `INSERT INTO omni_vip (owner_uid, chat_id, agent_uid, acc_key, exclusive) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE agent_uid = VALUES(agent_uid), acc_key = VALUES(acc_key), exclusive = VALUES(exclusive)`,
      [ownerUid, id, agent_uid, acc_key, exclusive ? 1 : 0],
    );
  }
}

// Apply a set of changes and log them as one entry
async function applyBatch(ownerUid, changes, { kind = "assign", summary, revertOf } = {}) {
  const agents = await getAgents(ownerUid);
  const byUid = new Map(agents.map((a) => [a.uid, a]));
  const accounts = await listOwnerAccounts(ownerUid);
  const owned = new Map(accounts.map((a) => [a.key, a]));
  const states = await accountStates(ownerUid);
  const lim = await limits(ownerUid);

  const before = {};
  const after = {};
  const errors = [];

  for (const [uid, rawKeys] of Object.entries(changes.agents || {})) {
    const agent = byUid.get(uid);
    if (!agent) {
      errors.push(`Agent ${uid} not found`);
      continue;
    }
    const prev = await getAgentAccountKeys(uid);
    const prevSet = new Set(prev);
    const keys = [...new Set(rawKeys || [])]
      .map(parseKey)
      .filter(Boolean)
      .map((p) => toKey(p.channel, p.account_id))
      .filter((k) => owned.has(k))
      // A deactivated account can't be newly given to anyone
      .filter((k) => prevSet.has(k) || !Number(states.get(k)?.deactivated));
    const max = lim.get(uid);
    if (max != null && keys.length > max && keys.length > prev.length) {
      errors.push(`${agent.name} can have at most ${max} accounts`);
      continue;
    }
    before[uid] = prev;
    after[uid] = keys;
  }
  if (errors.length) return { errors };

  // VIP: only for owned accounts and existing agents
  const vipChanges = (changes.vip || []).filter((v) => byUid.has(v.agent_uid) && owned.has(v.acc_key));
  const vipBefore = [];
  for (const v of vipChanges) {
    const ids = [...new Set((v.chat_ids || []).map(String))];
    const touched = await vipRows(
      ownerUid,
      `AND ((agent_uid = ? AND acc_key = ?)${ids.length ? ` OR chat_id IN (${ids.map(() => "?").join(",")})` : ""})`,
      [v.agent_uid, v.acc_key, ...ids],
    );
    vipBefore.push(...touched);
  }

  let added = 0;
  let removed = 0;
  const changedNames = [];
  const channels = new Set();
  for (const uid of Object.keys(after)) {
    const b = new Set(before[uid]);
    const a = new Set(after[uid]);
    const plus = [...a].filter((k) => !b.has(k));
    const minus = [...b].filter((k) => !a.has(k));
    if (!plus.length && !minus.length) {
      delete before[uid];
      delete after[uid];
      continue;
    }
    added += plus.length;
    removed += minus.length;
    [...plus, ...minus].forEach((k) => channels.add(channelOf(k)));
    changedNames.push(byUid.get(uid).name);
    await writeAgentAccounts(ownerUid, byUid.get(uid), after[uid]);
  }

  let vipCount = 0;
  for (const v of vipChanges) {
    await setVip(ownerUid, v);
    vipCount += (v.chat_ids || []).length;
    channels.add(channelOf(v.acc_key));
    const n = byUid.get(v.agent_uid)?.name;
    if (n && !changedNames.includes(n)) changedNames.push(n);
  }
  invalidate(ownerUid);

  if (!Object.keys(after).length && !vipChanges.length) return { entry: null, added: 0, removed: 0 };

  const accName = (k) => owned.get(k)?.name || k;
  let text = summary;
  if (!text) {
    const allAdded = [
      ...new Set(Object.keys(after).flatMap((u) => after[u].filter((k) => !before[u].includes(k)))),
    ];
    const allRemoved = [
      ...new Set(Object.keys(after).flatMap((u) => before[u].filter((k) => !after[u].includes(k)))),
    ];
    const parts = [];
    if (allAdded.length)
      parts.push(
        `Gave ${changedNames.length} ${changedNames.length === 1 ? "agent" : "agents"} access to ${
          allAdded.length === 1 ? accName(allAdded[0]) : `${allAdded.length} accounts`
        }`,
      );
    if (allRemoved.length)
      parts.push(
        `${parts.length ? "removed" : "Removed"} access to ${allRemoved.length === 1 ? accName(allRemoved[0]) : `${allRemoved.length} accounts`}`,
      );
    if (vipChanges.length)
      parts.push(
        `${parts.length ? "set" : "Set"} ${vipCount} VIP ${vipCount === 1 ? "customer" : "customers"} in ${accName(vipChanges[0].acc_key)}`,
      );
    text = parts.join(", ");
  }

  const entry = await log(ownerUid, {
    kind,
    summary: text,
    added,
    removed,
    agents: changedNames,
    channels: [...channels],
    payload: { before, after, vipBefore, vip: vipChanges, revertOf: revertOf || null },
  });
  return { entry, added, removed };
}

router.get("/state", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const agents = await getAgents(ownerUid);
    const known = new Set(agents.map((a) => a.uid));
    const customRows = await query(`SELECT agent_uid, invited FROM omni_custom_agents WHERE owner_uid = ?`, [
      ownerUid,
    ]);
    const lim = await limits(ownerUid);
    const states = await accountStates(ownerUid);
    const vip = await vipRows(ownerUid);

    // Names of VIP customers, for the account cards and the drawer
    const ids = vip.map((v) => v.chat_id);
    const names = ids.length
      ? await query(
          `SELECT chat_id, sender_name, sender_mobile FROM beta_chats WHERE uid = ? AND chat_id IN (${ids
            .map(() => "?")
            .join(",")})`,
          [ownerUid, ...ids],
        )
      : [];
    const nameOf = new Map(names.map((n) => [n.chat_id, n]));

    res.json({
      success: true,
      data: {
        custom: customRows
          .filter((r) => known.has(r.agent_uid))
          .map((r) => {
            const a = agents.find((x) => x.uid === r.agent_uid);
            return {
              uid: r.agent_uid,
              invited: !!Number(r.invited),
              pending: !!Number(r.invited) && !hasLoggedIn(a?.logs),
            };
          }),
        limits: Object.fromEntries(lim),
        targets: Object.fromEntries(
          (
            await query(
              `SELECT agent_uid, sales_target FROM omni_agent_settings WHERE owner_uid = ? AND sales_target IS NOT NULL`,
              [ownerUid],
            )
          ).map((r) => [r.agent_uid, Number(r.sales_target)]),
        ),
        mobiles: Object.fromEntries(agents.map((a) => [a.uid, a.mobile || ""])),
        accounts: Object.fromEntries(
          [...states].map(([k, s]) => [
            k,
            {
              label: s.label || null,
              deactivated: !!Number(s.deactivated),
              reason: s.reason,
              changedAt: s.changedAt,
            },
          ]),
        ),
        vip: vip.map((v) => ({
          chat_id: v.chat_id,
          agent_uid: v.agent_uid,
          acc_key: v.acc_key,
          exclusive: !!Number(v.exclusive),
          name: nameOf.get(v.chat_id)?.sender_name || "",
          mobile: nameOf.get(v.chat_id)?.sender_mobile || "",
        })),
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/save_batch", validateUser, async (req, res) => {
  try {
    await ensure();
    const { agents, vip } = req.body || {};
    if ((agents && typeof agents !== "object") || (vip && !Array.isArray(vip))) {
      return res.json({ success: false, msg: "Invalid input provided" });
    }
    const out = await applyBatch(own(req), { agents: agents || {}, vip: vip || [] });
    if (out.errors) return res.json({ success: false, msg: out.errors.join(". ") });
    res.json({ success: true, data: { id: out.entry, added: out.added, removed: out.removed } });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/history", validateUser, async (req, res) => {
  try {
    await ensure();
    const days = Math.min(HISTORY_DAYS, Math.max(1, parseInt(req.query.days, 10) || 30));
    const rows = await query(
      `SELECT id, actor, kind, summary, added, removed, agents, channels, reverted_by, createdAt,
              (payload IS NOT NULL AND kind = 'assign') AS revertable
         FROM omni_history
        WHERE owner_uid = ? AND createdAt >= (NOW() - INTERVAL ${days} DAY)
        ORDER BY id DESC LIMIT 300`,
      [own(req)],
    );
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        agents: (() => {
          try {
            return JSON.parse(r.agents || "[]");
          } catch {
            return [];
          }
        })(),
        channels: r.channels ? r.channels.split(",") : [],
        revertable: !!Number(r.revertable) && !r.reverted_by,
      })),
    });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/revert", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const [row] = await query(`SELECT * FROM omni_history WHERE id = ? AND owner_uid = ? LIMIT 1`, [
      req.body?.id,
      ownerUid,
    ]);
    if (!row || row.kind !== "assign" || !row.payload)
      return res.json({ success: false, msg: "This change can't be reverted" });
    if (row.reverted_by) return res.json({ success: false, msg: "Already reverted" });

    const p = JSON.parse(row.payload);
    // Agents deleted since then are skipped by applyBatch
    const agents = await getAgents(ownerUid);
    const known = new Set(agents.map((a) => a.uid));
    const restore = Object.fromEntries(Object.entries(p.before || {}).filter(([u]) => known.has(u)));

    // VIP: drop what that save set, put back what was there before it
    const vipNow = [];
    for (const v of p.vip || []) {
      await query(`DELETE FROM omni_vip WHERE owner_uid = ? AND agent_uid = ? AND acc_key = ?`, [
        ownerUid,
        v.agent_uid,
        v.acc_key,
      ]);
      vipNow.push(v);
    }
    for (const v of p.vipBefore || []) {
      if (!known.has(v.agent_uid)) continue;
      await query(
        `INSERT INTO omni_vip (owner_uid, chat_id, agent_uid, acc_key, exclusive) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE agent_uid = VALUES(agent_uid), acc_key = VALUES(acc_key), exclusive = VALUES(exclusive)`,
        [ownerUid, v.chat_id, v.agent_uid, v.acc_key, v.exclusive],
      );
    }
    invalidate(ownerUid);

    const out = await applyBatch(
      ownerUid,
      { agents: restore },
      { kind: "revert", summary: `Reverted: ${row.summary}`, revertOf: row.id },
    );
    if (out.errors) return res.json({ success: false, msg: out.errors.join(". ") });
    let id = out.entry;
    if (!id)
      id = await log(ownerUid, {
        kind: "revert",
        summary: `Reverted: ${row.summary}`,
        agents: JSON.parse(row.agents || "[]"),
      });
    await query(`UPDATE omni_history SET reverted_by = ? WHERE id = ?`, [id, row.id]);
    res.json({ success: true, data: { id } });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/custom", validateUser, async (req, res) => {
  try {
    await ensure();
    const rows = await query(
      `SELECT c.agent_uid FROM omni_custom_agents c
         JOIN agents a ON a.uid = c.agent_uid AND a.owner_uid = c.owner_uid
        WHERE c.owner_uid = ?`,
      [own(req)],
    );
    res.json({ success: true, data: { uids: rows.map((r) => r.agent_uid) } });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/mark_custom", validateUser, async (req, res) => {
  try {
    await ensure();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const uid = String(req.body?.uid || "");
    if (!email && !uid) return res.json({ success: false, msg: "Email is required" });
    const [agent] = uid
      ? await query(`SELECT uid, name FROM agents WHERE owner_uid = ? AND uid = ? LIMIT 1`, [own(req), uid])
      : await query(`SELECT uid, name FROM agents WHERE owner_uid = ? AND LOWER(email) = ? LIMIT 1`, [
          own(req),
          email,
        ]);
    if (!agent) return res.json({ success: false, msg: "Agent not found" });
    await query(`INSERT IGNORE INTO omni_custom_agents (owner_uid, agent_uid) VALUES (?, ?)`, [
      own(req),
      agent.uid,
    ]);
    if (uid)
      await log(own(req), {
        kind: "custom",
        summary: `Added ${agent.name} as a custom agent`,
        agents: [agent.name],
      });
    res.json({ success: true, data: { uid: agent.uid } });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/unmark_custom", validateUser, async (req, res) => {
  try {
    await ensure();
    await query(`DELETE FROM omni_custom_agents WHERE owner_uid = ? AND agent_uid = ?`, [
      own(req),
      String(req.body?.uid || ""),
    ]);
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

// Your own agents, for "Existing agent"
router.get("/search_agents", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const agents = await getAgents(ownerUid);
    const custom = new Set(
      (await query(`SELECT agent_uid FROM omni_custom_agents WHERE owner_uid = ?`, [ownerUid])).map(
        (r) => r.agent_uid,
      ),
    );
    const lim = await limits(ownerUid);
    const out = [];
    for (const a of agents) {
      if (
        q &&
        ![a.name, a.email].some((v) =>
          String(v || "")
            .toLowerCase()
            .includes(q),
        )
      )
        continue;
      const n = (await getAgentAccountKeys(a.uid)).length;
      const max = lim.get(a.uid) ?? null;
      out.push({
        uid: a.uid,
        name: a.name,
        email: a.email,
        accounts: n,
        limit: max,
        status: custom.has(a.uid) ? "custom" : max != null && n >= max ? "full" : "available",
      });
      if (out.length >= 20) break;
    }
    if (q.includes("@") && !out.some((a) => String(a.email).toLowerCase() === q)) {
      const [other] = await query(`SELECT 1 FROM agents WHERE LOWER(email) = ? AND owner_uid <> ? LIMIT 1`, [
        q,
        ownerUid,
      ]);
      if (other) out.push({ uid: null, name: null, email: q, status: "other_client" });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    fail(res, err);
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inviteHtml({ appName, owner, name, email, password, link }) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#202020;max-width:520px">
<p>Hi ${esc(name)},</p>
<p>${esc(owner)} added you as an agent on ${esc(appName)}.</p>
<p>Sign in here: <a href="${esc(link)}">${esc(link)}</a><br>
Email: <b>${esc(email)}</b><br>Temporary password: <b>${esc(password)}</b></p>
<p>Please change your password after you sign in.</p></div>`;
}

router.post("/invite", validateUser, checkPlan, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const mobile = String(req.body?.mobile || "").replace(/[^\d+]/g, "");
    const limitRaw = req.body?.limit;
    const limit = limitRaw === "" || limitRaw == null ? null : parseInt(limitRaw, 10);

    if (name.length < 2 || name.length > 50)
      return res.json({ success: false, field: "name", msg: "Name must be 2–50 characters" });
    if (!EMAIL_RE.test(email))
      return res.json({ success: false, field: "email", msg: "Enter a valid email" });
    if (mobile.replace(/\D/g, "").length < 8)
      return res.json({ success: false, field: "mobile", msg: "Enter the phone number with country code" });
    if (limit != null && (!Number.isFinite(limit) || limit < 1 || limit > 1000))
      return res.json({
        success: false,
        field: "limit",
        msg: "Account limit must be a number from 1 to 1000",
      });

    const [taken] = await query(`SELECT uid, name, owner_uid FROM agents WHERE LOWER(email) = ? LIMIT 1`, [
      email,
    ]);
    if (taken) {
      return res.json(
        taken.owner_uid === ownerUid
          ? {
              success: false,
              field: "email",
              msg: "This email already belongs to one of your agents.",
              existing: { uid: taken.uid, name: taken.name },
            }
          : {
              success: false,
              field: "email",
              msg: "This email already belongs to an agent of another client. Use a different email.",
            },
      );
    }

    const password = randomstring.generate({ length: 10, charset: "alphanumeric" });
    const uid = randomstring.generate();
    await query(
      `INSERT INTO agents (owner_uid, uid, email, password, name, mobile, comments) VALUES (?,?,?,?,?,?,?)`,
      [ownerUid, uid, email, await bcrypt.hash(password, 10), name, mobile, "Custom agent (invited)"],
    );
    await query(`INSERT IGNORE INTO omni_custom_agents (owner_uid, agent_uid, invited) VALUES (?,?,1)`, [
      ownerUid,
      uid,
    ]);
    if (limit != null) {
      await query(`INSERT INTO omni_agent_settings (owner_uid, agent_uid, account_limit) VALUES (?,?,?)`, [
        ownerUid,
        uid,
        limit,
      ]);
    }

    // Email with a temporary password, using the platform SMTP (same as password recovery)
    let emailed = false;
    try {
      const [smtp] = await query(`SELECT * FROM smtp`, []);
      if (smtp?.email && smtp?.host && smtp?.port && smtp?.password) {
        const { sendEmail } = require("../functions/function");
        const [web] = await query(`SELECT app_name FROM web_public LIMIT 1`, []).catch(() => []);
        const appName = web?.app_name || "Omni";
        const base = (process.env.FRONTENDURI || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const sent = await sendEmail(
          smtp.host,
          smtp.port,
          smtp.email,
          smtp.password,
          inviteHtml({
            appName,
            owner: await ownerName(ownerUid),
            name,
            email,
            password,
            link: `${base}/agent/login`,
          }),
          `${appName} - You've been added as an agent`,
          smtp.email,
          email,
          smtp.username,
        );
        emailed = !!sent?.success;
      }
    } catch (e) {
      logger.log(e);
    }

    await log(ownerUid, { kind: "custom", summary: `Invited ${name} as a custom agent`, agents: [name] });
    // When the email couldn't go out, the owner gets the password to pass on
    res.json({ success: true, data: { uid, emailed, password: emailed ? undefined : password } });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/agent/update", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const uid = String(req.body?.uid || "");
    const name = String(req.body?.name || "").trim();
    const mobile = String(req.body?.mobile || "").replace(/[^\d+]/g, "");
    const limitRaw = req.body?.limit;
    const limit = limitRaw === "" || limitRaw == null ? null : parseInt(limitRaw, 10);
    const targetRaw = req.body?.sales_target;
    const target = targetRaw === "" || targetRaw == null ? null : Number(String(targetRaw).replace(/,/g, ""));
    if (target != null && (!Number.isFinite(target) || target <= 0 || target > 1e9))
      return res.json({
        success: false,
        field: "target",
        msg: "Sales target must be a number greater than 0",
      });

    const [agent] = await query(
      `SELECT uid, name, mobile FROM agents WHERE uid = ? AND owner_uid = ? LIMIT 1`,
      [uid, ownerUid],
    );
    if (!agent) return res.json({ success: false, msg: "Agent not found" });
    if (name.length < 2 || name.length > 50)
      return res.json({ success: false, field: "name", msg: "Name must be 2–50 characters" });
    if (mobile.replace(/\D/g, "").length < 8)
      return res.json({ success: false, field: "mobile", msg: "Enter the phone number with country code" });
    if (limit != null && (!Number.isFinite(limit) || limit < 1 || limit > 1000))
      return res.json({
        success: false,
        field: "limit",
        msg: "Account limit must be a number from 1 to 1000",
      });
    if (limit != null) {
      const n = (await getAgentAccountKeys(uid)).length;
      if (n > limit)
        return res.json({
          success: false,
          field: "limit",
          msg: `${agent.name} already has ${n} accounts. Remove some first or use a higher limit.`,
        });
    }

    await query(`UPDATE agents SET name = ?, mobile = ? WHERE uid = ? AND owner_uid = ?`, [
      name,
      mobile,
      uid,
      ownerUid,
    ]);
    const [prevSet] = await query(
      `SELECT sales_target FROM omni_agent_settings WHERE owner_uid = ? AND agent_uid = ?`,
      [ownerUid, uid],
    );
    const keepTarget = targetRaw === undefined ? (prevSet?.sales_target ?? null) : target;
    await query(
      `INSERT INTO omni_agent_settings (owner_uid, agent_uid, account_limit, sales_target) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE account_limit = VALUES(account_limit), sales_target = VALUES(sales_target)`,
      [ownerUid, uid, limit, keepTarget],
    );

    const what = [name !== agent.name && "name", mobile !== String(agent.mobile || "") && "phone"].filter(
      Boolean,
    );
    if (what.length || limitRaw !== undefined) {
      await log(ownerUid, {
        kind: "agent",
        summary: `Edited ${agent.name}'s ${what.length ? what.join(" and ") : "account limit"}`,
        agents: [name],
      });
    }
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/agent/remove", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const uid = String(req.body?.uid || "");
    const [agent] = await query(`SELECT uid, name FROM agents WHERE uid = ? AND owner_uid = ? LIMIT 1`, [
      uid,
      ownerUid,
    ]);
    if (!agent) return res.json({ success: false, msg: "Agent not found" });
    await query(`DELETE FROM agent_instances WHERE owner_uid = ? AND agent_uid = ?`, [ownerUid, uid]).catch(
      () => {},
    );
    await query(`DELETE FROM agent_accounts WHERE owner_uid = ? AND agent_uid = ?`, [ownerUid, uid]);
    await query(`DELETE FROM omni_vip WHERE owner_uid = ? AND agent_uid = ?`, [ownerUid, uid]);
    await query(`DELETE FROM omni_custom_agents WHERE owner_uid = ? AND agent_uid = ?`, [ownerUid, uid]);
    await query(`DELETE FROM omni_agent_settings WHERE owner_uid = ? AND agent_uid = ?`, [ownerUid, uid]);
    await query(`DELETE FROM agents WHERE uid = ? AND owner_uid = ?`, [uid, ownerUid]);
    invalidate(ownerUid);
    await log(ownerUid, { kind: "agent", summary: `Removed ${agent.name}`, agents: [agent.name] });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

async function ownedAccount(ownerUid, key) {
  return (await listOwnerAccounts(ownerUid)).filter((a) => a.key === key);
}

async function holdersOf(ownerUid, key) {
  const agents = await getAgents(ownerUid);
  const out = [];
  for (const a of agents) if ((await getAgentAccountKeys(a.uid)).includes(key)) out.push(a);
  return out;
}

async function chatCount(ownerUid, key) {
  const p = parseKey(key);
  const m = p && accountMatch(p.channel, p.account_id);
  if (!m) return 0;
  const [r] = await query(`SELECT COUNT(*) n FROM beta_chats WHERE uid = ? AND ${m.sql}`, [
    ownerUid,
    ...m.params,
  ]);
  return Number(r?.n || 0);
}

router.get("/account/impact", validateUser, async (req, res) => {
  try {
    await ensure();
    const key = String(req.query.key || "");
    const [acc] = await ownedAccount(own(req), key);
    if (!acc) return res.json({ success: false, msg: "Account not found" });
    const agents = await holdersOf(own(req), key);
    const [v] = await query(`SELECT COUNT(*) n FROM omni_vip WHERE owner_uid = ? AND acc_key = ?`, [
      own(req),
      key,
    ]);
    res.json({
      success: true,
      data: {
        agents: agents.map((a) => ({ uid: a.uid, name: a.name })),
        chats: await chatCount(own(req), key),
        vip: Number(v?.n || 0),
        canDelete: ["qr", "telegram", "messenger", "instagram"].includes(acc.channel),
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/account/rename", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const key = String(req.body?.key || "");
    const label = String(req.body?.label || "")
      .trim()
      .slice(0, 60);
    const [acc] = await ownedAccount(ownerUid, key);
    if (!acc) return res.json({ success: false, msg: "Account not found" });
    if (!label) return res.json({ success: false, msg: "Enter a name" });
    await query(
      `INSERT INTO omni_account_state (owner_uid, acc_key, label) VALUES (?,?,?) ON DUPLICATE KEY UPDATE label = VALUES(label)`,
      [ownerUid, key, label],
    );
    // WhatsApp numbers: also rename the session(s), so every page shows it
    if (acc.channel === "qr") {
      const rows = await query(`SELECT id, number FROM instance WHERE uid = ?`, [ownerUid]);
      for (const r of rows) {
        if (String(r.number || "").replace(/\D/g, "") === acc.account_id) {
          await query(`UPDATE instance SET title = ? WHERE id = ? AND uid = ?`, [label, r.id, ownerUid]);
        }
      }
    }
    await log(ownerUid, {
      kind: "account",
      summary: `Renamed ${acc.name} to ${label}`,
      channels: [channelOf(key)],
    });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

const REASONS = {
  unused: "No longer used",
  seasonal: "Seasonal — we’ll bring it back",
  moving: "Moving to another number",
  other: "Other",
};

router.post("/account/deactivate", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const key = String(req.body?.key || "");
    const reason = String(req.body?.reason || "");
    const note = String(req.body?.note || "")
      .trim()
      .slice(0, 500);
    const [acc] = await ownedAccount(ownerUid, key);
    if (!acc) return res.json({ success: false, msg: "Account not found" });
    if (!REASONS[reason]) return res.json({ success: false, field: "reason", msg: "Choose a reason" });
    await query(
      `INSERT INTO omni_account_state (owner_uid, acc_key, deactivated, reason, note) VALUES (?,?,1,?,?)
       ON DUPLICATE KEY UPDATE deactivated = 1, reason = VALUES(reason), note = VALUES(note)`,
      [ownerUid, key, reason, note || null],
    );
    invalidate(ownerUid);
    await log(ownerUid, {
      kind: "account",
      summary: `Paused ${acc.name} — ${REASONS[reason]}${note ? ` (${note})` : ""}`,
      channels: [channelOf(key)],
    });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/account/reactivate", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const key = String(req.body?.key || "");
    const [acc] = await ownedAccount(ownerUid, key);
    if (!acc) return res.json({ success: false, msg: "Account not found" });
    await query(
      `UPDATE omni_account_state SET deactivated = 0, reason = NULL, note = NULL WHERE owner_uid = ? AND acc_key = ?`,
      [ownerUid, key],
    );
    invalidate(ownerUid);
    await log(ownerUid, { kind: "account", summary: `Resumed ${acc.name}`, channels: [channelOf(key)] });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/account/delete", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const key = String(req.body?.key || "");
    const accs = await ownedAccount(ownerUid, key);
    const acc = accs[0];
    if (!acc) return res.json({ success: false, msg: "Account not found" });
    if (String(req.body?.confirm || "").trim() !== String(acc.name).trim()) {
      return res.json({ success: false, field: "confirm", msg: `Type “${acc.name}” to confirm` });
    }

    if (acc.channel === "qr") {
      // Every session on this number, the same way the stock /qr/del_instance does it
      const { getSession, deleteSession } = require("../helper/addon/qr/index.js");
      const rows = await query(`SELECT uniqueId, number FROM instance WHERE uid = ?`, [ownerUid]);
      for (const r of rows) {
        if (String(r.number || "").replace(/\D/g, "") !== acc.account_id) continue;
        const s = getSession(r.uniqueId);
        if (s) {
          try {
            await s.logout();
          } catch {
          } finally {
            deleteSession(r.uniqueId);
          }
        }
        await query(`DELETE FROM instance WHERE uniqueId = ? AND uid = ?`, [r.uniqueId, ownerUid]);
      }
    } else if (acc.channel === "telegram") {
      const { deleteSession } = require("../helper/addon/telegram/tele.js");
      const rows = await query(`SELECT session_id FROM telegram_session WHERE uid = ?`, [ownerUid]);
      for (const r of rows) await deleteSession(r.session_id);
    } else if (acc.channel === "messenger") {
      const rows = await query(`SELECT id, page_id FROM messenger_accounts WHERE uid = ?`, [ownerUid]);
      for (const r of rows)
        if (String(r.page_id).replace(/[^A-Za-z0-9]/g, "") === acc.account_id)
          await query(`DELETE FROM messenger_accounts WHERE id = ? AND uid = ?`, [r.id, ownerUid]);
    } else if (acc.channel === "instagram") {
      const rows = await query(`SELECT id, user_id, webhook_id FROM instagram_accounts WHERE uid = ?`, [
        ownerUid,
      ]);
      for (const r of rows)
        if (String(r.user_id || r.webhook_id).replace(/[^A-Za-z0-9]/g, "") === acc.account_id)
          await query(`DELETE FROM instagram_accounts WHERE id = ? AND uid = ?`, [r.id, ownerUid]);
    } else {
      return res.json({ success: false, msg: "Disconnect this account from its Channels page" });
    }

    // Clean up everything this page stored about it
    const p = parseKey(key);
    if (p.channel === "qr")
      await query(`DELETE FROM agent_instances WHERE owner_uid = ? AND instance_number = ?`, [
        ownerUid,
        p.account_id,
      ]).catch(() => {});
    else
      await query(`DELETE FROM agent_accounts WHERE owner_uid = ? AND channel = ? AND account_id = ?`, [
        ownerUid,
        p.channel,
        p.account_id,
      ]);
    await query(`DELETE FROM omni_vip WHERE owner_uid = ? AND acc_key = ?`, [ownerUid, key]);
    await query(`DELETE FROM omni_account_state WHERE owner_uid = ? AND acc_key = ?`, [ownerUid, key]);
    invalidate(ownerUid);

    await log(ownerUid, { kind: "account", summary: `Deleted ${acc.name}`, channels: [channelOf(key)] });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

let timeCol = null;
async function chatTimeCol() {
  if (timeCol) return timeCol;
  const cols = await query(`SHOW COLUMNS FROM beta_chats`, []);
  const names = cols.map((c) => c.Field);
  timeCol = names.includes("last_message_came")
    ? "last_message_came"
    : names.includes("updatedAt")
      ? "updatedAt"
      : "id";
  return timeCol;
}

router.get("/customers", validateUser, async (req, res) => {
  try {
    await ensure();
    const ownerUid = own(req);
    const key = String(req.query.key || "");
    const [acc] = await ownedAccount(ownerUid, key);
    if (!acc) return res.json({ success: false, msg: "Account not found" });
    const p = parseKey(key);
    const m = accountMatch(p.channel, p.account_id);
    const q = String(req.query.q || "").trim();
    const size = 8;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const only = String(req.query.only || "") === "vip";

    const where = [`uid = ?`, m.sql];
    const params = [ownerUid, ...m.params];
    if (q) {
      where.push(`(sender_name LIKE ? OR sender_mobile LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`);
    }
    const vip = await vipRows(ownerUid, `AND acc_key = ?`, [key]);
    if (only) {
      if (!vip.length) return res.json({ success: true, data: { total: 0, page, size, rows: [] } });
      where.push(`chat_id IN (${vip.map(() => "?").join(",")})`);
      params.push(...vip.map((v) => v.chat_id));
    }
    const T = await chatTimeCol();
    const [{ n }] = await query(`SELECT COUNT(*) n FROM beta_chats WHERE ${where.join(" AND ")}`, params);
    const rows = await query(
      `SELECT chat_id, sender_name, sender_mobile, ${T} AS last_at FROM beta_chats
        WHERE ${where.join(" AND ")} ORDER BY ${T} DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
      params,
    );
    const vipBy = new Map(vip.map((v) => [v.chat_id, v]));
    res.json({
      success: true,
      data: {
        total: Number(n),
        page,
        size,
        rows: rows.map((r) => ({
          chat_id: r.chat_id,
          name: r.sender_name || r.sender_mobile || "Unknown",
          mobile: r.sender_mobile || "",
          last_at: r.last_at,
          vip: vipBy.get(r.chat_id)
            ? {
                agent_uid: vipBy.get(r.chat_id).agent_uid,
                exclusive: !!Number(vipBy.get(r.chat_id).exclusive),
              }
            : null,
        })),
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

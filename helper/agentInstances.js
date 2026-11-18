// Agent <-> WhatsApp number (instance) assignment

const { query } = require("../database/dbpromise");

// Digits only — guards the LIKE patterns against anything odd in the DB
function normalizeNumber(raw) {
  return String(raw || "").replace(/\D/g, "");
}

// Numbers assigned to one agent
async function getAgentNumbers(agentUid) {
  if (!agentUid) return [];

  try {
    const rows = await query(`SELECT instance_number FROM agent_instances WHERE agent_uid = ?`, [agentUid]);

    return rows.map((r) => normalizeNumber(r.instance_number)).filter((n) => n.length > 0);
  } catch (err) {
    // Missing table: fall back to chat-level assignment only
    if (err?.code === "ER_NO_SUCH_TABLE") return [];
    throw err;
  }
}

// SQL fragment restricting beta_chats to what an agent may see
async function buildAgentChatCondition(agentId, agentUid) {
  // The id must end right after the digits
  const id = String(agentId).replace(/\D/g, "");
  const manual = [`assigned_agent LIKE ?`, `assigned_agent LIKE ?`, `assigned_agent LIKE ?`];
  const params = [`%"id":${id},%`, `%"id":${id}}%`, `%"id":"${id}"%`];

  // Paused accounts and VIP customers (helper/omniAccess.js)
  let rules = { deactivated: new Set(), vip: [] };
  try {
    const [me] = await query(`SELECT owner_uid FROM agents WHERE uid = ? LIMIT 1`, [agentUid]);
    rules = await require("./omniAccess").rulesFor(me?.owner_uid);
  } catch (err) {
    console.error("[agentInstances] access rules:", err?.message || err);
  }

  // Whole accounts assigned to this agent
  const account = [];
  const accountParams = [];

  const numbers = await getAgentNumbers(agentUid);

  for (const number of numbers) {
    if (rules.deactivated.has(`qr:${number}`)) continue;
    // WhatsApp chats only; the number must end at ':' or '@' so one number can't match a longer one
    account.push(
      `(origin NOT IN ('messenger','instagram','instagram_comment','telegram') AND ` +
        `(origin_instance_id LIKE ? OR origin_instance_id LIKE ?))`,
    );
    accountParams.push(`%"id":"${number}:%`, `%"id":"${number}@%`);
  }

  // Pages, Instagram, Cloud API and Telegram assigned to this agent
  try {
    const A = require("./agentAccounts");
    for (const key of await A.getAgentAccountKeys(agentUid)) {
      const parsed = A.parseKey(key);
      if (!parsed || parsed.channel === "qr" || rules.deactivated.has(key)) continue;
      const m = A.accountMatch(parsed.channel, parsed.account_id);
      if (!m) continue;
      account.push(m.sql);
      accountParams.push(...m.params);
    }
  } catch (err) {
    console.error("[agentInstances] account clauses:", err?.message || err);
  }

  const { inList } = require("./omniAccess");
  // VIP customers given to someone else only: hide them from this agent's whole-account access
  const taken = inList(
    "chat_id",
    rules.vip.filter((v) => Number(v.exclusive) && v.agent_uid !== agentUid).map((v) => v.chat_id),
  );
  // VIP customers given to this agent (not on a deactivated account)
  const mine = inList(
    "chat_id",
    rules.vip
      .filter((v) => v.agent_uid === agentUid && !rules.deactivated.has(v.acc_key))
      .map((v) => v.chat_id),
  );

  const clauses = [...manual];
  if (account.length) {
    const whole = `(${account.join(" OR ")})`;
    if (taken) {
      clauses.push(`(${whole} AND NOT ${taken.sql})`);
      params.push(...accountParams, ...taken.params);
    } else {
      clauses.push(whole);
      params.push(...accountParams);
    }
  }
  if (mine) {
    clauses.push(mine.sql);
    params.push(...mine.params);
  }

  return { sql: `(${clauses.join(" OR ")})`, params };
}

// Agents to notify: assigned to the chat, or to the number it came in on
async function getAgentsForChat({ ownerUid, chatId }) {
  if (!ownerUid || !chatId) return [];

  const [chat] = await query(
    `SELECT assigned_agent, origin, origin_instance_id FROM beta_chats
      WHERE chat_id = ? AND uid = ? LIMIT 1`,
    [chatId, ownerUid],
  );

  if (!chat) return [];

  const byUid = new Map();
  const viaAccount = new Map(); // assigned to the account it came in on

  // 1. Agents assigned to this specific chat (stock behaviour)
  try {
    const parsed = chat.assigned_agent ? JSON.parse(chat.assigned_agent) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
    for (const a of list) {
      if (a?.uid) byUid.set(a.uid, a);
    }
  } catch {
    // assigned_agent is free-form text in the schema; ignore bad JSON
  }

  // 2. Agents assigned to the number this chat arrived on
  const instanceId = String(chat.origin_instance_id || "");
  const match = instanceId.match(/"id":"(\d+)/);

  if (match) {
    const number = normalizeNumber(match[1]);
    const rows = await query(
      `SELECT a.id, a.uid, a.name, a.email
         FROM agent_instances ai
         JOIN agents a ON a.uid = ai.agent_uid
        WHERE ai.owner_uid = ? AND ai.instance_number = ? AND a.is_active = 1`,
      [ownerUid, number],
    ).catch((err) => {
      if (err?.code === "ER_NO_SUCH_TABLE") return [];
      throw err;
    });

    for (const a of rows) {
      if (a?.uid) viaAccount.set(a.uid, a);
    }
  }

  // 3. Agents assigned to the Page / Instagram account / channel
  try {
    const rows = await require("./agentAccounts").getAccountAgentsForChat({
      ownerUid,
      origin: chat.origin,
      originInstanceId: chat.origin_instance_id,
    });
    for (const a of rows || []) {
      if (a?.uid) viaAccount.set(a.uid, a);
    }
  } catch (err) {
    console.error("[agentInstances] account agents:", err?.message || err);
  }

  // 4. Deactivated account / VIP customer (helper/omniAccess.js)
  try {
    const rules = await require("./omniAccess").rulesFor(ownerUid);
    const key = chatAccountKey(chat);
    const vip = rules.vip.find((v) => v.chat_id === chatId);
    const off = (key && rules.deactivated.has(key)) || (vip && rules.deactivated.has(vip.acc_key));

    if (off) viaAccount.clear();
    else if (vip && Number(vip.exclusive)) viaAccount.clear();

    if (vip && !off && !byUid.has(vip.agent_uid)) {
      const [a] = await query(
        `SELECT id, uid, name, email FROM agents WHERE uid = ? AND owner_uid = ? AND is_active = 1 LIMIT 1`,
        [vip.agent_uid, ownerUid],
      );
      if (a) viaAccount.set(a.uid, a);
    }
  } catch (err) {
    console.error("[agentInstances] access rules:", err?.message || err);
  }

  for (const [uid, a] of viaAccount) if (!byUid.has(uid)) byUid.set(uid, a);
  return [...byUid.values()];
}

// "qr:2010...", "messenger:123", ..
function chatAccountKey(chat) {
  const origin = String(chat?.origin || "");
  const inst = String(chat?.origin_instance_id || "");
  if (origin === "meta") return "meta:all";
  if (origin === "telegram") return "telegram:all";
  const id = (inst.match(/"id":"?([A-Za-z0-9]+)/) || [])[1];
  if (!id) return null;
  if (origin === "messenger") return `messenger:${id}`;
  if (origin === "instagram" || origin === "instagram_comment") return `instagram:${id}`;
  return `qr:${normalizeNumber(id)}`;
}

// The agent fields that may be stored in beta_chats.assigned_agent
function publicAgent(a) {
  if (!a || typeof a !== "object") return a;
  return {
    id: a.id,
    owner_uid: a.owner_uid,
    uid: a.uid,
    role: a.role,
    email: a.email,
    name: a.name,
    mobile: a.mobile,
    is_active: a.is_active,
  };
}

// Strip private agent fields from old chats, a batch per call
async function scrubAssignedAgents(limit = 300) {
  const rows = await query(
    `SELECT id, assigned_agent FROM beta_chats
     WHERE assigned_agent LIKE '%"password"%' LIMIT ?`,
    [limit],
  );
  let fixed = 0;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.assigned_agent);
      const list = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
      await query(`UPDATE beta_chats SET assigned_agent = ?, updatedAt = updatedAt WHERE id = ?`, [
        JSON.stringify(list.map(publicAgent)),
        row.id,
      ]);
      fixed += 1;
    } catch (e) {}
  }
  if (fixed) console.log(`[agents] removed private agent fields from ${fixed} chat(s)`);
  return fixed;
}

module.exports = {
  publicAgent,
  scrubAssignedAgents,
  normalizeNumber,
  chatAccountKey,
  getAgentNumbers,
  buildAgentChatCondition,
  getAgentsForChat,
};

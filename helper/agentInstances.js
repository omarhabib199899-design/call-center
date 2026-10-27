/**
 * Agent <-> WhatsApp number (instance) assignment.
 *
 * The stock product only lets an agent be assigned to individual chats
 * (beta_chats.assigned_agent). This module adds assignment at the number
 * level: an agent assigned to a number sees every chat that arrived on it.
 *
 * Chats record their number in beta_chats.origin_instance_id, which holds
 * JSON written by the QR layer, e.g.
 *   {"id":"201094646331:63@s.whatsapp.net","lid":"1867753099:63@lid"}
 * so a number is matched with a LIKE against the "id" field.
 *
 * Everything here is additive: chat-level assignment keeps working exactly
 * as before, and an agent with no numbers assigned behaves as it always did.
 */

const { query } = require("../database/dbpromise");

/** Digits only — guards the LIKE patterns against anything odd in the DB. */
function normalizeNumber(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * Numbers assigned to one agent.
 * @returns {Promise<string[]>} normalized numbers, possibly empty
 */
async function getAgentNumbers(agentUid) {
  if (!agentUid) return [];

  try {
    const rows = await query(
      `SELECT instance_number FROM agent_instances WHERE agent_uid = ?`,
      [agentUid],
    );

    return rows
      .map((r) => normalizeNumber(r.instance_number))
      .filter((n) => n.length > 0);
  } catch (err) {
    // A missing table must not take the inbox down — fall back to
    // stock behaviour (chat-level assignment only).
    if (err?.code === "ER_NO_SUCH_TABLE") return [];
    throw err;
  }
}

/**
 * SQL fragment restricting beta_chats to what an agent may see.
 *
 * Returns the stock chat-level condition OR'd with the agent's numbers:
 *   assigned_agent LIKE '%"id":5%'
 *   OR assigned_agent LIKE '%"id":"5"%'
 *   OR origin_instance_id LIKE '%"id":"201094646331%'
 *
 * @param {number|string} agentId  agents.id, as used by the stock filter
 * @param {string} agentUid        agents.uid
 * @returns {Promise<{sql: string, params: any[]}>}
 */
async function buildAgentChatCondition(agentId, agentUid) {
  // [CUSTOM] The id must end right after the digits. The stock pattern
  // '%"id":1%' also matched agents 10-19, 100+..., so agent 1 saw chats
  // assigned to agent 12.
  const id = String(agentId).replace(/\D/g, "");
  const clauses = [
    `assigned_agent LIKE ?`,
    `assigned_agent LIKE ?`,
    `assigned_agent LIKE ?`,
  ];
  const params = [`%"id":${id},%`, `%"id":${id}}%`, `%"id":"${id}"%`];

  const numbers = await getAgentNumbers(agentUid);

  for (const number of numbers) {
    // [CUSTOM] WhatsApp chats only (Pages/Instagram are matched by
    // agentAccounts below), and the number must end at ':' or '@' so
    // 2010946 cannot match 201094646331.
    clauses.push(
      `(origin NOT IN ('messenger','instagram','instagram_comment','telegram') AND ` +
        `(origin_instance_id LIKE ? OR origin_instance_id LIKE ?))`,
    );
    params.push(`%"id":"${number}:%`, `%"id":"${number}@%`);
  }

  // [CUSTOM] Facebook Pages, Instagram accounts, Cloud API and Telegram
  // assigned to this agent (helper/agentAccounts.js). Required lazily:
  // agentAccounts requires this file too.
  try {
    const extra = await require("./agentAccounts").buildAccountClauses(agentUid);
    clauses.push(...extra.clauses);
    params.push(...extra.params);
  } catch (err) {
    console.error("[agentInstances] account clauses:", err?.message || err);
  }

  return { sql: `(${clauses.join(" OR ")})`, params };
}

/**
 * Agents who should be notified about a chat: those assigned to the chat
 * itself plus those assigned to the number it arrived on.
 *
 * @returns {Promise<Array<{id:number, uid:string, name:string, email:string}>>}
 */
async function getAgentsForChat({ ownerUid, chatId }) {
  if (!ownerUid || !chatId) return [];

  const [chat] = await query(
    `SELECT assigned_agent, origin, origin_instance_id FROM beta_chats
      WHERE chat_id = ? AND uid = ? LIMIT 1`,
    [chatId, ownerUid],
  );

  if (!chat) return [];

  const byUid = new Map();

  // 1. Agents assigned to this specific chat (stock behaviour).
  try {
    const parsed = chat.assigned_agent ? JSON.parse(chat.assigned_agent) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
    for (const a of list) {
      if (a?.uid) byUid.set(a.uid, a);
    }
  } catch {
    // assigned_agent is free-form text in the schema; ignore bad JSON.
  }

  // 2. Agents assigned to the number this chat arrived on.
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
      if (a?.uid) byUid.set(a.uid, a);
    }
  }

  // 3. [CUSTOM] Agents assigned to the Page / Instagram account / channel.
  try {
    const rows = await require("./agentAccounts").getAccountAgentsForChat({
      ownerUid,
      origin: chat.origin,
      originInstanceId: chat.origin_instance_id,
    });
    for (const a of rows || []) {
      if (a?.uid) byUid.set(a.uid, a);
    }
  } catch (err) {
    console.error("[agentInstances] account agents:", err?.message || err);
  }

  return [...byUid.values()];
}

/**
 * [CUSTOM] The agent fields that may be stored in beta_chats.assigned_agent.
 * Stock code stored the whole agents row (password hash, push tokens, logs)
 * in every assigned chat, and that JSON is sent to browsers.
 */
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

/** [CUSTOM] Strip private agent fields from old chats, a batch per call. */
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
      await query(
        `UPDATE beta_chats SET assigned_agent = ?, updatedAt = updatedAt WHERE id = ?`,
        [JSON.stringify(list.map(publicAgent)), row.id],
      );
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
  getAgentNumbers,
  buildAgentChatCondition,
  getAgentsForChat,
};

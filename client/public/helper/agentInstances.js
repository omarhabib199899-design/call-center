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
  const clauses = [`assigned_agent LIKE ?`, `assigned_agent LIKE ?`];
  const params = [`%"id":${agentId}%`, `%"id":"${agentId}"%`];

  const numbers = await getAgentNumbers(agentUid);

  for (const number of numbers) {
    clauses.push(`origin_instance_id LIKE ?`);
    params.push(`%"id":"${number}%`);
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
    `SELECT assigned_agent, origin_instance_id FROM beta_chats
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

  return [...byUid.values()];
}

module.exports = {
  normalizeNumber,
  getAgentNumbers,
  buildAgentChatCondition,
  getAgentsForChat,
};

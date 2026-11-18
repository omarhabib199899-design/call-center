/**
 * [CUSTOM] Extra rules for what an agent sees, set from the new
 * Agents & Channels page (routes/omniAgents.js):
 *
 *  - Deactivated accounts: kept connected, but agents stop seeing the chats
 *    that arrive on them (the owner still sees everything).
 *  - VIP customers: a chat can be given to one agent ("specific customers").
 *    With exclusive=1 only that agent (plus anyone assigned to the chat by
 *    hand) sees it; with exclusive=0 the agent gets it on top of whoever
 *    already handles the account.
 *
 * Both tables are created by routes/omniAgents.js. When they don't exist
 * yet, every function here returns "no rules", so the inbox behaves exactly
 * as before.
 */

const { query } = require("../database/dbpromise");

const TTL = 15 * 1000;
const cache = new Map(); // ownerUid -> { at, deactivated:Set, vip:[] }

function tolerate(err) {
  if (err?.code === "ER_NO_SUCH_TABLE" || err?.code === "ER_BAD_FIELD_ERROR") return [];
  throw err;
}

async function rulesFor(ownerUid) {
  if (!ownerUid) return { deactivated: new Set(), vip: [] };
  const hit = cache.get(ownerUid);
  if (hit && Date.now() - hit.at < TTL) return hit;

  const off = await query(
    `SELECT acc_key FROM omni_account_state WHERE owner_uid = ? AND deactivated = 1`,
    [ownerUid],
  ).catch(tolerate);
  const vip = await query(
    `SELECT chat_id, agent_uid, acc_key, exclusive FROM omni_vip WHERE owner_uid = ?`,
    [ownerUid],
  ).catch(tolerate);

  const out = { at: Date.now(), deactivated: new Set(off.map((r) => r.acc_key)), vip };
  cache.set(ownerUid, out);
  return out;
}

/** Call after any change so agents see it right away. */
function invalidate(ownerUid) {
  if (ownerUid) cache.delete(ownerUid);
  else cache.clear();
}

/** chat_id IN (...) for a list of ids, or null when the list is empty. */
function inList(col, ids) {
  if (!ids.length) return null;
  return { sql: `${col} IN (${ids.map(() => "?").join(",")})`, params: ids };
}

module.exports = { rulesFor, invalidate, inList };

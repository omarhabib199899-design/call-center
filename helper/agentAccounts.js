/**
 * Agent <-> connected account assignment, for every channel.
 *
 * Extends the WhatsApp-number assignment in agentInstances.js to Facebook
 * Pages, Instagram accounts, WhatsApp Cloud API and Telegram. An agent
 * assigned to an account sees every chat that arrives on it.
 *
 * Accounts are addressed by a key "<channel>:<account_id>":
 *   qr:201094646331         WhatsApp QR number   (stored in agent_instances)
 *   messenger:1234567890    Facebook Page id     (stored in agent_accounts)
 *   instagram:178414...     Instagram user id    (stored in agent_accounts)
 *   meta:all                WhatsApp Cloud API   (one per owner)
 *   telegram:all            Telegram             (chats don't record which
 *                                                 session they came in on)
 *
 * Chats are matched on beta_chats.origin + origin_instance_id, which each
 * channel already writes (see helper/inbox/messenger, addon/insta, ...).
 *
 * Also stores a per-user inbox filter, so the inbox can be narrowed to a
 * single account. The panel is a compiled bundle, so the filter is kept
 * server-side and applied in get_chat_list instead of sent by the client.
 */

const { query } = require("../database/dbpromise");
const { normalizeNumber } = require("./agentInstances");

const CHANNELS = ["qr", "meta", "messenger", "instagram", "telegram"];

/** Channels that have a single account per owner. */
const WHOLE_CHANNEL = { meta: true, telegram: true };

/* ---------- tables ---------------------------------------------------- */

let tablesReady = null;

/** Creates the two tables on first use, so no manual migration is needed. */
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS agent_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_uid VARCHAR(255) NOT NULL,
        agent_id INT NULL,
        agent_uid VARCHAR(255) NOT NULL,
        channel VARCHAR(32) NOT NULL,
        account_id VARCHAR(255) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_agent_account (agent_uid, channel, account_id),
        KEY idx_owner (owner_uid)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS inbox_account_filter (
        user_uid VARCHAR(255) NOT NULL PRIMARY KEY,
        channel VARCHAR(32) NOT NULL,
        account_id VARCHAR(255) NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    })().catch((err) => {
      tablesReady = null; // retry next time
      throw err;
    });
  }
  return tablesReady;
}

/* ---------- keys ------------------------------------------------------ */

/** Ids end up inside LIKE patterns, so keep letters and digits only. */
function cleanId(raw) {
  return String(raw == null ? "" : raw).replace(/[^A-Za-z0-9]/g, "");
}

/** "messenger:123" -> { channel, account_id }, or null if malformed. */
function parseKey(key) {
  const str = String(key || "");
  const i = str.indexOf(":");
  if (i === -1) return null;

  const channel = str.slice(0, i);
  if (!CHANNELS.includes(channel)) return null;

  const account_id =
    channel === "qr" ? normalizeNumber(str.slice(i + 1)) : cleanId(str.slice(i + 1));
  if (!account_id) return null;

  return { channel, account_id };
}

function toKey(channel, accountId) {
  return `${channel}:${accountId}`;
}

/* ---------- matching -------------------------------------------------- */

/** origin_instance_id LIKE patterns for an id stored quoted or as a number. */
function idPatterns(id) {
  return [`%"id":"${id}"%`, `%"id":${id},%`, `%"id":${id}}%`];
}

/**
 * SQL fragment matching the beta_chats rows that arrived on one account.
 * @returns {{sql: string, params: any[]}|null}
 */
function accountMatch(channel, accountId) {
  const id = channel === "qr" ? normalizeNumber(accountId) : cleanId(accountId);
  if (!id) return null;

  switch (channel) {
    case "qr":
      // Same shape agentInstances.js uses: {"id":"2010...:63@s.whatsapp.net"}
      return { sql: `origin_instance_id LIKE ?`, params: [`%"id":"${id}%`] };

    case "messenger":
      return {
        sql: `(origin = 'messenger' AND (origin_instance_id LIKE ? OR origin_instance_id LIKE ? OR origin_instance_id LIKE ?))`,
        params: idPatterns(id),
      };

    case "instagram":
      return {
        sql: `(origin IN ('instagram','instagram_comment') AND (origin_instance_id LIKE ? OR origin_instance_id LIKE ? OR origin_instance_id LIKE ?))`,
        params: idPatterns(id),
      };

    case "meta":
      return { sql: `origin = 'meta'`, params: [] };

    case "telegram":
      return { sql: `origin = 'telegram'`, params: [] };

    default:
      return null;
  }
}

/* ---------- lookups --------------------------------------------------- */

/** A missing table or column must never take the inbox down. */
function tolerate(err) {
  if (err?.code === "ER_NO_SUCH_TABLE" || err?.code === "ER_BAD_FIELD_ERROR") {
    return [];
  }
  throw err;
}

/**
 * Every account the owner has connected, across channels.
 * @returns {Promise<Array<{key, channel, account_id, name, detail, online}>>}
 */
async function listOwnerAccounts(ownerUid) {
  const out = [];

  const instances = await query(
    `SELECT title, number, status FROM instance WHERE uid = ? ORDER BY id DESC`,
    [ownerUid],
  ).catch(tolerate);

  for (const i of instances) {
    const number = normalizeNumber(i.number);
    if (!number) continue;
    out.push({
      key: toKey("qr", number),
      channel: "qr",
      account_id: number,
      name: i.title || "WhatsApp",
      detail: number,
      online: String(i.status || "").toLowerCase().includes("connect"),
    });
  }

  const [meta] = await query(
    `SELECT business_phone_number_id FROM meta_api WHERE uid = ? LIMIT 1`,
    [ownerUid],
  ).catch(tolerate);

  if (meta?.business_phone_number_id) {
    out.push({
      key: toKey("meta", "all"),
      channel: "meta",
      account_id: "all",
      name: "WhatsApp Cloud API",
      detail: String(meta.business_phone_number_id),
      online: true,
    });
  }

  const pages = await query(
    `SELECT page_id, page_name FROM messenger_accounts WHERE uid = ? ORDER BY id DESC`,
    [ownerUid],
  ).catch(tolerate);

  for (const p of pages) {
    const id = cleanId(p.page_id);
    if (!id) continue;
    out.push({
      key: toKey("messenger", id),
      channel: "messenger",
      account_id: id,
      name: p.page_name || "Facebook Page",
      detail: id,
      online: true,
    });
  }

  const igs = await query(
    `SELECT user_id, webhook_id, username, name FROM instagram_accounts WHERE uid = ? ORDER BY id DESC`,
    [ownerUid],
  ).catch(tolerate);

  for (const ig of igs) {
    // Same id processInstagram.js writes into origin_instance_id.
    const id = cleanId(ig.user_id || ig.webhook_id);
    if (!id) continue;
    out.push({
      key: toKey("instagram", id),
      channel: "instagram",
      account_id: id,
      name: ig.username ? `@${ig.username}` : ig.name || "Instagram",
      detail: ig.name || id,
      online: true,
    });
  }

  const [tele] = await query(
    `SELECT session_id FROM telegram_session WHERE uid = ? LIMIT 1`,
    [ownerUid],
  ).catch(tolerate);

  if (tele) {
    out.push({
      key: toKey("telegram", "all"),
      channel: "telegram",
      account_id: "all",
      name: "Telegram",
      detail: "",
      online: true,
    });
  }

  return out;
}

/** Keys assigned to one agent, across both tables. */
async function getAgentAccountKeys(agentUid) {
  if (!agentUid) return [];

  const numbers = await query(
    `SELECT instance_number FROM agent_instances WHERE agent_uid = ?`,
    [agentUid],
  ).catch(tolerate);

  await ensureTables().catch(() => {});
  const rows = await query(
    `SELECT channel, account_id FROM agent_accounts WHERE agent_uid = ?`,
    [agentUid],
  ).catch(tolerate);

  return [
    ...numbers
      .map((r) => normalizeNumber(r.instance_number))
      .filter(Boolean)
      .map((n) => toKey("qr", n)),
    ...rows.map((r) => toKey(r.channel, r.account_id)),
  ];
}

/**
 * Replaces an agent's non-QR accounts. QR numbers stay in agent_instances
 * and are written by the caller, so the existing number feature is untouched.
 */
async function setAgentAccounts({ ownerUid, agentId, agentUid, keys }) {
  await ensureTables();

  await query(`DELETE FROM agent_accounts WHERE owner_uid = ? AND agent_uid = ?`, [
    ownerUid,
    agentUid,
  ]);

  for (const key of keys) {
    const parsed = parseKey(key);
    if (!parsed || parsed.channel === "qr") continue;
    await query(
      `INSERT IGNORE INTO agent_accounts (owner_uid, agent_id, agent_uid, channel, account_id)
       VALUES (?,?,?,?,?)`,
      [ownerUid, agentId, agentUid, parsed.channel, parsed.account_id],
    );
  }
}

/**
 * SQL clauses for the non-QR accounts of one agent, to be OR'd into the
 * agent's chat scope by agentInstances.buildAgentChatCondition.
 */
async function buildAccountClauses(agentUid) {
  const keys = await getAgentAccountKeys(agentUid);
  const clauses = [];
  const params = [];

  for (const key of keys) {
    const parsed = parseKey(key);
    if (!parsed || parsed.channel === "qr") continue; // handled by agentInstances
    const m = accountMatch(parsed.channel, parsed.account_id);
    if (!m) continue;
    clauses.push(m.sql);
    params.push(...m.params);
  }

  return { clauses, params };
}

/**
 * Agents assigned to the account a chat arrived on (non-QR channels).
 * @returns {Promise<Array<{id, uid, name, email}>>}
 */
async function getAccountAgentsForChat({ ownerUid, origin, originInstanceId }) {
  let channel = String(origin || "");
  if (channel === "instagram_comment") channel = "instagram";
  if (!CHANNELS.includes(channel) || channel === "qr") return [];

  let accountId = "all";
  if (!WHOLE_CHANNEL[channel]) {
    const match = String(originInstanceId || "").match(/"id":"?([A-Za-z0-9]+)/);
    if (!match) return [];
    accountId = match[1];
  }

  return query(
    `SELECT a.id, a.uid, a.name, a.email
       FROM agent_accounts aa
       JOIN agents a ON a.uid = aa.agent_uid
      WHERE aa.owner_uid = ? AND aa.channel = ? AND aa.account_id = ? AND a.is_active = 1`,
    [ownerUid, channel, accountId],
  ).catch(tolerate);
}

/* ---------- inbox filter --------------------------------------------- */

async function getInboxFilter(userUid) {
  if (!userUid) return null;
  await ensureTables().catch(() => {});
  const [row] = await query(
    `SELECT channel, account_id FROM inbox_account_filter WHERE user_uid = ? LIMIT 1`,
    [userUid],
  ).catch(tolerate);
  return row ? { channel: row.channel, account_id: row.account_id } : null;
}

/** Pass a null key to clear the filter. */
async function setInboxFilter(userUid, key) {
  await ensureTables();
  const parsed = key ? parseKey(key) : null;

  if (!parsed) {
    await query(`DELETE FROM inbox_account_filter WHERE user_uid = ?`, [userUid]);
    return null;
  }

  await query(
    `INSERT INTO inbox_account_filter (user_uid, channel, account_id) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE channel = VALUES(channel), account_id = VALUES(account_id)`,
    [userUid, parsed.channel, parsed.account_id],
  );
  return parsed;
}

/** SQL fragment for a user's saved inbox filter, or null when none is set. */
async function buildInboxFilterCondition(userUid) {
  const filter = await getInboxFilter(userUid);
  if (!filter) return null;
  return accountMatch(filter.channel, filter.account_id);
}

module.exports = {
  CHANNELS,
  ensureTables,
  parseKey,
  toKey,
  accountMatch,
  listOwnerAccounts,
  getAgentAccountKeys,
  setAgentAccounts,
  buildAccountClauses,
  getAccountAgentsForChat,
  getInboxFilter,
  setInboxFilter,
  buildInboxFilterCondition,
};

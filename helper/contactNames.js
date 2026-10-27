/**
 * [CUSTOM] Real names for Messenger and Instagram customers.
 *
 * Stock WhatsCRM stored Messenger customers as "msng_<id>" and Instagram ones
 * as "ig_<id>", so the inbox showed a meaningless number. This looks the name
 * up once from Meta and keeps it in beta_chats.sender_name.
 *
 *   Messenger  GET /<PSID>?fields=first_name,last_name  (Page token)
 *              fallback: the Page conversation's participants (has the name)
 *   Instagram  GET /<IGSID>?fields=name,username
 *
 * Lookups are cached in memory (failures for an hour) and never throw; when
 * nothing is found the caller keeps the old placeholder.
 */

const { query } = require("../database/dbpromise");
const fetch = require("node-fetch");

const GRAPH_FB = "https://graph.facebook.com/v21.0";
const GRAPH_IG = "https://graph.instagram.com/v21.0";
const FAIL_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

const cache = new Map(); // key -> { name, at }

function log(...args) {
  console.log("[contactNames]", ...args);
}

/** True for names the stock code made up ("msng_123", "ig_123", ...). */
function isPlaceholder(name) {
  const n = String(name || "").trim();
  return (
    !n ||
    /^(msng|ig)_\d+$/i.test(n) ||
    /^\d{6,}$/.test(n) ||
    n === "Messenger User" ||
    n === "Instagram User" ||
    n === "NA"
  );
}

async function getJson(url) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    return await res.json().catch(() => ({}));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchMessengerName({ psid, pageId, token }) {
  const t = encodeURIComponent(token);
  // Only first_name/last_name: asking for "name" on a PSID makes Graph
  // reject the whole request ("nonexisting field").
  const p = await getJson(
    `${GRAPH_FB}/${psid}?fields=first_name,last_name&access_token=${t}`,
  );
  const direct = [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim();
  if (direct) return direct;

  // Fallback: the conversation's participant list carries the name.
  const c = await getJson(
    `${GRAPH_FB}/${pageId}/conversations?platform=messenger&user_id=${psid}` +
      `&fields=participants&access_token=${t}`,
  );
  const people = c?.data?.[0]?.participants?.data || [];
  const me = people.find((x) => String(x?.id) === String(psid));
  if (me?.name) return me.name;

  if (p?.error) log(`messenger ${psid}:`, p.error.message);
  if (c?.error) log(`messenger ${psid} (conversations):`, c.error.message);
  return null;
}

async function fetchInstagramName({ igsid, igAccount }) {
  const pageLinked =
    String(igAccount?.token_type || "").toLowerCase() === "page";
  const base = pageLinked ? GRAPH_FB : GRAPH_IG;
  const d = await getJson(
    `${base}/${igsid}?fields=name,username&access_token=${encodeURIComponent(
      igAccount.access_token,
    )}`,
  );
  if (d?.error) log(`instagram ${igsid}:`, d.error.message);
  return d?.name || d?.username || null;
}

/**
 * The customer's display name for a Messenger/Instagram chat, or null.
 * Order: name already stored on the chat -> cache -> Meta.
 */
async function resolveName({ origin, uid, chatId, otherId, account }) {
  try {
    if (!otherId || !account?.access_token && !account?.page_access_token) {
      return null;
    }

    const [chat] = await query(
      `SELECT sender_name FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
      [chatId, uid],
    );
    if (chat && !isPlaceholder(chat.sender_name)) return chat.sender_name;

    const key = `${origin}:${otherId}`;
    const hit = cache.get(key);
    if (hit && (hit.name || Date.now() - hit.at < FAIL_TTL_MS)) return hit.name;

    let name = null;
    if (origin === "messenger") {
      name = await fetchMessengerName({
        psid: otherId,
        pageId: account.page_id,
        token: account.page_access_token,
      });
    } else if (origin === "instagram") {
      name = await fetchInstagramName({ igsid: otherId, igAccount: account });
    }

    cache.set(key, { name: name || null, at: Date.now() });
    return name || null;
  } catch (err) {
    log(`${origin} ${otherId}:`, err?.message || err);
    return null;
  }
}

/**
 * Fill in names for existing chats that still have a placeholder.
 * A few per call, so old chats get named gradually without a burst of
 * Graph calls. Returns how many chats were renamed.
 */
async function backfill(limit = 15) {
  let renamed = 0;
  const rows = await query(
    `SELECT id, uid, chat_id, sender_mobile, sender_name, origin, origin_instance_id
     FROM beta_chats
     WHERE origin IN ('messenger', 'instagram')
       AND (sender_name IS NULL OR sender_name = '' OR sender_name LIKE 'msng\\_%'
            OR sender_name LIKE 'ig\\_%' OR sender_name IN ('Messenger User','Instagram User','NA'))
     ORDER BY updatedAt DESC LIMIT 200`,
    [],
  );

  let tried = 0;
  for (const row of rows) {
    if (tried >= limit) break;
    if (cache.has(`${row.origin}:${row.sender_mobile}`)) continue;
    tried += 1;

    let instanceId = null;
    try {
      instanceId = JSON.parse(row.origin_instance_id || "{}")?.id;
    } catch (e) {}
    if (!instanceId) continue;

    let account = null;
    if (row.origin === "messenger") {
      [account] = await query(
        `SELECT page_id, page_access_token FROM messenger_accounts
         WHERE page_id = ? AND uid = ? LIMIT 1`,
        [instanceId, row.uid],
      );
    } else {
      [account] = await query(
        `SELECT * FROM instagram_accounts WHERE user_id = ? AND uid = ? LIMIT 1`,
        [instanceId, row.uid],
      );
    }
    if (!account) continue;

    const name = await resolveName({
      origin: row.origin,
      uid: row.uid,
      chatId: row.chat_id,
      otherId: row.sender_mobile,
      account,
    });
    if (name && !isPlaceholder(name)) {
      // keep updatedAt so renaming does not reorder the chat list
      await query(`UPDATE beta_chats SET sender_name = ?, updatedAt = updatedAt WHERE id = ?`, [
        name,
        row.id,
      ]);
      renamed += 1;
    }
  }
  if (renamed) log(`named ${renamed} existing chat(s)`);
  return renamed;
}

module.exports = { resolveName, backfill, isPlaceholder };

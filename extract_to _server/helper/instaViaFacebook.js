/**
 * Instagram accounts reached through a connected Facebook Page.
 *
 * Stock WhatsCRM links an Instagram account only through "Instagram Login":
 * every account signs in on its own. Meta also supports "Instagram API with
 * Facebook Login", where a Page that has an Instagram professional account
 * attached can message that account using the Page's own access token. That
 * is what this module adds, so connecting a Facebook Page also connects the
 * Instagram account behind it.
 *
 * The result is stored in the existing `instagram_accounts` table, so the
 * Link Instagram screen, the inbox and the webhook handler all see these
 * accounts exactly like the ones linked the stock way. The only difference is
 * `token_type = 'page'`, which tells the sender to use the Page token against
 * graph.facebook.com instead of an Instagram token against graph.instagram.com.
 *
 * Nothing here may break a Messenger connection: every failure is caught and
 * reported back as data, never thrown.
 */

const { query } = require("../database/dbpromise");
const logger = require("../utils/logger");

const GRAPH_VERSION = "v24.0";
const PAGE_TOKEN_TYPE = "page";

/** True when an instagram_accounts row was created through a Facebook Page. */
function isPageLinked(igAccount) {
  return String(igAccount?.token_type || "").toLowerCase() === PAGE_TOKEN_TYPE;
}

/**
 * Where to POST an outgoing Instagram message for this account.
 *   Instagram Login -> graph.instagram.com/<ver>/me/messages  (Instagram token)
 *   Facebook Login  -> graph.facebook.com/<ver>/<page>/messages (Page token)
 */
function messagesUrl(igAccount, legacyVersion) {
  const token = encodeURIComponent(igAccount.access_token);

  if (isPageLinked(igAccount) && igAccount.page_id) {
    return `https://graph.facebook.com/${GRAPH_VERSION}/${igAccount.page_id}/messages?access_token=${token}`;
  }

  return `https://graph.instagram.com/${legacyVersion}/me/messages?access_token=${token}`;
}

/** Ask Facebook which Instagram account, if any, is attached to a Page. */
async function fetchLinkedInstagram({ pageId, pageToken }) {
  try {
    const fields = "instagram_business_account{id,username,name,profile_picture_url}";
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=${encodeURIComponent(
        fields,
      )}&access_token=${encodeURIComponent(pageToken)}`,
    );
    const data = await res.json();

    if (data?.error) {
      return { account: null, error: data.error.message || "Graph error" };
    }

    return { account: data?.instagram_business_account || null, error: null };
  } catch (err) {
    return { account: null, error: err.message };
  }
}

/** Does this owner's plan include the Instagram inbox? Mirrors insta.js. */
async function planAllowsInstagram(uid) {
  try {
    const [user] = await query(`SELECT plan FROM user WHERE uid = ? LIMIT 1`, [
      uid,
    ]);
    if (!user?.plan) return false;
    return parseInt(JSON.parse(user.plan)?.instagram_inbox, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Link the Instagram account behind one Facebook Page.
 *
 * @returns {Promise<{status:string, username?:string, detail?:string}>}
 *   status: "linked" | "no_instagram" | "plan" | "error"
 */
async function linkInstagramForPage({ uid, page, pageToken }) {
  try {
    const { account, error } = await fetchLinkedInstagram({
      pageId: page.id,
      pageToken,
    });

    if (error) return { status: "error", detail: error };
    if (!account?.id) return { status: "no_instagram" };

    if (!(await planAllowsInstagram(uid))) return { status: "plan" };

    const igId = String(account.id);

    // Same rule as the stock flow: an Instagram account belongs to one owner.
    await query(`DELETE FROM instagram_accounts WHERE webhook_id = ?`, [igId]);

    await query(
      `INSERT INTO instagram_accounts
        (uid, webhook_id, ig_graph_id, user_id, page_id,
         username, name, profile_pic, access_token,
         token_type, expires_in, connected_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uid,
        igId,
        igId,
        igId,
        String(page.id),
        account.username || "",
        account.name || account.username || "",
        account.profile_picture_url || "",
        pageToken,
        PAGE_TOKEN_TYPE,
        null, // Page tokens from a long-lived user token do not expire
        new Date(),
      ],
    );

    logger.log(
      `[instaViaFacebook] linked @${account.username} (${igId}) through page ${page.name}`,
    );

    return { status: "linked", username: account.username || igId };
  } catch (err) {
    logger.log("[instaViaFacebook] failed for page " + page?.id + ": " + err.message);
    return { status: "error", detail: err.message };
  }
}

/** Link every page's Instagram account. Returns a per-status tally. */
async function linkInstagramForPages({ uid, pages }) {
  const summary = { linked: [], no_instagram: 0, plan: 0, errors: [] };

  for (const page of pages) {
    const r = await linkInstagramForPage({
      uid,
      page,
      pageToken: page.access_token,
    });

    if (r.status === "linked") summary.linked.push(r.username);
    else if (r.status === "no_instagram") summary.no_instagram++;
    else if (r.status === "plan") summary.plan++;
    else summary.errors.push(`${page.name}: ${r.detail}`);
  }

  return summary;
}

module.exports = {
  GRAPH_VERSION,
  PAGE_TOKEN_TYPE,
  isPageLinked,
  messagesUrl,
  fetchLinkedInstagram,
  linkInstagramForPage,
  linkInstagramForPages,
};

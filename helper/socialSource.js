/**
 * Ad / post attribution for Instagram and Facebook Messenger.
 *
 * adSource.js already handles WhatsApp. This does the same job for the two
 * Meta social inboxes, so an agent can see *what the customer was looking at*
 * before they wrote:
 *
 *   Direct messages   Meta attaches a `referral` object when someone opens the
 *                     chat from a Click-to-Message ad:
 *                       { source: "ADS", type: "OPEN_THREAD", ad_id, ref,
 *                         ads_context_data: { ad_title, photo_url, video_url,
 *                                             post_id } }
 *                     It can arrive on the event itself, inside a postback, or
 *                     on the message, so all three are checked. When it arrives
 *                     as its own event (no message yet) it is held for the
 *                     customer's next message.
 *
 *   Instagram         A comment webhook only carries the media id, not what the
 *   comments          media is. The post is looked up (caption, link, picture)
 *                     so the agent sees what was commented on.
 *
 * The result is shown in the conversation itself — the post's picture with its
 * caption and link as a message just above the customer's (or, when there is
 * no picture, a one-line note on top of their message) — because the inbox is a compiled bundle with no
 * source to extend. The same facts are also written to chat_ad_source, so they
 * appear on /ad-sources.html next to the WhatsApp ads.
 *
 * Nothing here may break message delivery: every failure is swallowed and
 * logged, and the message is saved exactly as before.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const adSource = require("./adSource"); // eslint-disable-line no-unused-vars
const { query } = require("../database/dbpromise");
const logger = require("../utils/logger");

const GRAPH_VERSION = "v24.0";
const LEGACY_IG_VERSION = "v21.0";

const PENDING_TTL_MS = 30 * 60 * 1000;
const POST_TTL_MS = 6 * 60 * 60 * 1000;
const POST_MISS_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

function str(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

/** One-line, single-spaced preview of a caption. */
function snippet(text, max) {
  var s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/* ------------------------------------------------------------------ *
 * Direct messages: the referral object
 * ------------------------------------------------------------------ */

/** Where a referral can live on a Messenger / Instagram webhook event. */
function findReferral(event) {
  return (
    event?.referral ||
    event?.postback?.referral ||
    event?.message?.referral ||
    null
  );
}

/**
 * Normalise a Meta messaging referral into the shape adSource.record() takes.
 * Returns null unless it is actually from an ad: a plain m.me / ig.me link
 * also produces a referral, and calling that an "ad" would be wrong.
 *
 * @param {object} ref     the referral object
 * @param {string} origin  "instagram" | "messenger"
 */
function fromMessagingReferral(ref, origin) {
  try {
    if (!ref || typeof ref !== "object") return null;

    const ctx = ref.ads_context_data || {};
    const adId = ref.ad_id || ctx.ad_id || null;
    const isAd =
      String(ref.source || "").toUpperCase() === "ADS" ||
      !!adId ||
      !!ctx.ad_title;

    if (!isAd) return null;

    return {
      // The ad id is what an advertiser recognises; fall back to the post
      // the ad promotes when Meta does not send one.
      source_id: str(adId, 191) || str(ctx.post_id, 191),
      // Link to the promoted post when Meta gives its id (Facebook ids work
      // as facebook.com/<id>; an Instagram media id does not).
      source_url:
        str(ref.referer_uri) ||
        (origin === "messenger" && ctx.post_id
          ? "https://www.facebook.com/" + ctx.post_id
          : null),
      source_type: "ad",
      ad_title: str(ctx.ad_title, 500),
      ad_body: ref.ref ? "ref: " + str(ref.ref, 200) : null,
      ctwa_clid: null,
      thumbnail_url: str(ctx.photo_url || ctx.video_url),
      origin: origin,
    };
  } catch (err) {
    logger.log("[socialSource] fromMessagingReferral failed: " + err.message);
    return null;
  }
}

/**
 * [CUSTOM] Write the chat_ad_source row for a Messenger / Instagram source.
 * Same table and dedupe as adSource.record(), but WITHOUT adSource's
 * saveAdCard(): that card is built for WhatsApp (it hot-links Meta's picture,
 * uses the current time and tags the row "qr"), and this module already shows
 * its own card. Calling adSource.record() here put a second, broken card
 * under every Messenger ad message.
 */
async function recordSource({ uid, chatId, senderMobile, senderName, referral }) {
  if (!uid || !chatId || !referral) return false;
  try {
    const [seen] = await query(
      `SELECT id FROM chat_ad_source
        WHERE uid = ? AND chat_id = ? AND (source_id <=> ?)
        LIMIT 1`,
      [uid, chatId, referral.source_id],
    );
    if (seen) return false;

    await query(
      `INSERT INTO chat_ad_source
        (uid, chat_id, sender_mobile, sender_name, source_id, source_url,
         source_type, ad_title, ad_body, ctwa_clid, thumbnail_url, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uid,
        chatId,
        str(senderMobile, 64),
        str(senderName, 191),
        referral.source_id,
        referral.source_url,
        referral.source_type,
        referral.ad_title,
        referral.ad_body,
        referral.ctwa_clid,
        referral.thumbnail_url,
        referral.origin,
      ],
    );
    return true;
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") return false;
    logger.log("[socialSource] recordSource failed: " + err.message);
    return false;
  }
}

/**
 * [CUSTOM] The note as plain text inside a customer's text message. The
 * inbox turns any 8+ digit run into a tel: link, and inside a URL that
 * broke the HTML ('" target="_blank" ...' showed in the bubble). So: no URL
 * here (the picture card keeps it), and long digit runs get an invisible
 * word joiner every 4 digits so they are not mistaken for phone numbers.
 */
function inboxNote(info) {
  if (!info?.note) return null;
  return info.note.replace(/\d{7,}/g, (d) => d.replace(/(\d{4})(?=\d)/g, "$1\u2060"));
}

/** The line an agent reads. */
function adNote(referral) {
  const title = referral.ad_title || "(untitled ad)";
  const id = referral.source_id ? " · ID " + referral.source_id : "";
  return "📢 From ad: " + title + id;
}

// Referral that arrived as its own event, waiting for the customer's message.
const pending = new Map(); // `${uid}:${chatId}` -> { referral, at }

function pendingKey(uid, chatId) {
  return uid + ":" + chatId;
}

function sweepPending() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  }
}

/**
 * A referral event with no message attached. Remember it for the next message
 * and record it straight away — the customer clearly came from the ad even if
 * they have not typed anything yet.
 */
async function rememberReferralEvent({ event, uid, chatPrefix, origin }) {
  try {
    const senderId = event?.sender?.id;
    if (!senderId || !uid) return false;

    const referral = fromMessagingReferral(findReferral(event), origin);
    if (!referral) return false;

    const chatId = chatPrefix + senderId;

    sweepPending();
    pending.set(pendingKey(uid, chatId), { referral, at: Date.now() });

    await recordSource({
      uid,
      chatId,
      senderMobile: String(senderId),
      senderName: null,
      referral,
    });
    return true;
  } catch (err) {
    logger.log("[socialSource] rememberReferralEvent failed: " + err.message);
    return false;
  }
}

/**
 * An incoming message: find its ad (on the event, or held from an earlier
 * referral event), record it, and hand back the note to show.
 *
 * @returns {Promise<{note,picture,link}|null>} null when not from an ad
 */
async function captureDm({ event, uid, chatId, senderMobile, senderName, origin }) {
  try {
    if (!uid || !chatId) return null;

    const key = pendingKey(uid, chatId);
    const direct = fromMessagingReferral(findReferral(event), origin);
    const held = pending.get(key);
    const referral = direct || (held ? held.referral : null);

    pending.delete(key);
    if (!referral) return null;

    await recordSource({
      uid,
      chatId,
      senderMobile: senderMobile ? String(senderMobile) : null,
      senderName,
      referral,
    });

    return {
      note: adNote(referral),
      picture: referral.thumbnail_url,
      link: referral.source_url,
    };
  } catch (err) {
    logger.log("[socialSource] captureDm failed: " + err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Instagram comments: look up the post
 * ------------------------------------------------------------------ */

const postCache = new Map(); // `${uid}:${mediaId}` -> { post, at }

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What an Instagram media id actually is. Cached, and a failed lookup is
 * cached briefly too so one bad token cannot turn every comment into a call.
 *
 * @returns {Promise<{id,caption,permalink,thumbnail,type}|null>}
 */
async function describeInstagramPost({ igAccount, uid, mediaId }) {
  try {
    if (!mediaId || !igAccount?.access_token) return null;

    const key = uid + ":" + mediaId;
    const hit = postCache.get(key);
    if (hit && Date.now() - hit.at < (hit.post ? POST_TTL_MS : POST_MISS_TTL_MS)) {
      return hit.post;
    }

    const pageLinked =
      String(igAccount.token_type || "").toLowerCase() === "page";
    const base = pageLinked
      ? "https://graph.facebook.com/" + GRAPH_VERSION
      : "https://graph.instagram.com/" + LEGACY_IG_VERSION;

    const fields = "caption,permalink,media_type,media_product_type,thumbnail_url,media_url";
    const data = await getJson(
      base +
        "/" +
        encodeURIComponent(mediaId) +
        "?fields=" +
        fields +
        "&access_token=" +
        encodeURIComponent(igAccount.access_token),
    );

    let post = null;
    if (data && !data.error) {
      post = {
        id: String(mediaId),
        caption: str(data.caption),
        permalink: str(data.permalink),
        thumbnail: str(data.thumbnail_url || data.media_url),
        type: str(data.media_product_type || data.media_type, 64),
      };
    } else if (data?.error) {
      logger.log(
        "[socialSource] media lookup failed: " + (data.error.message || "error"),
      );
    }

    postCache.set(key, { post, at: Date.now() });
    return post;
  } catch (err) {
    logger.log("[socialSource] describeInstagramPost failed: " + err.message);
    return null;
  }
}

/** The line an agent reads for a comment. */
function postNote(post, fallbackMediaId) {
  if (!post) {
    return fallbackMediaId ? "📌 Comment on post " + fallbackMediaId : null;
  }
  const what = post.caption ? "«" + snippet(post.caption, 80) + "»" : "post " + post.id;
  return "📌 Comment on " + what + (post.permalink ? "\n🔗 " + post.permalink : "");
}

/** Record which post a commenter wrote on (once per commenter per post). */
async function recordPost({ uid, chatId, commenterId, commenterName, post, mediaId }) {
  try {
    if (!uid || !chatId || !mediaId) return false;

    return await recordSource({
      uid,
      chatId,
      senderMobile: commenterId ? String(commenterId) : null,
      senderName: commenterName,
      referral: {
        source_id: String(mediaId),
        source_url: post?.permalink || null,
        source_type: "post",
        ad_title: post?.caption ? snippet(post.caption, 120) : null,
        ad_body: post?.caption || null,
        ctwa_clid: null,
        thumbnail_url: post?.thumbnail || null,
        origin: "ig_comment",
      },
    });
  } catch (err) {
    logger.log("[socialSource] recordPost failed: " + err.message);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * The picture
 * ------------------------------------------------------------------ */

function mediaDir() {
  return process.env.SOCIAL_MEDIA_DIR || path.resolve(__dirname, "../client/public/meta-media");
}
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/**
 * Copy a picture onto our own server. Meta's image links are signed and stop
 * working after a while, so showing them directly would leave a broken image
 * in old conversations.
 *
 * @returns {Promise<string|null>} public URL on this server, or null
 */
async function savePicture(url) {
  try {
    if (!url || !/^https?:\/\//i.test(url)) return null;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    let res;
    try {
      res = await fetch(url, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    const type = String(res.headers.get("content-type") || "").toLowerCase();
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[type.split(";")[0].trim()];
    if (!ext) return null; // not a picture (an expired link returns HTML)

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_PICTURE_BYTES) return null;

    const name = crypto.randomBytes(8).toString("hex") + "_src." + ext;
    await fs.promises.mkdir(mediaDir(), { recursive: true });
    await fs.promises.writeFile(path.join(mediaDir(), name), buf);

    const base = String(process.env.FRONTENDURI || "").replace(/\/+$/, "");
    return base + "/meta-media/" + name;
  } catch (err) {
    logger.log("[socialSource] savePicture failed: " + err.message);
    return null;
  }
}

/** Text version of an ad/post: the note plus its link, when it has one. */
function fullNote(info) {
  if (!info?.note) return null;
  return info.note + (info.link && info.note.indexOf(info.link) === -1 ? "\n🔗 " + info.link : "");
}

/**
 * The post / ad as a message of its own: its picture with the caption and link
 * underneath, placed in the thread just before the customer's message.
 * Returns null when there is no usable picture — the caller then falls back to
 * the text note.
 *
 * @param {{note:string,picture?:string,link?:string}} info
 * @param {{timestamp,senderName,senderMobile,origin}} base  the customer's message
 */
async function makeCard(info, base) {
  try {
    if (!info?.note || !info.picture) return null;

    const hosted = await savePicture(info.picture);
    if (!hosted) return null;

    const caption =
      info.note +
      (info.link && info.note.indexOf(info.link) === -1
        ? "\n🔗 " + info.link
        : "");

    return {
      type: "image",
      metaChatId: "srccard_" + crypto.randomBytes(6).toString("hex"),
      msgContext: { type: "image", image: { link: hosted, caption } },
      reaction: "",
      // One second before the customer's message: the inbox sorts by
      // timestamp, and with a tie it showed the card *below* the message.
      timestamp: Number.isFinite(Number(base.timestamp))
        ? Number(base.timestamp) - 1
        : base.timestamp,
      senderName: base.senderName,
      senderMobile: base.senderMobile,
      status: "",
      star: false,
      route: "INCOMING",
      context: null,
      origin: base.origin,
    };
  } catch (err) {
    logger.log("[socialSource] makeCard failed: " + err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Showing it
 * ------------------------------------------------------------------ */

/**
 * Put a note above a customer's message. Text gets it in front of the body;
 * image / video / document get it in the caption. Anything else (audio) is
 * returned unchanged — the record in chat_ad_source is still made.
 */
function decorate(msgContext, note) {
  try {
    if (!msgContext || !note) return msgContext;

    const copy = JSON.parse(JSON.stringify(msgContext));

    if (copy.type === "text" && copy.text) {
      copy.text.body = note + "\n\n" + (copy.text.body || "");
      return copy;
    }

    for (const t of ["image", "video", "document"]) {
      if (copy.type === t && copy[t]) {
        copy[t].caption = note + (copy[t].caption ? "\n\n" + copy[t].caption : "");
        return copy;
      }
    }
  } catch (err) {
    logger.log("[socialSource] decorate failed: " + err.message);
  }
  return msgContext;
}

module.exports = {
  findReferral,
  fromMessagingReferral,
  adNote,
  rememberReferralEvent,
  captureDm,
  describeInstagramPost,
  postNote,
  recordPost,
  decorate,
  savePicture,
  makeCard,
  fullNote,
  inboxNote,
  recordSource,
  _internals: { pending, postCache },
};

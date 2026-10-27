/**
 * Instagram / Messenger ad + post attribution.
 *
 * Needs no database and no network: the DB layer and fetch() are replaced with
 * in-memory fakes, so this can run anywhere.
 *
 *   cd <app dir> && node social-test.js
 */
const path = require("path");
const os = require("os");
const fsx = require("fs");
const APP = process.cwd();
process.env.SOCIAL_MEDIA_DIR = fsx.mkdtempSync(path.join(os.tmpdir(), "social-media-"));
process.env.FRONTENDURI = "https://panel.example.com";

let pass = 0,
  fail = 0;
function check(label, cond, extra) {
  cond ? pass++ : fail++;
  console.log(
    `  ${cond ? "PASS" : "FAIL"}  ${label}${cond || !extra ? "" : "  -> " + extra}`,
  );
}

// --- fakes -----------------------------------------------------------------

const db = { adRows: [], conversation: [], chats: [], calls: [] };

const ACCOUNT = {
  uid: "OWNER1",
  page_id: "PAGE1",
  page_name: "My Page",
  page_access_token: "PAGE_TOKEN",
};
const IG_ACCOUNT = {
  uid: "OWNER1",
  user_id: "IGBIZ1",
  webhook_id: "IGBIZ1",
  username: "shop",
  name: "Shop",
  access_token: "IG_TOKEN",
  token_type: "page",
};

async function fakeQuery(sql, params) {
  db.calls.push(sql);
  const s = sql.replace(/\s+/g, " ").trim();

  if (/FROM chat_ad_source/i.test(s) && /^SELECT/i.test(s)) {
    const [uid, chatId, sourceId] = params;
    const hit = db.adRows.find(
      (r) =>
        r.uid === uid &&
        r.chat_id === chatId &&
        (r.source_id ?? null) === (sourceId ?? null),
    );
    return hit ? [hit] : [];
  }
  if (/^INSERT INTO chat_ad_source/i.test(s)) {
    const [uid, chat_id, sender_mobile, sender_name, source_id, source_url, source_type, ad_title, ad_body, ctwa_clid, thumbnail_url, origin] = params;
    db.adRows.push({ uid, chat_id, sender_mobile, sender_name, source_id, source_url, source_type, ad_title, ad_body, ctwa_clid, thumbnail_url, origin });
    return { insertId: db.adRows.length };
  }
  if (/FROM messenger_accounts/i.test(s)) return [ACCOUNT];
  if (/FROM instagram_accounts/i.test(s)) return [IG_ACCOUNT];
  if (/^INSERT INTO beta_conversation/i.test(s)) {
    db.conversation.push(params);
    return { insertId: 1 };
  }
  if (/^INSERT INTO beta_chats/i.test(s)) {
    db.chats.push(params);
    return { insertId: 1 };
  }
  return [];
}

function stub(rel, exports) {
  const p = require.resolve(path.join(APP, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("database/dbpromise", { query: fakeQuery });
stub("utils/logger", { log() {}, error() {} });
stub("functions/function", { getCurrentTimestampInTimeZone: () => 1700000000 });

let fetchLog = [];
let fetchReply = {};
let pictureOk = true; // false -> the picture link has expired (Meta returns HTML)
global.fetch = async (url) => {
  fetchLog.push(String(url));
  if (String(url).includes("cdn.example/")) {
    return {
      ok: pictureOk,
      headers: { get: () => (pictureOk ? "image/jpeg" : "text/html") },
      arrayBuffer: async () => Buffer.from("JPEGDATA"),
    };
  }
  return { json: async () => fetchReply };
};

const social = require(path.join(APP, "helper/socialSource"));
const { processMessengerMessage } = require(path.join(APP, "helper/inbox/messenger/index.js"));
const { processInstaMessage } = require(path.join(APP, "helper/addon/insta/processInstagram.js"));

// --- payloads (Meta's documented shapes) -----------------------------------

const adReferral = {
  source: "ADS",
  type: "OPEN_THREAD",
  ad_id: "23850001112223",
  ref: "winter",
  ads_context_data: {
    ad_title: "عروض الشتاء",
    photo_url: "https://cdn.example/ad.jpg",
    post_id: "999_888",
  },
};
const adReferralNoPic = { ...adReferral, ads_context_data: { ad_title: "Text only ad", post_id: "777_666" } };
const linkReferral = { source: "SHORTLINK", type: "OPEN_THREAD", ref: "bio-link" };

function lastText(rows, i) {
  const ctx = JSON.parse(rows[i || rows.length - 1].msgContext);
  return ctx.text?.body ?? ctx[ctx.type]?.caption ?? "";
}

function msngBody(event) {
  return { object: "page", entry: [{ id: "PAGE1", messaging: [event] }] };
}
const msngMsg = (mid, text, extra) => ({
  sender: { id: "USER1" },
  recipient: { id: "PAGE1" },
  timestamp: 1700000000000,
  message: { mid, text, ...(extra || {}) },
});

(async () => {
  console.log("referral extraction");
  check("finds referral on the event", social.findReferral({ referral: adReferral }) === adReferral);
  check("finds referral in a postback", social.findReferral({ postback: { referral: adReferral } }) === adReferral);
  check("finds referral on the message", social.findReferral({ message: { referral: adReferral } }) === adReferral);
  check("no referral -> null", social.findReferral({ message: { text: "hi" } }) === null);

  const norm = social.fromMessagingReferral(adReferral, "messenger");
  check("ad is normalised", norm && norm.source_id === "23850001112223" && norm.ad_title === "عروض الشتاء" && norm.origin === "messenger", JSON.stringify(norm));
  check("thumbnail kept", norm.thumbnail_url === "https://cdn.example/ad.jpg");
  check("falls back to post id when no ad id", social.fromMessagingReferral({ source: "ADS", ads_context_data: { post_id: "P1" } }, "instagram").source_id === "P1");
  check("a plain m.me link is NOT an ad", social.fromMessagingReferral(linkReferral, "messenger") === null);
  check("garbage input -> null", social.fromMessagingReferral("x", "messenger") === null && social.fromMessagingReferral(null, "messenger") === null);

  console.log("note / decorate");
  check("note shows title and id", social.adNote(norm) === "📢 From ad: عروض الشتاء · ID 23850001112223");
  const orig = { type: "text", text: { body: "hello", preview_url: true } };
  const dec = social.decorate(orig, "NOTE");
  check("text gets the note in front", dec.text.body === "NOTE\n\nhello");
  check("original not mutated", orig.text.body === "hello");
  check("image caption decorated", social.decorate({ type: "image", image: { link: "x", caption: "" } }, "NOTE").image.caption === "NOTE");
  const aud = { type: "audio", audio: { link: "x" } };
  check("audio returned unchanged", social.decorate(aud, "NOTE") === aud);
  check("no note -> unchanged", social.decorate(orig, null) === orig);

  console.log("Messenger: message that carries the referral");
  const r1 = await processMessengerMessage({ body: msngBody(msngMsg("m1", "السعر كام؟", { referral: adReferral })), uid: "OWNER1" });
  check("message processed", !!r1);
  check("two rows saved: the ad, then the message", db.conversation.length === 2, String(db.conversation.length));
  const card1 = JSON.parse(db.conversation[0].msgContext);
  check("first row is the ad's picture", db.conversation[0].type === "image" && /^https:\/\/panel\.example\.com\/meta-media\/[0-9a-f]+_src\.jpg$/.test(card1.image.link), card1.image && card1.image.link);
  check("picture is copied to our server, not hot-linked", fsx.readdirSync(process.env.SOCIAL_MEDIA_DIR).length === 1);
  check("caption has title, ad id and post link", card1.image.caption === "📢 From ad: عروض الشتاء · ID 23850001112223\n🔗 https://www.facebook.com/999_888", card1.image.caption);
  check("card is from the customer (INCOMING)", db.conversation[0].route === "INCOMING");
  check("card is timestamped before the message so it sorts above it", Number(db.conversation[0].timestamp) < Number(db.conversation[1].timestamp), db.conversation[0].timestamp + " vs " + db.conversation[1].timestamp);
  check("second row is the customer's own words, untouched", lastText(db.conversation) === "السعر كام؟", lastText(db.conversation));
  check("recorded in chat_ad_source", db.adRows.length === 1 && db.adRows[0].origin === "messenger" && db.adRows[0].chat_id === "msng_USER1" && db.adRows[0].source_id === "23850001112223");
  check("chat list preview is the plain text", JSON.parse(db.chats[0][2]).msgContext.text.body === "السعر كام؟", db.chats[0][2]);

  console.log("Messenger: no usable picture -> note on the message instead");
  db.conversation.length = 0;
  await processMessengerMessage({ body: msngBody({ ...msngMsg("m1b", "hello", { referral: adReferralNoPic }), sender: { id: "USERNP" } }), uid: "OWNER1" });
  check("one row, note + link on top", db.conversation.length === 1 && lastText(db.conversation) === "📢 From ad: Text only ad · ID 2385\u20600001\u20601122\u206023\n\nhello", lastText(db.conversation));
  db.conversation.length = 0;
  pictureOk = false;
  await processMessengerMessage({ body: msngBody({ ...msngMsg("m1c", "hello2", { referral: adReferral }), sender: { id: "USEREXP" } }), uid: "OWNER1" });
  pictureOk = true;
  check("expired picture link -> falls back to the note", db.conversation.length === 1 && /^📢 From ad: عروض الشتاء/.test(lastText(db.conversation)) && /hello2$/.test(lastText(db.conversation)), lastText(db.conversation));

  console.log("Messenger: referral arrives as its own event, then the message");
  db.conversation.length = 0;
  await processMessengerMessage({
    body: msngBody({ sender: { id: "USER2" }, recipient: { id: "PAGE1" }, timestamp: 1700000000000, referral: adReferral }),
    uid: "OWNER1",
  });
  check("referral-only event recorded", db.adRows.some((r) => r.chat_id === "msng_USER2"));
  check("referral-only event saves no fake message", db.conversation.length === 0);
  db.conversation.length = 0;
  await processMessengerMessage({
    body: msngBody({ sender: { id: "USER2" }, recipient: { id: "PAGE1" }, timestamp: 1700000001000, message: { mid: "m2", text: "hi" } }),
    uid: "OWNER1",
  });
  check("held referral shown on the next message (picture, then message)", db.conversation.length === 2 && db.conversation[0].type === "image" && lastText(db.conversation) === "hi", lastText(db.conversation));
  db.conversation.length = 0;
  await processMessengerMessage({
    body: msngBody({ sender: { id: "USER2" }, recipient: { id: "PAGE1" }, timestamp: 1700000002000, message: { mid: "m3", text: "second" } }),
    uid: "OWNER1",
  });
  check("only the first message carries it", db.conversation.length === 1 && lastText(db.conversation) === "second", lastText(db.conversation));

  console.log("Messenger: things that must NOT change");
  const before = db.adRows.length;
  db.conversation.length = 0;
  await processMessengerMessage({ body: msngBody(msngMsg("m4", "plain", {})), uid: "OWNER1" });
  check("organic message untouched, no extra row", lastText(db.conversation) === "plain" && db.conversation.length === 1);
  await processMessengerMessage({ body: msngBody(msngMsg("m5", "via link", { referral: linkReferral })), uid: "OWNER1" });
  check("m.me link referral not labelled as an ad", lastText(db.conversation) === "via link" && db.conversation.length === 2);
  await processMessengerMessage({
    body: msngBody({ sender: { id: "PAGE1" }, recipient: { id: "USER1" }, timestamp: 1700000003000, message: { mid: "m6", text: "our reply", referral: adReferral } }),
    uid: "OWNER1",
  });
  check("our own outgoing message never gets a note", lastText(db.conversation) === "our reply" && db.conversation.length === 3);
  check("none of those recorded an ad", db.adRows.length === before);

  console.log("Messenger: same customer, same ad twice");
  const rows0 = db.adRows.length;
  await processMessengerMessage({ body: msngBody(msngMsg("m7", "again", { referral: adReferral })), uid: "OWNER1" });
  check("ad shown again", db.conversation.some((r) => r.type === "image"));
  check("but counted once (people, not messages)", db.adRows.length === rows0);

  console.log("Instagram DM");
  db.conversation.length = 0;
  const igEvent = (mid, text, extra, sender) => ({
    object: "instagram",
    entry: [{ id: "IGBIZ1", messaging: [{ sender: { id: sender || "IGUSER1" }, recipient: { id: "IGBIZ1" }, timestamp: 1700000000000, message: { mid, text, ...(extra || {}) } }] }],
  });
  await processInstaMessage({ body: igEvent("i1", "بكام؟", { referral: adReferral }), uid: "OWNER1" });
  check("IG: ad picture, then the message", db.conversation.length === 2 && db.conversation[0].type === "image" && /From ad: عروض الشتاء/.test(JSON.parse(db.conversation[0].msgContext).image.caption) && lastText(db.conversation) === "بكام؟", lastText(db.conversation));
  check("IG: recorded with origin instagram", db.adRows.some((r) => r.origin === "instagram" && r.chat_id === "ig_IGUSER1"));
  db.conversation.length = 0;
  await processInstaMessage({ body: igEvent("i2", "organic", {}, "IGUSER9"), uid: "OWNER1" });
  check("IG: organic message untouched", lastText(db.conversation) === "organic" && db.conversation.length === 1);

  console.log("Instagram comments: post lookup");
  fetchLog = [];
  fetchReply = { caption: "عرض الجمعة البيضاء\nخصم ٥٠٪", permalink: "https://www.instagram.com/p/ABC/", media_type: "IMAGE", media_url: "https://cdn.example/p.jpg" };
  const post = await social.describeInstagramPost({ igAccount: IG_ACCOUNT, uid: "OWNER1", mediaId: "MEDIA1" });
  check("post resolved", post && post.permalink === "https://www.instagram.com/p/ABC/" && post.caption.startsWith("عرض"), JSON.stringify(post));
  check("page-linked account uses graph.facebook.com v24 with its token", fetchLog[0].startsWith("https://graph.facebook.com/v24.0/MEDIA1?") && fetchLog[0].includes("access_token=IG_TOKEN"), fetchLog[0]);
  await social.describeInstagramPost({ igAccount: IG_ACCOUNT, uid: "OWNER1", mediaId: "MEDIA1" });
  check("second comment on the same post is served from cache", fetchLog.length === 1);
  await social.describeInstagramPost({ igAccount: { ...IG_ACCOUNT, token_type: "bearer" }, uid: "OWNER1", mediaId: "MEDIA2" });
  check("Instagram-Login account uses graph.instagram.com", fetchLog[1].startsWith("https://graph.instagram.com/v21.0/MEDIA2?"), fetchLog[1]);

  fetchReply = { error: { message: "Invalid OAuth access token" } };
  const bad = await social.describeInstagramPost({ igAccount: IG_ACCOUNT, uid: "OWNER1", mediaId: "MEDIA3" });
  check("Graph error -> null, no throw", bad === null);
  const n = fetchLog.length;
  await social.describeInstagramPost({ igAccount: IG_ACCOUNT, uid: "OWNER1", mediaId: "MEDIA3" });
  check("failed lookup is not retried on every comment", fetchLog.length === n);

  global.fetch = async () => { throw new Error("network down"); };
  const down = await social.describeInstagramPost({ igAccount: IG_ACCOUNT, uid: "OWNER1", mediaId: "MEDIA4" });
  check("network failure -> null, no throw", down === null);

  console.log("Instagram comments: picture card");
  global.fetch = async (url) => { fetchLog.push(String(url)); if (String(url).includes("cdn.example/")) return { ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => Buffer.from("X") }; return { json: async () => fetchReply }; };
  const note0 = social.postNote(post, "MEDIA1");
  const card = await social.makeCard({ note: note0, picture: "https://cdn.example/p.jpg", link: post.permalink }, { timestamp: 5, senderName: "sara", senderMobile: "U1", origin: "instagram_comment" });
  check("comment card is an image from the commenter", card && card.type === "image" && card.route === "INCOMING" && card.origin === "instagram_comment");
  check("card sorts one second BEFORE the customer message", card.timestamp === 4, String(card.timestamp));
  check("caption has the post text and its link once", (card.msgContext.image.caption.match(/instagram\.com\/p\/ABC/g) || []).length === 1, card.msgContext.image.caption);
  check("no picture -> no card (caller falls back to the note)", (await social.makeCard({ note: note0 }, {})) === null);
  check("non-image / bad URL -> no card", (await social.makeCard({ note: note0, picture: "javascript:alert(1)" }, {})) === null);

  console.log("Instagram comments: note + record");
  check("note shows caption snippet and link", social.postNote(post, "MEDIA1") === "📌 Comment on «عرض الجمعة البيضاء خصم ٥٠٪»\n🔗 https://www.instagram.com/p/ABC/", social.postNote(post, "MEDIA1"));
  check("note still useful when the lookup failed", social.postNote(null, "MEDIA9") === "📌 Comment on post MEDIA9");
  check("long caption is shortened", social.postNote({ id: "1", caption: "x".repeat(300) }).length < 130);
  const rows1 = db.adRows.length;
  await social.recordPost({ uid: "OWNER1", chatId: "C1", commenterId: "U1", commenterName: "sara", post, mediaId: "MEDIA1" });
  const rec = db.adRows[db.adRows.length - 1];
  check("post recorded as ig_comment / post", rec.origin === "ig_comment" && rec.source_type === "post" && rec.source_id === "MEDIA1" && rec.source_url === post.permalink, JSON.stringify(rec));
  await social.recordPost({ uid: "OWNER1", chatId: "C1", commenterId: "U1", commenterName: "sara", post, mediaId: "MEDIA1" });
  check("same commenter on same post counted once", db.adRows.length === rows1 + 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(2);
});

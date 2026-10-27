const { query } = require("../../../database/dbpromise");
const fetch = require("node-fetch");

const API_VERSION = "v21.0";

function checkInsta() {
  return true;
}

async function genInstaWebhook() {
  try {
    const [admin] = await query(`SELECT * FROM admin LIMIT 1`, []);
    const webhook = `${process.env.BACKURI}/api/insta/webhook/${admin?.uid}`;
    return webhook;
  } catch (err) {
    return null;
  }
}

// ─── Add this function to your existing insta.js ──────────
async function subscribeInstaWebhook(accessToken) {
  const SUBSCRIBED_FIELDS = [
    "messages",
    "messaging_seen",
    "comments",
    "messaging_postbacks",
    "messaging_optins",
    "messaging_referral",
    "message_reactions",
  ].join(",");

  try {
    const res = await fetch(
      `https://graph.instagram.com/${API_VERSION}/me/subscribed_apps`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          subscribed_fields: SUBSCRIBED_FIELDS,
          access_token: accessToken,
        }),
      },
    );
    const data = await res.json();
    return data;
  } catch (err) {
    console.error("[Instagram] subscribeInstaWebhook error:", err.message);
    return null;
  }
}

async function getInstaCallbackUri() {
  try {
    const callBackUri = `${process.env.BACKURI}/api/insta/callback`;
    return callBackUri;
  } catch (err) {
    return null;
  }
}

async function exchangeShortToken({ appId, appSecret, redirectUri, code }) {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  return res.json();
}

async function exchangeLongToken({ appSecret, shortToken }) {
  const res = await fetch(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${appSecret}&access_token=${shortToken}`,
  );
  return res.json();
}

async function fetchInstaProfile(token) {
  const res = await fetch(
    `https://graph.instagram.com/${API_VERSION}/me?fields=id,user_id,name,username,profile_picture_url&access_token=${token}`,
  );
  return res.json();
}

module.exports = {
  checkInsta,
  genInstaWebhook,
  exchangeShortToken,
  exchangeLongToken,
  fetchInstaProfile,
  API_VERSION,
  getInstaCallbackUri,
  subscribeInstaWebhook,
};

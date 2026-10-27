const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const validateUser = require("../middlewares/user.js");
const adminValidator = require("../middlewares/admin.js");
const { checkPlan } = require("../middlewares/plan.js");
const logger = require("../utils/logger.js");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { processMessage } = require("../helper/inbox/inbox.js");
const { processAutomation } = require("../automation/automation.js");
// [CUSTOM] connect the Instagram account behind each Facebook Page
const { linkInstagramForPages } = require("../helper/instaViaFacebook.js");

const API_VERSION = "v21.0";

// ─── Admin: get messenger config ──────────────────────────────
router.get("/config", adminValidator, async (req, res) => {
  try {
    const [data] = await query(
      `SELECT messenger_app_id, messenger_app_secret FROM web_private`,
      [],
    );

    const [admin] = await query(`SELECT uid FROM admin`, []);

    // ✅ Now these are actually sent to the frontend
    const webhookUrl = `${process.env.BACKURI}/api/messenger/webhook/${admin?.uid}`;
    const webhookSecret = admin?.uid;

    res.json({
      success: true,
      data: data || {},
      webhookUrl, // ✅ added
      webhookSecret, // ✅ added
    });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ─── Admin: update messenger config ──────────────────────────
router.post("/config", adminValidator, async (req, res) => {
  try {
    const { messenger_app_id, messenger_app_secret } = req.body;
    if (!messenger_app_id || !messenger_app_secret) {
      return res.json({ success: false, msg: "Please provide all fields" });
    }
    await query(
      `UPDATE web_private SET messenger_app_id = ?, messenger_app_secret = ?`,
      [messenger_app_id, messenger_app_secret],
    );
    res.json({ success: true, msg: "Messenger config updated" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ─── User: get auth URL ───────────────────────────────────────
router.get("/auth-url", validateUser, async (req, res) => {
  try {
    const [pvt] = await query(`SELECT messenger_app_id FROM web_private`, []);
    if (!pvt?.messenger_app_id) {
      return res.json({
        success: false,
        msg: "Messenger not configured by admin",
      });
    }

    const callbackUri = `${process.env.BACKURI}/api/messenger/callback`;
    const scopes = "pages_messaging,pages_show_list,pages_read_engagement";

    const params = new URLSearchParams({
      client_id: pvt.messenger_app_id,
      redirect_uri: callbackUri,
      response_type: "code",
      state: req.decode.uid,
    });

    // [CUSTOM] Meta apps created with a "Business messaging" use case get
    // Facebook Login *for Business*, which rejects the classic scope-based
    // dialog with "Facebook Login is currently unavailable for this app".
    // That flow takes a Login Configuration instead of a scope list.
    //
    // Set MESSENGER_CONFIG_ID in .env to the configuration's ID
    // (App dashboard -> Facebook Login for Business -> Configurations).
    // Left unset, the original classic flow is used unchanged, so older
    // apps keep working.
    const configId = (process.env.MESSENGER_CONFIG_ID || "").trim();

    if (configId) {
      params.set("config_id", configId);
    } else {
      params.set("scope", scopes);
    }

    // [CUSTOM] The unversioned /dialog/oauth path resolves to an old API
    // version that predates Login Configurations: Facebook answered the
    // config_id request with is_business_login=0 and then refused it with
    // "Facebook Login is currently unavailable for this app". Pinning a
    // version makes it honour config_id. Only done for the business flow so
    // the classic path keeps behaving exactly as before.
    const base = configId
      ? "https://www.facebook.com/v24.0/dialog/oauth"
      : "https://www.facebook.com/dialog/oauth";

    const url = `${base}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ─── OAuth Callback ───────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, error, state: uid } = req.query;

  const pageStyle = `font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#0866ff,#1877f2);color:#fff;margin:0;padding:20px;box-sizing:border-box;text-align:center`;

  if (error || !code || !uid) {
    return res.send(`<html><body style="${pageStyle}">
      <h2>❌ Error: ${error || "Missing parameters"}</h2>
      <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>`);
  }

  try {
    const [pvt] = await query(
      `SELECT messenger_app_id, messenger_app_secret FROM web_private`,
      [],
    );

    if (!pvt?.messenger_app_id || !pvt?.messenger_app_secret) {
      throw new Error("Messenger credentials not configured");
    }

    const callbackUri = `${process.env.BACKURI}/api/messenger/callback`;

    // Exchange code for user access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/oauth/access_token?client_id=${pvt.messenger_app_id}&redirect_uri=${encodeURIComponent(callbackUri)}&client_secret=${pvt.messenger_app_secret}&code=${code}`,
    );
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      throw new Error("Token exchange failed: " + JSON.stringify(tokenData));
    }

    let userToken = tokenData.access_token;

    // [CUSTOM] Swap the freshly issued token for a long-lived one. Page tokens
    // derived from a short-lived user token expire within hours, which would
    // silently cut every connected page off shortly after linking; ones
    // derived from a long-lived token do not expire. Best effort: if Meta
    // refuses the exchange the original token is used as before.
    try {
      const longRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${pvt.messenger_app_id}&client_secret=${pvt.messenger_app_secret}&fb_exchange_token=${encodeURIComponent(userToken)}`,
      );
      const longData = await longRes.json();
      if (longData?.access_token) userToken = longData.access_token;
      else logger.log("[messenger] long-lived exchange skipped: " + JSON.stringify(longData?.error || longData));
    } catch (e) {
      logger.log("[messenger] long-lived exchange failed: " + e.message);
    }

    // Get pages
    // [CUSTOM] /me/accounts is paginated. The stock code read only the first
    // batch, so an account with more pages than one batch silently lost the
    // rest. Ask for a large batch and follow the paging cursors to the end.
    const allPages = [];
    let nextUrl = `https://graph.facebook.com/${API_VERSION}/me/accounts?fields=id,name,access_token&limit=100&access_token=${userToken}`;
    let pagesError = null;

    for (let i = 0; nextUrl && i < 20; i++) {
      const pagesRes = await fetch(nextUrl);
      const batch = await pagesRes.json();

      if (batch.error) {
        pagesError = batch.error;
        break;
      }

      allPages.push(...(batch.data || []));
      nextUrl = batch.paging?.next || null;
    }

    logger.log(
      `[messenger] /me/accounts returned ${allPages.length} page(s): ${allPages
        .map((p) => p.name)
        .join(", ")}`,
    );

    if (allPages.length === 0) {
      throw new Error(
        pagesError?.message || "No Facebook Pages found for this account",
      );
    }

    const pagesData = { data: allPages };

    // Save each page
    for (const page of pagesData.data) {
      const pageId = page.id;
      const pageToken = page.access_token;
      const pageName = page.name;

      // Subscribe page to webhooks
      await fetch(
        `https://graph.facebook.com/${API_VERSION}/${pageId}/subscribed_apps`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            // [CUSTOM] messaging_referrals: Meta sends the ad a customer came
            // from on this event. Without it Messenger ads cannot be attributed.
            subscribed_fields:
              "messages,messaging_postbacks,messaging_referrals",
            access_token: pageToken,
          }),
        },
      );

      // Remove existing entry for this page
      await query(`DELETE FROM messenger_accounts WHERE page_id = ?`, [pageId]);

      // Insert fresh
      await query(
        `INSERT INTO messenger_accounts (uid, page_id, page_name, page_access_token, user_access_token, webhook_id) VALUES (?,?,?,?,?,?)`,
        [uid, pageId, pageName, pageToken, userToken, pageId],
      );
    }

    // [CUSTOM] Also connect the Instagram account attached to each page, so a
    // Facebook login brings in the Instagram inbox without a second login.
    // Failures here never affect the Messenger connection above.
    let instaNote = "";
    try {
      const insta = await linkInstagramForPages({
        uid,
        pages: pagesData.data,
      });

      logger.log(
        `[messenger] Instagram via Facebook: linked=${insta.linked.length} ` +
          `noInstagram=${insta.no_instagram} planBlocked=${insta.plan} ` +
          `errors=${insta.errors.length}${
            insta.errors.length ? " -> " + insta.errors.join(" | ") : ""
          }`,
      );

      if (insta.linked.length) {
        instaNote = `<p>📷 Instagram: ${insta.linked
          .map((u) => "@" + u)
          .join(", ")}</p>`;
      } else if (insta.plan) {
        instaNote = `<p style="opacity:0.85;font-size:0.85rem">Instagram not linked: your plan doesn't include the Instagram inbox.</p>`;
      }
    } catch (e) {
      logger.log("[messenger] Instagram link step failed: " + e.message);
    }

    return res.send(`<html><body style="${pageStyle}">
      <h2>✅ Connected ${pagesData.data.length} page(s)</h2>
      ${instaNote}
      <p style="opacity:0.8">Closing in 2 seconds...</p>
      <script>
        if (window.opener) window.opener.postMessage({ type: "MESSENGER_CONNECTED" }, "*");
        setTimeout(() => window.close(), 2000);
      </script>
    </body></html>`);
  } catch (err) {
    logger.error(err);
    return res.send(`<html><body style="${pageStyle}">
      <h2>❌ Error</h2>
      <pre style="font-size:0.8rem;opacity:0.8">${err.message}</pre>
      <script>setTimeout(() => window.close(), 4000);</script>
    </body></html>`);
  }
});

// ─── User: get accounts ───────────────────────────────────────
router.get("/accounts", validateUser, checkPlan, async (req, res) => {
  try {
    const accounts = await query(
      `SELECT id, page_id, page_name, profile_pic, webhook_id, connected_at FROM messenger_accounts WHERE uid = ?`,
      [req.decode.uid],
    );
    res.json({ success: true, accounts });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ─── User: delete account ─────────────────────────────────────
router.post("/delete-account", validateUser, checkPlan, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM messenger_accounts WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    res.json({ success: true, msg: "Account disconnected" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ─── Webhook verification ─────────────────────────────────────
router.get("/webhook/:uid", (req, res) => {
  const VERIFY_TOKEN = req.params.uid;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: "Forbidden" });
});

// Replace the existing router.post("/webhook/:uid", ...) with:
router.post("/webhook/:uid", async (req, res) => {
  try {
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) return res.status(403).send("Forbidden");

    const [pvt] = await query(
      `SELECT messenger_app_secret FROM web_private LIMIT 1`,
      [],
    );
    if (!pvt?.messenger_app_secret) return res.status(403).send("Forbidden");

    const expectedSig =
      "sha256=" +
      crypto
        .createHmac("sha256", pvt.messenger_app_secret)
        .update(req.rawBody || JSON.stringify(req.body))
        .digest("hex");

    if (signature !== expectedSig) {
      console.log("[FB webhook] rejected: bad signature");
      return res.status(403).send("Forbidden");
    }

    res.status(200).send("EVENT_RECEIVED");

    const body = req.body;
    console.log(
      `[FB webhook] hit object=${body?.object} entry=${body?.entry?.[0]?.id}`,
    );

    // [CUSTOM] Instagram accounts linked through a Facebook Page send their
    // events as object "instagram". If the Facebook app's instagram webhook
    // points at this URL, hand them to the Instagram handler instead of
    // dropping them. Signature was already checked above.
    if (body.object === "instagram") {
      const { handleInstaWebhookBody } = require("./insta.js");
      await handleInstaWebhookBody(body);
      return;
    }

    if (body.object !== "page") return;

    const entry = body?.entry?.[0];
    if (!entry) return;

    const pageId = String(entry.id);

    const [account] = await query(
      `SELECT * FROM messenger_accounts WHERE page_id = ? LIMIT 1`,
      [pageId],
    );
    if (!account) return;

    const uid = account.uid;

    await processMessage({
      body,
      uid,
      origin: "messenger",
    });
  } catch (err) {
    logger.error("Messenger webhook error:", err);
  }
});

// ─── Debug: see what callback URI is being used ───────────────
router.get("/debug-callback-uri", async (req, res) => {
  const callbackUri = `${process.env.BACKURI}/api/messenger/callback`;
  res.json({ callbackUri });
});

module.exports = router;

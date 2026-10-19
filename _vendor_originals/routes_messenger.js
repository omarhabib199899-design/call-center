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
      scope: scopes,
      response_type: "code",
      state: req.decode.uid,
    });

    const url = `https://www.facebook.com/dialog/oauth?${params.toString()}`;
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

    const userToken = tokenData.access_token;

    // Get pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me/accounts?access_token=${userToken}`,
    );
    const pagesData = await pagesRes.json();

    if (!pagesData.data || pagesData.data.length === 0) {
      throw new Error("No Facebook Pages found for this account");
    }

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
            subscribed_fields: "messages,messaging_postbacks",
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

    return res.send(`<html><body style="${pageStyle}">
      <h2>✅ Connected ${pagesData.data.length} page(s)</h2>
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

    if (signature !== expectedSig) return res.status(403).send("Forbidden");

    res.status(200).send("EVENT_RECEIVED");

    const body = req.body;
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

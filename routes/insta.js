const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const validateUser = require("../middlewares/user.js");
const {
  exchangeShortToken,
  exchangeLongToken,
  fetchInstaProfile,
  getInstaCallbackUri,
  subscribeInstaWebhook,
} = require("../helper/addon/insta/insta.js");
const {
  processInstaMessage,
  resolveAccountFromWebhook,
  processInstaComment,
} = require("../helper/addon/insta/processInstagram.js");
const { processMessage } = require("../helper/inbox/inbox.js");
const { processAutomation } = require("../automation/automation.js");
const { checkPlan, checkInstaInbox } = require("../middlewares/plan.js");
const logger = require("../utils/logger.js");
const crypto = require("crypto");
// [CUSTOM] ad / post attribution for Instagram comments
const socialSource = require("../helper/socialSource.js");

const pageStyle = `
  font-family:sans-serif;display:flex;flex-direction:column;
  align-items:center;justify-content:center;min-height:100vh;
  background:linear-gradient(135deg,#f09433,#dc2743,#bc1888);
  color:#fff;margin:0;padding:20px;box-sizing:border-box;text-align:center
`;

// ─── Get Auth URL ─────────────────────────────────────────
router.get("/auth-url", validateUser, async (req, res) => {
  try {
    const [apiKeys] = await query(
      `SELECT insta_app_id, insta_app_secret FROM web_private`,
      [],
    );

    const instaCallbackUri = await getInstaCallbackUri();

    if (!apiKeys?.insta_app_id || !instaCallbackUri) {
      return res.json({
        success: false,
        msg: "Instagram app not configured. Please contact admin.",
      });
    }

    const SCOPES =
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish";

    const params = new URLSearchParams({
      client_id: apiKeys.insta_app_id,
      redirect_uri: instaCallbackUri,
      scope: SCOPES,
      response_type: "code",
      state: req.decode.uid,
    });

    const url = `https://www.instagram.com/oauth/authorize?${params.toString()}`;
    return res.json({ success: true, url });
  } catch (err) {
    logger.log(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ─── OAuth Callback ──────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, error, state: uid } = req.query;

  if (error || !code || !uid) {
    return res.send(`<html><body style="${pageStyle}">
      <h2>❌ Error: ${error || "Missing parameters"}</h2>
      <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>`);
  }

  try {
    const [apiKeys] = await query(
      `SELECT insta_app_id, insta_app_secret FROM web_private`,
      [],
    );

    const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    const plan = user?.plan ? JSON.parse(user.plan) : null;
    if (!plan) {
      return res.send(`<html><body style="${pageStyle}">
        <h2>❌ Error: No active plan</h2>
        <p>Please subscribe to a plan to connect your Instagram account.</p>
        <script>setTimeout(() => window.close(), 4000);</script>
      </body></html>`);
    }

    const checkInstraGram = parseInt(plan?.instagram_inbox) > 0 ? true : false;
    if (!checkInstraGram) {
      return res.send(`<html><body style="${pageStyle}">
        <h2>❌ Error: Instagram inbox not included in your plan</h2>
        <p>Please upgrade your plan to connect your Instagram account.</p>
        <script>setTimeout(() => window.close(), 4000);</script>
      </body></html>`);
    }

    const instaCallbackUri = await getInstaCallbackUri();

    if (!apiKeys?.insta_app_id || !apiKeys?.insta_app_secret) {
      throw new Error("Instagram credentials not configured.");
    }

    if (!instaCallbackUri) {
      throw new Error("Instagram callback URL not configured.");
    }

    // Short-lived token
    const tokenData = await exchangeShortToken({
      appId: apiKeys.insta_app_id,
      appSecret: apiKeys.insta_app_secret,
      redirectUri: instaCallbackUri,
      code,
    });

    if (!tokenData.access_token) {
      throw new Error("Token exchange failed: " + JSON.stringify(tokenData));
    }

    // Long-lived token
    const longData = await exchangeLongToken({
      appSecret: apiKeys.insta_app_secret,
      shortToken: tokenData.access_token,
    });

    const finalToken = longData.access_token || tokenData.access_token;

    // Fetch profile
    const profile = await fetchInstaProfile(finalToken);
    if (!profile?.username) {
      throw new Error("Could not fetch Instagram profile.");
    }

    const igBusinessId = String(profile.user_id || profile.id);
    const igGraphId = String(profile.id);

    // ── Delete from ANY uid first (no duplicates across users) ────────────
    await query(`DELETE FROM instagram_accounts WHERE webhook_id = ?`, [
      igBusinessId,
    ]);

    // ── Fresh insert for current uid ──────────────────────────────────────
    await query(
      `INSERT INTO instagram_accounts
        (uid, webhook_id, ig_graph_id, user_id, page_id,
         username, name, profile_pic, access_token,
         token_type, expires_in, connected_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uid,
        igBusinessId,
        igGraphId,
        igBusinessId,
        String(tokenData.user_id || ""),
        profile.username,
        profile.name || "",
        profile.profile_picture_url || "",
        finalToken,
        longData.token_type || "bearer",
        longData.expires_in || null,
        new Date(),
      ],
    );

    await subscribeInstaWebhook(finalToken);

    return res.send(`<html><body style="${pageStyle}">
      <h2>✅ Connected @${profile.username}</h2>
      ${
        profile.profile_picture_url
          ? `<img src="${profile.profile_picture_url}" style="width:80px;height:80px;border-radius:50%;margin:12px 0"/>`
          : ""
      }
      <p>${profile.name || ""}</p>
      <p style="opacity:0.7;font-size:0.85rem">Closing in 2 seconds...</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "INSTA_CONNECTED" }, "*");
        }
        setTimeout(() => window.close(), 2000);
      </script>
    </body></html>`);
  } catch (err) {
    logger.log(err);
    return res.send(`<html><body style="${pageStyle}">
      <h2>❌ Error</h2>
      <pre style="font-size:0.8rem;opacity:0.8">${err.message}</pre>
      <script>setTimeout(() => window.close(), 4000);</script>
    </body></html>`);
  }
});

// ─── Get all accounts for logged-in user ─────────────────
router.get(
  "/accounts",
  validateUser,
  checkPlan,
  checkInstaInbox,
  async (req, res) => {
    try {
      const accounts = await query(
        `SELECT id, uid, webhook_id, ig_graph_id, user_id,
              username, name, profile_pic, token_type,
              expires_in, connected_at, createdAt
              FROM instagram_accounts WHERE uid = ?`,
        [req.decode.uid],
      );

      res.json({ success: true, accounts });
    } catch (err) {
      logger.log(err);
      res.json({ success: false, msg: "Something went wrong" });
    }
  },
);

// ─── Delete an account ────────────────────────────────────
router.post(
  "/delete-account",
  validateUser,
  checkPlan,
  checkInstaInbox,
  async (req, res) => {
    try {
      const { id } = req.body;
      await query(`DELETE FROM instagram_accounts WHERE id = ?`, [id]);
      res.json({ success: true, msg: "Account disconnected" });
    } catch (err) {
      logger.log(err);
      res.json({ success: false, msg: "Something went wrong" });
    }
  },
);

router.get("/webhook/:uid", (req, res) => {
  const VERIFY_TOKEN = req.params.uid;
  const {
    "hub.mode": mode,
    "hub.verify_token": token,
    "hub.challenge": challenge,
  } = req.query;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: "Forbidden" });
});

// [CUSTOM] Always-on trace for Instagram webhooks. utils/logger is silent
// unless NODE_ENV=logs, which made "nothing arrives" and "arrived but was
// dropped" look identical. These lines go straight to the process log.
function igTrace(...args) {
  console.log("[IG webhook]", ...args);
}

router.post("/webhook/:uid", async (req, res) => {
  try {
    igTrace(
      `hit object=${req.body?.object} entry=${req.body?.entry?.[0]?.id} ` +
        `signed=${!!req.headers["x-hub-signature-256"]}`,
    );

    // ── HMAC Signature Verification ──────────────────────
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      igTrace("rejected: no signature header");
      return res.status(403).send("Forbidden");
    }

    // [CUSTOM] Accept a signature made with either of our app secrets.
    // Instagram-Login accounts are signed with the Instagram app secret;
    // accounts reached through a Facebook Page can be signed with the
    // Facebook app secret instead. Both secrets are ours, so accepting
    // either does not widen who can post to this endpoint.
    const [apiKeys] = await query(
      `SELECT insta_app_secret, messenger_app_secret FROM web_private LIMIT 1`,
      [],
    );

    const secrets = [apiKeys?.insta_app_secret, apiKeys?.messenger_app_secret]
      .filter(Boolean);
    if (!secrets.length) return res.status(403).send("Forbidden");

    const payload = req.rawBody || JSON.stringify(req.body);
    const sigBuf = Buffer.from(String(signature));

    const signatureOk = secrets.some((secret) => {
      const expected = Buffer.from(
        "sha256=" +
          crypto.createHmac("sha256", secret).update(payload).digest("hex"),
      );
      return (
        expected.length === sigBuf.length &&
        crypto.timingSafeEqual(expected, sigBuf)
      );
    });

    if (!signatureOk) {
      igTrace(
        "rejected: signature matches neither insta_app_secret nor messenger_app_secret",
      );
      return res.status(403).send("Forbidden");
    }

    res.status(200).send("EVENT_RECEIVED");
    await handleInstaWebhookBody(req.body);
  } catch (err) {
    igTrace("handler error:", err?.message || err);
  }
});

/**
 * [CUSTOM] Everything after signature verification, split out so the
 * Messenger webhook can hand over `object: "instagram"` events. When Instagram
 * is reached through a Facebook Page, Meta delivers its events to whatever
 * callback the Facebook app has for the `instagram` object — often the same
 * URL as Messenger, whose handler used to throw them away.
 * The caller must already have verified the signature.
 */
async function handleInstaWebhookBody(body) {
  try {
    const entry = body?.entry?.[0];
    if (!entry) {
      igTrace("ignored: payload has no entry");
      return;
    }

    const igBusinessId = String(entry.id);
    const igAccount = await resolveAccountFromWebhook(igBusinessId);
    if (!igAccount) {
      igTrace(
        `ignored: no instagram_accounts row with webhook_id/user_id = ${igBusinessId}`,
      );
      return;
    }

    // [CUSTOM] Meta sometimes delivers DMs in the `changes` envelope
    // ({field:"messages", value:{sender,recipient,timestamp,message}})
    // instead of `messaging`. The value has the same shape as a messaging
    // event, so lift those into entry.messaging; only comments stay in
    // `changes`. Without this such DMs were silently dropped.
    const MESSAGING_FIELDS = [
      "messages",
      "messaging_postbacks",
      "messaging_seen",
      "messaging_referral",
      "messaging_optins",
      "message_reactions",
      "message_edit",
    ];
    const changeFields = (entry.changes || []).map((c) => c?.field);
    const lifted = (entry.changes || [])
      .filter((c) => MESSAGING_FIELDS.includes(c?.field) && c?.value?.sender)
      .map((c) => c.value);
    if (lifted.length) {
      entry.messaging = [...(entry.messaging || []), ...lifted];
      entry.changes = (entry.changes || []).filter(
        (c) => !MESSAGING_FIELDS.includes(c?.field),
      );
    }

    igTrace(
      `routing to uid=${igAccount.uid} @${igAccount.username} ` +
        `(${igAccount.token_type}) messaging=${entry.messaging?.length || 0} ` +
        `changes=${entry.changes?.length || 0} ` +
        `fields=[${changeFields.join(",")}] lifted=${lifted.length}`,
    );

    const uid = igAccount.uid;

    // ── COMMENTS ──────────────────────────────────────────────────────────
    const commentChanges = entry.changes?.filter((c) => c.field === "comments");

    if (commentChanges?.length > 0) {
      const {
        getCurrentTimestampInTimeZone,
        saveMessageToConversation,
      } = require("../functions/function");
      const randomstring = require("randomstring");

      const [user] = await query(`SELECT * FROM user WHERE uid = ? LIMIT 1`, [
        uid,
      ]);
      if (!user) return;

      for (const change of commentChanges) {
        const commentData = change.value;
        if (!commentData?.from?.id) continue;

        const commenterId = String(commentData.from.id);
        const commenterName = commentData.from.username || "Instagram User";
        const commentText = commentData.text || "";
        const commentId = commentData.id;
        const mediaId = commentData.media?.id || null;

        const mediaProductType = commentData.media?.media_product_type || null;
        const parentId = commentData.parent_id || null;
        const isReply = !!parentId;

        const senderMobile = `${commenterId}`;

        // ── Find or create chat ──────────────────────────────────────────
        const [existingChat] = await query(
          `SELECT * FROM beta_chats 
           WHERE uid = ? AND sender_mobile = ? AND origin = ? LIMIT 1`,
          [uid, senderMobile, "instagram_comment"],
        );

        let chatId;
        if (existingChat) {
          chatId = existingChat.chat_id;
        } else {
          chatId = randomstring.generate(20);
          await query(
            `INSERT INTO beta_chats 
              (uid, chat_id, sender_mobile, sender_name, origin,
               origin_instance_id, last_message, createdAt)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              uid,
              chatId,
              senderMobile,
              commenterName,
              "instagram_comment",
              JSON.stringify({
                // ✅ JSON object, not plain string
                id: igAccount.user_id,
                username: igAccount.username,
                name: igAccount.name || "",
              }),
              JSON.stringify({ type: "text", text: { body: commentText } }),
              new Date(),
            ],
          );
        }

        // ── Save incoming comment to conversation ────────────────────────
        const userTimezone = getCurrentTimestampInTimeZone(
          user?.timezone || "Asia/Kolkata",
        );

        const messageData = {
          type: "text",
          metaChatId: commentId,
          msgContext: { type: "text", text: { body: commentText } },
          reaction: "",
          timestamp: parseInt(userTimezone),
          senderName: commenterName,
          senderMobile,
          star: 0,
          route: "INCOMING",
          context: parentId ? { parentCommentId: parentId, isReply } : null,
          origin: "instagram_comment",
        };

        // [CUSTOM] Which post is this comment on? The webhook only gives a
        // media id, so look the post up and show it above the comment. The
        // chat list keeps the plain comment text. Never blocks the comment.
        let conversationData = messageData;
        if (mediaId) {
          const post = await socialSource.describeInstagramPost({
            igAccount,
            uid,
            mediaId,
          });
          const note = socialSource.postNote(post, mediaId);
          if (note) {
            // The post as a picture message just above the comment; no
            // picture -> the note goes on top of the comment instead.
            const card = await socialSource.makeCard(
              { note, picture: post?.thumbnail, link: post?.permalink },
              {
                timestamp: messageData.timestamp,
                senderName: commenterName,
                senderMobile,
                origin: "instagram_comment",
              },
            );
            if (card) {
              await saveMessageToConversation({
                uid,
                chatId,
                messageData: card,
                sentBy: "instagram_comment",
              });
            } else {
              conversationData = {
                ...messageData,
                msgContext: socialSource.decorate(messageData.msgContext, note),
              };
            }
          }
          await socialSource.recordPost({
            uid,
            chatId,
            commenterId,
            commenterName,
            post,
            mediaId,
          });
        }

        await saveMessageToConversation({
          uid,
          chatId,
          messageData: conversationData,
          sentBy: "instagram_comment",
        });

        // ── Update last_message on chat ──────────────────────────────────
        await query(
          `UPDATE beta_chats SET last_message = ?, sender_name = ? 
           WHERE chat_id = ? AND uid = ?`,
          [JSON.stringify(messageData), commenterName, chatId, uid],
        );

        // ── Build message object for automation ──────────────────────────
        const message = {
          senderMobile,
          senderName: commenterName,
          msgContext: { type: "text", text: { body: commentText } },
          commentId,
          mediaId,
          mediaProductType,
          parentId,
          isReply,
          commentText,
        };

        // ── Fire automation ──────────────────────────────────────────────
        await processAutomation({
          uid,
          message,
          user,
          sessionId: igAccount.user_id,
          origin: "instagram_comment",
          chatId,
        });
      }
      return;
    }

    // ── REGULAR DM / MESSAGING EVENTS ─────────────────────────────────────
    await processMessage({ body, uid, origin: "instagram" });
  } catch (err) {
    igTrace("processing error:", err?.message || err);
  }
}

// Helper at top of file or in a utils
async function getUserByUid(uid) {
  const [user] = await query(`SELECT * FROM user WHERE uid = ? LIMIT 1`, [uid]);
  return user;
}

module.exports = router;
module.exports.handleInstaWebhookBody = handleInstaWebhookBody;

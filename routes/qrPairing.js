/**
 * [CUSTOM] Link a WhatsApp number remotely.
 *
 *   Owner (signed in, /whatsapp-pairing.html)
 *     GET  /list                 the owner's numbers
 *     POST /code   {uniqueId}    8-character pairing code for a number
 *     POST /share  {uniqueId}    a 24-hour link for someone at the branch
 *
 *   Branch (no account, /link-number.html?t=<link token>)
 *     GET  /public/status?t=     number title, status, current QR image
 *     POST /public/start  {t}    start a fresh login (a QR appears)
 *     POST /public/code   {t, phone?}  pairing code instead of a QR
 *
 * A link token is a signed JWT for ONE number, valid 24 hours. It can only
 * start a login for that number; it cannot read chats or anything else.
 * Kept in its own file (mounted at /api/qr_pairing); routes/qr.js untouched.
 */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const { query } = require("../database/dbpromise.js");
const { createSession, getSession } = require("../helper/addon/qr/index.js");
const validateUser = require("../middlewares/user.js");
const logger = require("../utils/logger.js");

const LINK_HOURS = 24;

/**
 * Logged in = WhatsApp completed pairing (QR or code) for this device:
 * Baileys then stores creds.account (the signed device identity) and
 * creds.me. NOT creds.registered: Baileys sets that only in the
 * pairing-code flow, so every QR-linked number looked logged out.
 */
function isLoggedIn(s) {
  return !!(s?.authState?.creds?.account && s?.authState?.creds?.me);
}

function isConnected(uniqueId) {
  const s = getSession(uniqueId);
  return isLoggedIn(s) && !!s?.ws?.isOpen;
}

/**
 * Fresh login socket for a number; resolves true once WhatsApp is ready
 * (it sends a QR), false after 25 s.
 */
function startLogin(instance) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 25000);
    query(`UPDATE instance SET qr = NULL WHERE uniqueId = ?`, [instance.uniqueId])
      .catch(() => {})
      .finally(() => {
        createSession(instance.uniqueId, String(instance.title || "Chrome").slice(0, 20), {
          syncFullHistory: process.env.QR_FULL_HISTORY === "true",
          onQr: () => {
            clearTimeout(t);
            resolve(true);
          },
        });
      });
  });
}

async function pairingCode(instance, rawPhone) {
  const phone = String(rawPhone || instance.number || "").replace(/\D/g, "");
  if (phone.length < 8) {
    return { success: false, msg: "Enter the phone number with country code" };
  }
  if (isConnected(instance.uniqueId)) {
    return { success: false, msg: "This number is already connected" };
  }
  if (!(await startLogin(instance))) {
    return { success: false, msg: "WhatsApp did not respond, try again" };
  }
  const sock = getSession(instance.uniqueId);
  if (!sock?.requestPairingCode) {
    return { success: false, msg: "Session not ready, try again" };
  }
  const code = await sock.requestPairingCode(phone);
  console.log(`[WA ${instance.uniqueId}] pairing code requested for ${phone}`);
  return {
    success: true,
    data: { code: String(code).replace(/(.{4})(.{4})/, "$1-$2"), phone, title: instance.title },
  };
}

async function ownedInstance(uniqueId, uid) {
  const [instance] = await query(
    `SELECT * FROM instance WHERE uniqueId = ? AND uid = ? LIMIT 1`,
    [uniqueId, uid],
  );
  return instance || null;
}

/** The instance a link token points to, or null when invalid/expired. */
async function linkedInstance(token) {
  try {
    const p = jwt.verify(String(token || ""), process.env.JWTKEY);
    if (p?.typ !== "wa_link" || !p.u || !p.o) return null;
    return await ownedInstance(p.u, p.o);
  } catch (e) {
    return null;
  }
}

/* ---------- owner ---------- */

router.get("/list", validateUser, async (req, res) => {
  try {
    const rows = await query(
      `SELECT uniqueId, title, number, status FROM instance WHERE uid = ? ORDER BY id DESC`,
      [req.decode.uid],
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

router.post("/code", validateUser, async (req, res) => {
  try {
    const instance = await ownedInstance(req.body?.uniqueId, req.decode.uid);
    if (!instance) return res.json({ success: false, msg: "Number not found" });
    res.json(await pairingCode(instance, req.body?.phone));
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: err.message || "Something went wrong" });
  }
});

router.post("/share", validateUser, async (req, res) => {
  try {
    const instance = await ownedInstance(req.body?.uniqueId, req.decode.uid);
    if (!instance) return res.json({ success: false, msg: "Number not found" });
    const token = jwt.sign(
      { typ: "wa_link", u: instance.uniqueId, o: req.decode.uid },
      process.env.JWTKEY,
      { expiresIn: `${LINK_HOURS}h` },
    );
    const base = String(process.env.FRONTENDURI || "").replace(/\/+$/, "");
    res.json({
      success: true,
      data: { url: `${base}/link-number.html?t=${encodeURIComponent(token)}`, hours: LINK_HOURS },
    });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

/* ---------- disconnect alerts ---------- */

// A number counts as down only after this long, so restarts and normal
// reconnects (a few seconds) never raise an alert.
const ALERT_GRACE_MS = 2 * 60 * 1000;
const downSince = new Map(); // uniqueId -> ms timestamp first seen down

function isUp(uniqueId) {
  return isConnected(uniqueId);
}

/**
 * Numbers of this owner that were linked (have a phone number) and have
 * been offline for more than ALERT_GRACE_MS. Polled by number-alerts.js.
 */
router.get("/alerts", validateUser, async (req, res) => {
  try {
    const rows = await query(
      `SELECT uniqueId, title, number, status FROM instance
       WHERE uid = ? AND number IS NOT NULL AND number <> ''`,
      [req.decode.uid],
    );
    const now = Date.now();
    const down = [];
    for (const r of rows) {
      if (isUp(r.uniqueId)) {
        downSince.delete(r.uniqueId);
        continue;
      }
      if (!downSince.has(r.uniqueId)) downSince.set(r.uniqueId, now);
      const since = downSince.get(r.uniqueId);
      if (now - since < ALERT_GRACE_MS) continue;
      const s = getSession(r.uniqueId);
      down.push({
        uniqueId: r.uniqueId,
        title: r.title,
        number: r.number,
        needsScan: !isLoggedIn(s),
        minutes: Math.round((now - since) / 60000),
      });
    }
    res.json({ success: true, data: down });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

/* ---------- branch (link token) ---------- */

router.get("/public/status", async (req, res) => {
  try {
    const instance = await linkedInstance(req.query?.t);
    if (!instance) return res.json({ success: false, expired: true, msg: "This link has expired or is invalid" });
    res.json({
      success: true,
      data: {
        title: instance.title,
        number: instance.number,
        connected: isConnected(instance.uniqueId),
        qr: instance.qr || null,
      },
    });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

router.post("/public/start", async (req, res) => {
  try {
    const instance = await linkedInstance(req.body?.t);
    if (!instance) return res.json({ success: false, expired: true, msg: "This link has expired or is invalid" });
    if (isConnected(instance.uniqueId)) {
      return res.json({ success: false, msg: "This number is already connected" });
    }
    const ok = await startLogin(instance);
    res.json(ok ? { success: true } : { success: false, msg: "WhatsApp did not respond, try again" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

router.post("/public/code", async (req, res) => {
  try {
    const instance = await linkedInstance(req.body?.t);
    if (!instance) return res.json({ success: false, expired: true, msg: "This link has expired or is invalid" });
    res.json(await pairingCode(instance, req.body?.phone));
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: err.message || "Something went wrong" });
  }
});

module.exports = router;

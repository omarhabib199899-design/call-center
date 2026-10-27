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

function isConnected(uniqueId) {
  const s = getSession(uniqueId);
  return !!(s?.authState?.creds?.registered && s?.user);
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
    return { success: false, msg: "اكتب رقم الموبايل بكود الدولة" };
  }
  if (isConnected(instance.uniqueId)) {
    return { success: false, msg: "الرقم ده متصل بالفعل" };
  }
  if (!(await startLogin(instance))) {
    return { success: false, msg: "واتساب مردّش، جرّب تاني" };
  }
  const sock = getSession(instance.uniqueId);
  if (!sock?.requestPairingCode) {
    return { success: false, msg: "الجلسة مش جاهزة، جرّب تاني" };
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

/* ---------- branch (link token) ---------- */

router.get("/public/status", async (req, res) => {
  try {
    const instance = await linkedInstance(req.query?.t);
    if (!instance) return res.json({ success: false, expired: true, msg: "الرابط انتهى أو غلط" });
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
    if (!instance) return res.json({ success: false, expired: true, msg: "الرابط انتهى أو غلط" });
    if (isConnected(instance.uniqueId)) {
      return res.json({ success: false, msg: "الرقم ده متصل بالفعل" });
    }
    const ok = await startLogin(instance);
    res.json(ok ? { success: true } : { success: false, msg: "واتساب مردّش، جرّب تاني" });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

router.post("/public/code", async (req, res) => {
  try {
    const instance = await linkedInstance(req.body?.t);
    if (!instance) return res.json({ success: false, expired: true, msg: "الرابط انتهى أو غلط" });
    res.json(await pairingCode(instance, req.body?.phone));
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: err.message || "Something went wrong" });
  }
});

module.exports = router;

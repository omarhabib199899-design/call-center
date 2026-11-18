// Instagram messages for accounts connected through Facebook
const crypto = require("crypto");
const { query } = require("../database/dbpromise.js");
const { getInstaCallbackUri } = require("./addon/insta/insta.js");

const SCOPES =
  "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments";
const enabled = () => String(process.env.INSTA_CHAIN_AFTER_FACEBOOK || "1").trim() !== "0";

async function instaAuthUrl(uid, { force = false } = {}) {
  if (!enabled()) return null;
  const [keys] = await query(`SELECT insta_app_id FROM web_private`, []);
  const redirect = await getInstaCallbackUri();
  if (!keys?.insta_app_id || !redirect || !uid) return null;
  const params = new URLSearchParams({
    client_id: keys.insta_app_id,
    redirect_uri: redirect,
    scope: SCOPES,
    response_type: "code",
    state: uid,
  });
  if (force) params.set("force_reauth", "true");
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

// Short signature so the popup can read its own owner's list without a login token
function sign(uid) {
  return crypto
    .createHmac("sha256", String(process.env.JWTKEY || "omni-ig"))
    .update("ig-activate:" + uid)
    .digest("hex")
    .slice(0, 32);
}

function checkSig(uid, t) {
  if (!uid || !t) return false;
  const a = Buffer.from(sign(uid));
  const b = Buffer.from(String(t));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function accountsOf(uid) {
  const rows = await query(
    `SELECT username, token_type FROM instagram_accounts WHERE uid = ? ORDER BY username`,
    [uid],
  );
  return rows.map((r) => ({
    username: r.username,
    active: String(r.token_type || "").toLowerCase() !== "page",
  }));
}

// GET /api/messenger/ig-activate-status?u=&t=
async function statusRoute(req, res) {
  try {
    const { u, t } = req.query;
    if (!checkSig(u, t)) return res.status(403).json({ success: false });
    res.json({ success: true, data: await accountsOf(u) });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// HTML for the popup after a Facebook connection (or GET /ig-activate)
async function activatePage({ uid, pageStyle, pageCount }) {
  const url = await instaAuthUrl(uid, { force: true });
  const list = await accountsOf(uid);
  const pending = list.filter((a) => !a.active).length;
  const t = sign(uid);
  return `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activate Instagram messages</title></head>
<body style="${pageStyle};justify-content:flex-start;padding-top:32px">
  ${pageCount ? `<h2 style="margin:0 0 6px">✅ Connected ${pageCount} page(s)</h2>` : ""}
  <h3 style="margin:8px 0 4px">Activate Instagram messages</h3>
  <p style="opacity:.9;max-width:460px;font-size:.92rem;margin:0 0 14px">Tap <b>Activate</b> next to each account. On the Instagram screen, log in as that account and tap <b>Allow</b>. If another account shows, choose <b>Not you? / Switch account</b>. Each account needs this once.</p>
  <div id="list" style="width:100%;max-width:460px;display:flex;flex-direction:column;gap:8px"></div>
  <p id="sum" style="opacity:.85;font-size:.85rem;margin:14px 0 8px"></p>
  <button id="done" style="background:#fff;color:#0866ff;border:0;border-radius:8px;padding:10px 22px;font-weight:600;font-size:.95rem;cursor:pointer">Done</button>
<script>
  var AUTH = ${JSON.stringify(url)};
  var STATUS = "/api/messenger/ig-activate-status?u=" + encodeURIComponent(${JSON.stringify(uid)}) + "&t=${t}";
  var data = ${JSON.stringify(list)};
  var waiting = null;
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
  function draw(){
    var box = document.getElementById("list"); box.innerHTML = "";
    data.forEach(function(a){
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(255,255,255,.14);border-radius:10px;padding:10px 12px;text-align:left";
      row.innerHTML = '<span style="font-weight:600">@' + esc(a.username) + '</span>' + (a.active
        ? '<span style="background:#1f9d6a;border-radius:999px;padding:4px 10px;font-size:.8rem">✓ Messages on</span>'
        : '<button data-u="' + esc(a.username) + '" style="background:#fff;color:#0866ff;border:0;border-radius:8px;padding:7px 12px;font-weight:600;cursor:pointer">' + (waiting === a.username ? "Waiting…" : "Activate") + '</button>');
      box.appendChild(row);
    });
    var left = data.filter(function(a){return !a.active;}).length;
    document.getElementById("sum").textContent = data.length ? (left ? left + " of " + data.length + " still need activating" : "All accounts are active — Instagram messages will arrive in your inbox.") : "No Instagram accounts found on these pages.";
  }
  function refresh(){ fetch(STATUS).then(function(r){return r.json();}).then(function(r){ if(r && r.success){ data = r.data; if (waiting && data.some(function(a){return a.username===waiting && a.active;})) waiting = null; draw(); } }).catch(function(){}); }
  document.getElementById("list").addEventListener("click", function(e){
    var b = e.target.closest("button[data-u]"); if(!b || !AUTH) return;
    waiting = b.getAttribute("data-u"); draw();
    window.open(AUTH, "ig_activate", "width=520,height=760");
  });
  window.addEventListener("message", function(e){ if (e.data && e.data.type === "INSTA_CONNECTED") setTimeout(refresh, 600); });
  setInterval(function(){ if (document.visibilityState === "visible") refresh(); }, 4000);
  document.getElementById("done").onclick = function(){
    if (window.opener) { window.opener.postMessage({ type: "MESSENGER_CONNECTED" }, "*"); window.close(); }
    else location.replace("/user?page=link-messenger");
  };
  if (window.opener) window.opener.postMessage({ type: "MESSENGER_CONNECTED" }, "*");
  draw();
  ${pending ? "" : ""}
</script>
</body></html>`;
}

// GET /api/messenger/ig-activate?u=&t= (same page, reachable later)
async function activateRoute(req, res) {
  const { u, t } = req.query;
  if (!checkSig(u, t)) return res.status(403).send("Link expired or invalid.");
  const pageStyle = `font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#0866ff,#1877f2);color:#fff;margin:0;padding:20px;box-sizing:border-box;text-align:center`;
  res.send(await activatePage({ uid: u, pageStyle, pageCount: 0 }));
}

module.exports = { instaAuthUrl, sign, statusRoute, activatePage, activateRoute };

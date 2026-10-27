/**
 * Calls the real sendInstaMsg() for a Page-linked account and a legacy
 * Instagram-Login account, and reports which endpoint each one hit.
 * Run: node -r fake-graph.js send-test.js   (cwd = app dir, FAKE_LOG set)
 */
const path = require("path");
const fs = require("fs");
const APP = process.cwd();

require(path.join(APP, "node_modules/dotenv")).config({ path: path.join(APP, ".env") });

const { query } = require(path.join(APP, "database/dbpromise"));
const { sendInstaMsg } = require(path.join(APP, "helper/socket/function"));

const OWNER = "lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8";
const LOG = process.env.FAKE_LOG;

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || !extra ? "" : "  -> " + extra}`);
};

function lastCall() {
  const lines = fs.readFileSync(LOG, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

(async () => {
  const msg = { type: "text", text: { body: "مرحبا من النظام" } };

  console.log("\n=== Page-linked account (Facebook Login) ===");
  const r1 = await sendInstaMsg({
    uid: OWNER,
    to: "9990001",
    msgObj: msg,
    chatInfo: { origin_instance_id: JSON.stringify({ id: "17841499999999999" }) },
  });
  const c1 = lastCall();
  check("send reports success", r1.success === true, JSON.stringify(r1));
  check("goes to graph.facebook.com", c1.host === "graph.facebook.com", c1.host);
  check("addressed to the PAGE (1001), not 'me'", c1.path.endsWith("/1001/messages"), c1.path);
  check("uses the Page token", c1.token === "PAGETOKEN_1001", c1.token);
  check("recipient is the customer's IGSID", JSON.parse(c1.body).recipient.id === "9990001");
  check("Arabic text survives", JSON.parse(c1.body).message.text === "مرحبا من النظام");

  console.log("\n=== Legacy account (Instagram Login) must be untouched ===");
  await query(`DELETE FROM instagram_accounts WHERE webhook_id = 'LEGACY1'`);
  await query(
    `INSERT INTO instagram_accounts (uid, webhook_id, ig_graph_id, user_id, page_id, username, name, access_token, token_type)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [OWNER, "LEGACY1", "LEGACY1", "LEGACY1", "999", "legacyig", "Legacy", "IGTOKEN_LEGACY", "bearer"],
  );
  const r2 = await sendInstaMsg({
    uid: OWNER,
    to: "9990002",
    msgObj: msg,
    chatInfo: { origin_instance_id: JSON.stringify({ id: "LEGACY1" }) },
  });
  const c2 = lastCall();
  check("send reports success", r2.success === true, JSON.stringify(r2));
  check("still goes to graph.instagram.com", c2.host === "graph.instagram.com", c2.host);
  check("still uses /me/messages", c2.path.endsWith("/me/messages"), c2.path);
  check("uses the Instagram token", c2.token === "IGTOKEN_LEGACY", c2.token);
  await query(`DELETE FROM instagram_accounts WHERE webhook_id = 'LEGACY1'`);

  console.log("\n==============================");
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  console.log("==============================\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});

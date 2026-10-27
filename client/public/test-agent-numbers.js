/**
 * Functional test for the agent <-> number feature.
 * Run with cwd = the app directory.
 */
const path = require("path");
const APP = process.cwd();

require(path.join(APP, "node_modules/dotenv")).config({
  path: path.join(APP, ".env"),
});

const { query } = require(path.join(APP, "database/dbpromise"));
const {
  buildAgentChatCondition,
  getAgentNumbers,
  getAgentsForChat,
} = require(path.join(APP, "helper/agentInstances"));

const OWNER = "lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8";
const NUMBER = "919690309316"; // matches the existing qr chat
const AGENT_WITH = { id: 3, uid: "n9xrxIvwIajEo2JO2poQ0b3UyUnhUF3g", name: "john" };
const AGENT_WITHOUT = { id: 4, uid: "v8Odk2djveUs7A4kCFjO7acUiJJ5W266", name: "Paul" };

let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (extra ? "  -> " + extra : ""));
  }
}

/** Runs the exact query shape the socket handler builds. */
async function chatsVisibleTo(agent) {
  const scope = await buildAgentChatCondition(agent.id, agent.uid);
  const sql = `SELECT chat_id, origin_instance_id FROM beta_chats
               WHERE uid = ? AND ${scope.sql}`;
  return query(sql, [OWNER, ...scope.params]);
}

(async () => {
  console.log("\n=== setup ===");

  await query(`DELETE FROM agent_instances WHERE owner_uid = ?`, [OWNER]);
  await query(`DELETE FROM instance WHERE uniqueId = ?`, ["TESTINST01"]);
  await query(
    `INSERT INTO instance (uid, title, number, uniqueId, status)
     VALUES (?,?,?,?,?)`,
    [OWNER, "Test Number", NUMBER, "TESTINST01", "connected"],
  );
  console.log("  inserted test instance", NUMBER);

  const [target] = await query(
    `SELECT chat_id FROM beta_chats WHERE uid = ? AND origin_instance_id LIKE ? LIMIT 1`,
    [OWNER, `%"id":"${NUMBER}%`],
  );
  console.log("  target chat:", target ? target.chat_id : "NONE");

  console.log("\n=== 1. before assignment (stock behaviour) ===");
  const before = await chatsVisibleTo(AGENT_WITH);
  check(
    "agent sees no number-based chats before assignment",
    !before.some((c) => c.chat_id === target.chat_id),
    before.length + " rows",
  );

  console.log("\n=== 2. assign the number to john ===");
  await query(
    `INSERT INTO agent_instances (owner_uid, agent_id, agent_uid, instance_number, instance_unique_id)
     VALUES (?,?,?,?,?)`,
    [OWNER, AGENT_WITH.id, AGENT_WITH.uid, NUMBER, "TESTINST01"],
  );

  const nums = await getAgentNumbers(AGENT_WITH.uid);
  check("getAgentNumbers returns the number", nums.includes(NUMBER), JSON.stringify(nums));

  const after = await chatsVisibleTo(AGENT_WITH);
  check(
    "john NOW sees the chat on his number",
    after.some((c) => c.chat_id === target.chat_id),
    after.length + " rows",
  );

  console.log("\n=== 3. isolation: Paul has no numbers ===");
  const paul = await chatsVisibleTo(AGENT_WITHOUT);
  check(
    "Paul does NOT see john's number chats",
    !paul.some((c) => c.chat_id === target.chat_id),
    paul.length + " rows",
  );

  console.log("\n=== 4. same number, second agent ===");
  await query(
    `INSERT INTO agent_instances (owner_uid, agent_id, agent_uid, instance_number, instance_unique_id)
     VALUES (?,?,?,?,?)`,
    [OWNER, AGENT_WITHOUT.id, AGENT_WITHOUT.uid, NUMBER, "TESTINST01"],
  );
  const paul2 = await chatsVisibleTo(AGENT_WITHOUT);
  check(
    "Paul sees it too once assigned (shared number)",
    paul2.some((c) => c.chat_id === target.chat_id),
    paul2.length + " rows",
  );

  console.log("\n=== 5. chat-level assignment still works ===");
  await query(`DELETE FROM agent_instances WHERE owner_uid = ?`, [OWNER]);
  await query(
    `UPDATE beta_chats SET assigned_agent = ? WHERE chat_id = ? AND uid = ?`,
    [JSON.stringify([{ id: AGENT_WITH.id, uid: AGENT_WITH.uid, name: "john" }]), target.chat_id, OWNER],
  );
  const stock = await chatsVisibleTo(AGENT_WITH);
  check(
    "stock per-chat assignment unaffected",
    stock.some((c) => c.chat_id === target.chat_id),
    stock.length + " rows",
  );

  console.log("\n=== 6. notification targets ===");
  await query(
    `INSERT INTO agent_instances (owner_uid, agent_id, agent_uid, instance_number, instance_unique_id)
     VALUES (?,?,?,?,?)`,
    [OWNER, AGENT_WITHOUT.id, AGENT_WITHOUT.uid, NUMBER, "TESTINST01"],
  );
  const targets = await getAgentsForChat({ ownerUid: OWNER, chatId: target.chat_id });
  const uids = targets.map((t) => t.uid);
  check("includes chat-assigned agent (john)", uids.includes(AGENT_WITH.uid), JSON.stringify(uids));
  check("includes number-assigned agent (Paul)", uids.includes(AGENT_WITHOUT.uid), JSON.stringify(uids));

  console.log("\n=== cleanup ===");
  await query(`DELETE FROM agent_instances WHERE owner_uid = ?`, [OWNER]);
  await query(`DELETE FROM instance WHERE uniqueId = ?`, ["TESTINST01"]);
  await query(`UPDATE beta_chats SET assigned_agent = NULL WHERE chat_id = ? AND uid = ?`, [
    target.chat_id,
    OWNER,
  ]);
  console.log("  test data removed");

  console.log("\n============================");
  console.log("  PASSED: " + pass + "   FAILED: " + fail);
  console.log("============================\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});

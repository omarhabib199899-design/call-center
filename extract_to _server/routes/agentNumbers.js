/**
 * Manage which WhatsApp numbers each agent is assigned to.
 *
 * All routes are owner-only (validateUser). Agents never call these.
 * The matching UI is served at /agent-numbers.html.
 */

const express = require("express");
const router = express.Router();

const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const logger = require("../utils/logger");
const { normalizeNumber } = require("../helper/agentInstances");

/**
 * Everything the admin page needs in one call:
 * the owner's connected numbers, their agents, and the current mapping.
 */
router.get("/overview", validateUser, async (req, res) => {
  try {
    const ownerUid = req.decode.uid;

    const instances = await query(
      `SELECT uniqueId, title, number, status FROM instance WHERE uid = ? ORDER BY id DESC`,
      [ownerUid],
    );

    const agents = await query(
      `SELECT id, uid, name, email, mobile, is_active FROM agents
        WHERE owner_uid = ? ORDER BY name ASC`,
      [ownerUid],
    );

    const assignments = await query(
      `SELECT agent_uid, instance_number FROM agent_instances WHERE owner_uid = ?`,
      [ownerUid],
    );

    // agent_uid -> [number, ...]
    const map = {};
    for (const row of assignments) {
      if (!map[row.agent_uid]) map[row.agent_uid] = [];
      map[row.agent_uid].push(String(row.instance_number));
    }

    res.json({
      success: true,
      data: {
        instances: instances.map((i) => ({
          uniqueId: i.uniqueId,
          title: i.title || "Unnamed Instance",
          number: normalizeNumber(i.number),
          status: i.status,
        })),
        agents,
        assignments: map,
      },
    });
  } catch (err) {
    logger.log(err);
    res.json({
      success: false,
      msg:
        err?.code === "ER_NO_SUCH_TABLE"
          ? "Table agent_instances is missing. Run database/agent_instances.sql first."
          : "something went wrong",
    });
  }
});

/**
 * Replace the full set of numbers for one agent.
 * Body: { agent_uid: string, numbers: string[] }
 */
router.post("/set", validateUser, async (req, res) => {
  try {
    const ownerUid = req.decode.uid;
    const { agent_uid, numbers } = req.body;

    if (!agent_uid || !Array.isArray(numbers)) {
      return res.json({ success: false, msg: "Invalid input provided" });
    }

    // The agent must belong to this owner.
    const [agent] = await query(
      `SELECT id, uid FROM agents WHERE uid = ? AND owner_uid = ? LIMIT 1`,
      [agent_uid, ownerUid],
    );

    if (!agent) {
      return res.json({ success: false, msg: "Agent not found" });
    }

    // Only numbers this owner actually owns, so one tenant can never
    // grant its agents access to another tenant's traffic.
    const owned = await query(
      `SELECT uniqueId, number FROM instance WHERE uid = ?`,
      [ownerUid],
    );

    const ownedByNumber = new Map(
      owned.map((i) => [normalizeNumber(i.number), i.uniqueId]),
    );

    const wanted = [
      ...new Set(numbers.map(normalizeNumber).filter(Boolean)),
    ].filter((n) => ownedByNumber.has(n));

    await query(`DELETE FROM agent_instances WHERE owner_uid = ? AND agent_uid = ?`, [
      ownerUid,
      agent_uid,
    ]);

    for (const number of wanted) {
      await query(
        `INSERT INTO agent_instances
           (owner_uid, agent_id, agent_uid, instance_number, instance_unique_id)
         VALUES (?,?,?,?,?)`,
        [ownerUid, agent.id, agent_uid, number, ownedByNumber.get(number)],
      );
    }

    res.json({
      success: true,
      msg: `Saved. ${wanted.length} number(s) assigned.`,
      data: { agent_uid, numbers: wanted },
    });
  } catch (err) {
    logger.log(err);
    res.json({
      success: false,
      msg:
        err?.code === "ER_NO_SUCH_TABLE"
          ? "Table agent_instances is missing. Run database/agent_instances.sql first."
          : "something went wrong",
    });
  }
});

module.exports = router;

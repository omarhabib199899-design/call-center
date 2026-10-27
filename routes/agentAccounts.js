/**
 * Manage which connected accounts each agent works on, across every channel
 * (WhatsApp QR numbers, Cloud API, Facebook Pages, Instagram, Telegram),
 * plus the per-user inbox account filter.
 *
 * /overview and /set are owner-only. /filter accepts an owner or an agent
 * token, since both use the inbox. UI: /agent-numbers.html and
 * /inbox-account-filter.js.
 */

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const { query } = require("../database/dbpromise");
const validateUser = require("../middlewares/user");
const logger = require("../utils/logger");
const {
  ensureTables,
  parseKey,
  listOwnerAccounts,
  getAgentAccountKeys,
  setAgentAccounts,
  getInboxFilter,
  setInboxFilter,
  toKey,
} = require("../helper/agentAccounts");

function fail(res, err) {
  logger.log(err);
  res.json({ success: false, msg: "something went wrong" });
}

/** Owner's accounts, agents and the current mapping, in one call. */
router.get("/overview", validateUser, async (req, res) => {
  try {
    const ownerUid = req.decode.uid;
    await ensureTables();

    const accounts = await listOwnerAccounts(ownerUid);

    const agents = await query(
      `SELECT id, uid, name, email, mobile, is_active FROM agents
        WHERE owner_uid = ? ORDER BY name ASC`,
      [ownerUid],
    );

    // agent_uid -> [key, ...]
    const assignments = {};
    for (const a of agents) {
      assignments[a.uid] = await getAgentAccountKeys(a.uid);
    }

    res.json({ success: true, data: { accounts, agents, assignments } });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Replace the full set of accounts for one agent.
 * Body: { agent_uid: string, accounts: string[] }  e.g. ["qr:2010...", "messenger:123"]
 */
router.post("/set", validateUser, async (req, res) => {
  try {
    const ownerUid = req.decode.uid;
    const { agent_uid, accounts } = req.body;

    if (!agent_uid || !Array.isArray(accounts)) {
      return res.json({ success: false, msg: "Invalid input provided" });
    }

    const [agent] = await query(
      `SELECT id, uid FROM agents WHERE uid = ? AND owner_uid = ? LIMIT 1`,
      [agent_uid, ownerUid],
    );
    if (!agent) return res.json({ success: false, msg: "Agent not found" });

    // Only accounts this owner actually has, so one tenant can never grant
    // its agents another tenant's traffic.
    const owned = new Map(
      (await listOwnerAccounts(ownerUid)).map((a) => [a.key, a]),
    );
    const wanted = [...new Set(accounts)]
      .map(parseKey)
      .filter(Boolean)
      .map((p) => toKey(p.channel, p.account_id))
      .filter((k) => owned.has(k));

    // QR numbers keep living in agent_instances (the existing feature).
    const numbers = wanted.filter((k) => k.startsWith("qr:"));

    await query(`DELETE FROM agent_instances WHERE owner_uid = ? AND agent_uid = ?`, [
      ownerUid,
      agent_uid,
    ]).catch((err) => {
      if (err?.code !== "ER_NO_SUCH_TABLE") throw err;
    });

    const instances = numbers.length
      ? await query(`SELECT uniqueId, number FROM instance WHERE uid = ?`, [ownerUid])
      : [];
    const uniqueIdByNumber = new Map(
      instances.map((i) => [String(i.number || "").replace(/\D/g, ""), i.uniqueId]),
    );

    for (const key of numbers) {
      const number = key.slice(3);
      await query(
        `INSERT INTO agent_instances
           (owner_uid, agent_id, agent_uid, instance_number, instance_unique_id)
         VALUES (?,?,?,?,?)`,
        [ownerUid, agent.id, agent_uid, number, uniqueIdByNumber.get(number) || null],
      );
    }

    await setAgentAccounts({
      ownerUid,
      agentId: agent.id,
      agentUid: agent_uid,
      keys: wanted,
    });

    res.json({
      success: true,
      msg: `Saved. ${wanted.length} account(s) assigned.`,
      data: { agent_uid, accounts: wanted },
    });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- inbox filter --------------------------------------------- */

/** { role, uid, ownerUid } for an owner or agent token, else null. */
async function whoIs(req) {
  const header = req.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;

  let decoded;
  try {
    decoded = jwt.verify(header.split(" ")[1], process.env.JWTKEY);
  } catch {
    return null;
  }

  if (decoded?.role === "user" && decoded.uid) {
    const [user] = await query(
      `SELECT uid FROM user WHERE uid = ? AND role = 'user' LIMIT 1`,
      [decoded.uid],
    );
    return user ? { role: "user", uid: user.uid, ownerUid: user.uid } : null;
  }

  if (decoded?.role === "agent" && decoded.uid) {
    const [agent] = await query(
      `SELECT uid, owner_uid FROM agents WHERE uid = ? LIMIT 1`,
      [decoded.uid],
    );
    return agent ? { role: "agent", uid: agent.uid, ownerUid: agent.owner_uid } : null;
  }

  return null;
}

/** Accounts this user may filter by: all of them for an owner, assigned ones for an agent. */
async function filterOptions(who) {
  const all = await listOwnerAccounts(who.ownerUid);
  if (who.role === "user") return all;

  const mine = new Set(await getAgentAccountKeys(who.uid));
  return all.filter((a) => mine.has(a.key));
}

router.get("/filter", async (req, res) => {
  try {
    const who = await whoIs(req);
    if (!who) return res.json({ success: false, msg: "No token found" });

    const options = await filterOptions(who);
    const current = await getInboxFilter(who.uid);

    res.json({
      success: true,
      data: {
        options,
        current: current ? toKey(current.channel, current.account_id) : "",
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

/** Body: { account: "messenger:123" } or { account: "" } to show everything. */
router.post("/filter", async (req, res) => {
  try {
    const who = await whoIs(req);
    if (!who) return res.json({ success: false, msg: "No token found" });

    const key = String(req.body?.account || "");

    if (key) {
      const allowed = new Set((await filterOptions(who)).map((a) => a.key));
      if (!allowed.has(key)) {
        return res.json({ success: false, msg: "Account not available" });
      }
    }

    const saved = await setInboxFilter(who.uid, key || null);
    res.json({
      success: true,
      data: { current: saved ? toKey(saved.channel, saved.account_id) : "" },
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

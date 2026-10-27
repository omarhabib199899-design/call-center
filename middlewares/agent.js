const jwt = require("jsonwebtoken");
const { query } = require("../database/dbpromise");
const logger = require("../utils/logger");

const validateAgent = async (req, res, next) => {
  try {
    const authHeader = req.get("Authorization");

    // [CUSTOM] No `logout: true` here, matching middlewares/user.js.
    //
    // The compiled panel picks its token with
    //   localStorage.getItem(`wacrm${admin ? "_admin" : agent ? "_agent" : "_user"}`)
    // so any agent-panel call that forgets its `agent: true` flag looks up
    // `wacrm_user`, which does not exist in an agent's browser, and sends the
    // request with no Authorization header at all. Returning `logout: true`
    // then signed the agent out mid-conversation. The request still fails —
    // the agent just keeps their session.
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        msg: "No token found",
        // logout: true,
      });
    }

    const token = authHeader.split(" ")[1];

    let decode;
    try {
      decode = jwt.verify(token, process.env.JWTKEY);
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid token found",
        // [CUSTOM] no forced logout — see note above
        // logout: true,
      });
    }

    if (!decode?.uid || decode?.role !== "agent" || !decode?.owner_uid) {
      return res.status(401).json({
        success: false,
        msg: "Unauthorized token",
        // [CUSTOM] fires when the panel sends a user/admin token by mistake
        // logout: true,
      });
    }

    const [agent] = await query(
      `SELECT * FROM agents WHERE uid = ? AND owner_uid = ?`,
      [decode.uid, decode.owner_uid],
    );

    if (!agent) {
      return res.status(401).json({
        success: false,
        msg: "Invalid agent token",
        // [CUSTOM] a data problem, not a dead session
        // logout: true,
      });
    }

    // ✅ tokenVersion check — invalidates all old tokens on password change.
    //
    // [CUSTOM] Compare numerically and treat NULL/undefined as 0, matching
    // both the login route (which signs `tokenVersion ?? 0`) and
    // middlewares/user.js. A strict !== here logged agents out on every
    // request whenever agents.tokenVersion was NULL, because the token
    // carried 0 while the row carried null.
    if (
      typeof decode.tokenVersion !== "undefined" &&
      Number(agent.tokenVersion || 0) !== Number(decode.tokenVersion || 0)
    ) {
      return res.status(401).json({
        success: false,
        msg: "Session expired. Please login again.",
        logout: true,
      });
    }

    // [CUSTOM] Only treat an explicit 0 as deactivated. `null < 1` is true in
    // JS, so a NULL is_active used to lock the agent out of their own account.
    if (agent.is_active !== null && Number(agent.is_active) < 1) {
      return res.status(403).json({
        success: false,
        msg: "You are an inactive agent.",
        logout: true,
      });
    }

    const [owner] = await query(`SELECT * FROM user WHERE uid = ?`, [
      agent.owner_uid,
    ]);

    if (!owner) {
      return res.status(401).json({
        success: false,
        msg: "Agent owner not found",
        // [CUSTOM] a data problem, not a dead session
        // logout: true,
      });
    }

    req.owner = owner;

    req.decode = {
      uid: agent.uid,
      role: "agent",
      email: agent.email,
      owner_uid: agent.owner_uid,
      tokenVersion: agent.tokenVersion,
      userData: agent,
    };

    next();
  } catch (err) {
    logger.error("validateAgent error:", err);
    return res.status(500).json({
      success: false,
      msg: "server error",
    });
  }
};

module.exports = validateAgent;

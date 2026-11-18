/**
 * [CUSTOM] Daily counters for the Home dashboard ("Automation Performance").
 *
 * automation/automation.js calls logFlowRun() once each time an active
 * workflow handles an incoming message: ok = finished, failed = threw an error
 * or was stopped by the engine's timeout / loop protection.
 *
 * Fire-and-forget: never throws, never delays the workflow itself.
 */
const { query } = require("../database/dbpromise");

let ready = null;
function ensure() {
  if (!ready) {
    ready = query(`CREATE TABLE IF NOT EXISTS omni_flow_daily (
      owner_uid VARCHAR(191) NOT NULL,
      day DATE NOT NULL,
      flow_id VARCHAR(191) NOT NULL,
      ok_count INT NOT NULL DEFAULT 0,
      fail_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_uid, day, flow_id)
    )`).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

function logFlowRun({ uid, flowId, ok }) {
  if (!uid || !flowId) return;
  ensure()
    .then(() =>
      query(
        `INSERT INTO omni_flow_daily (owner_uid, day, flow_id, ok_count, fail_count) VALUES (?, CURDATE(), ?, ?, ?)
         ON DUPLICATE KEY UPDATE ok_count = ok_count + VALUES(ok_count), fail_count = fail_count + VALUES(fail_count)`,
        [uid, String(flowId), ok ? 1 : 0, ok ? 0 : 1],
      ),
    )
    .catch(() => {});
}

module.exports = { logFlowRun, ensure };

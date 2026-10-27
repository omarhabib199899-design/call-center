/**
 * In-memory record of the last webhook calls from Meta, so an owner can see
 * whether Facebook / Instagram events reach the server at all without
 * reading server logs. Shown at /webhook-status.html.
 *
 * Nothing is persisted and only ids and outcomes are kept, never message
 * text. The buffer resets on restart.
 */

const MAX = 100;
const entries = [];

/**
 * @param {object} e
 * @param {"instagram"|"messenger"} e.channel
 * @param {string} e.outcome   "accepted" | "bad_signature" | "unknown_account" | "ignored"
 * @param {string} [e.object]  body.object from Meta
 * @param {string} [e.entryId] entry[0].id (Page id or Instagram account id)
 * @param {string} [e.uid]     owner the event was matched to
 * @param {string[]} [e.fields] event kinds seen (messages, comments, ...)
 */
function record(e) {
  entries.unshift({ at: new Date().toISOString(), ...e });
  if (entries.length > MAX) entries.length = MAX;
}

/** Kinds of event in a Meta webhook body, for display. */
function fieldsOf(body) {
  const out = new Set();
  for (const entry of body?.entry || []) {
    if (entry.messaging?.length) out.add("messages");
    for (const c of entry.changes || []) if (c.field) out.add(c.field);
  }
  return [...out];
}

/**
 * Entries an owner may see: their own, plus ones that matched no account
 * (those are what explain "my messages don't arrive").
 */
function listFor(uid) {
  return entries.filter((e) => !e.uid || e.uid === uid);
}

module.exports = { record, fieldsOf, listFor };

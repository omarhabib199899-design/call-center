/**
 * Preload (node -r) that replaces Facebook/Instagram's Graph API with a fake.
 * Every call is appended as a JSON line to $FAKE_LOG so the test can assert on it.
 *
 * Scenario:  3 Facebook pages for one user
 *   1001  has an Instagram professional account  (@testig)
 *   1002  has none
 *   1003  Graph answers the Instagram lookup with an error
 * /me/accounts is paginated: pages 1001+1002 first, 1003 on the next cursor.
 */
const fs = require("fs");
const Module = require("module");

const LOG = process.env.FAKE_LOG;
const realFetch = globalThis.fetch;

function record(entry) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

function reply(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

async function fakeFetch(url, opts) {
  const u = String(url);

  if (!/graph\.(facebook|instagram)\.com/.test(u)) {
    return realFetch(url, opts);
  }

  const parsed = new URL(u);
  const path = parsed.pathname;
  const token = parsed.searchParams.get("access_token");
  record({
    host: parsed.host,
    path,
    method: (opts && opts.method) || "GET",
    token,
    query: Object.fromEntries(parsed.searchParams),
    body: opts && opts.body ? String(opts.body) : undefined,
  });

  if (path.endsWith("/oauth/access_token")) {
    if (parsed.searchParams.get("grant_type") === "fb_exchange_token") {
      return reply({ access_token: "LONGTOKEN", token_type: "bearer" });
    }
    return reply({ access_token: "SHORTTOKEN", token_type: "bearer" });
  }

  if (path.endsWith("/me/accounts")) {
    if (!parsed.searchParams.get("after")) {
      const next = new URL(u);
      next.searchParams.set("after", "cursor1");
      return reply({
        data: [
          { id: "1001", name: "Activato Shop", access_token: "PAGETOKEN_1001" },
          { id: "1002", name: "Nabina Football", access_token: "PAGETOKEN_1002" },
        ],
        paging: { next: next.toString() },
      });
    }
    return reply({
      data: [{ id: "1003", name: "Broken Page", access_token: "PAGETOKEN_1003" }],
    });
  }

  if (path.endsWith("/subscribed_apps")) return reply({ success: true });

  if (parsed.searchParams.get("fields")?.includes("instagram_business_account")) {
    if (path.endsWith("/1001")) {
      return reply({
        id: "1001",
        instagram_business_account: {
          id: "17841499999999999",
          username: "testig",
          name: "Test Instagram",
          profile_picture_url: "https://example.com/p.jpg",
        },
      });
    }
    if (path.endsWith("/1002")) return reply({ id: "1002" });
    return reply({ error: { message: "(#10) Application does not have permission" } });
  }

  if (path.endsWith("/messages")) return reply({ message_id: "mid.fake123" });

  return reply({});
}

// node-fetch is required by name in the app; the Instagram helper uses the global.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "node-fetch") return fakeFetch;
  return origLoad.apply(this, arguments);
};
globalThis.fetch = fakeFetch;

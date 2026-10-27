/** Ad attribution: extraction + storage. Run with cwd = the app directory. */
const path = require("path");
const APP = process.cwd();

require(path.join(APP, "node_modules/dotenv")).config({
  path: path.join(APP, ".env"),
});

const { query } = require(path.join(APP, "database/dbpromise"));
const ads = require(path.join(APP, "helper/adSource"));

const OWNER = "lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8";
let pass = 0,
  fail = 0;

function check(label, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || !extra ? "" : "  -> " + extra}`);
}

// --- realistic payloads ----------------------------------------------------

/** A customer taps a Click-to-WhatsApp ad and sends a text. */
const fromAd = {
  key: { remoteJid: "201111111111@s.whatsapp.net", fromMe: false },
  pushName: "Ahmed",
  message: {
    extendedTextMessage: {
      text: "مرحبا، عايز اعرف السعر",
      contextInfo: {
        externalAdReply: {
          title: "عروض الشتاء ٢٠٢٦",
          body: "خصم 40% على كل المنتجات",
          sourceType: "ad",
          sourceId: "120210987654321",
          sourceUrl: "https://fb.me/winter-sale",
          ctwaClid: "ARbX9fakeClickId",
          thumbnailUrl: "https://scontent.example/thumb.jpg",
          showAdAttribution: true,
        },
      },
    },
  },
};

/** An ordinary message with a link preview — same envelope, NOT an ad. */
const linkPreview = {
  key: { remoteJid: "201222222222@s.whatsapp.net", fromMe: false },
  pushName: "Normal",
  message: {
    extendedTextMessage: {
      text: "شوف ده https://example.com",
      contextInfo: {
        externalAdReply: {
          title: "Example Domain",
          body: "An ordinary page",
          thumbnailUrl: "https://example.com/t.png",
        },
      },
    },
  },
};

/** A plain text message. */
const plain = {
  key: { remoteJid: "201333333333@s.whatsapp.net", fromMe: false },
  pushName: "Plain",
  message: { conversation: "السلام عليكم" },
};

/** An image sent from an ad — the payload hangs off imageMessage instead. */
const imageFromAd = {
  key: { remoteJid: "201444444444@s.whatsapp.net", fromMe: false },
  pushName: "Mona",
  message: {
    imageMessage: {
      caption: "ده المنتج ده؟",
      contextInfo: {
        externalAdReply: {
          title: "تخفيضات رمضان",
          sourceId: "120299999999999",
          sourceUrl: "https://fb.me/ramadan",
          sourceType: "ad",
          showAdAttribution: true,
        },
      },
    },
  },
};

/** Meta Cloud API shape. */
const metaMsg = {
  from: "201555555555",
  referral: {
    headline: "Cloud API Campaign",
    body: "Official WhatsApp ad",
    source_type: "ad",
    source_id: "120255555555555",
    source_url: "https://fb.me/cloud",
    ctwa_clid: "CLOUDclid",
  },
};

(async () => {
  console.log("\n=== extraction ===");

  const a = ads.fromBaileys(fromAd);
  check("reads a text message sent from an ad", !!a);
  check("  ad id", a && a.source_id === "120210987654321", a && a.source_id);
  check("  ad title", a && a.ad_title === "عروض الشتاء ٢٠٢٦", a && a.ad_title);
  check("  click id", a && a.ctwa_clid === "ARbX9fakeClickId");
  check("  origin tagged qr", a && a.origin === "qr");

  const img = ads.fromBaileys(imageFromAd);
  check("reads an image sent from an ad", !!img && img.source_id === "120299999999999");

  check("ignores an ordinary link preview", ads.fromBaileys(linkPreview) === null);
  check("ignores a plain message", ads.fromBaileys(plain) === null);
  check("survives a malformed message", ads.fromBaileys({}) === null);
  check("survives null", ads.fromBaileys(null) === null);

  const m = ads.fromMeta(metaMsg);
  check("reads a Meta Cloud referral", !!m && m.source_id === "120255555555555");
  check("  maps headline to title", m && m.ad_title === "Cloud API Campaign");
  check("  origin tagged meta", m && m.origin === "meta");
  check("ignores a Meta message with no referral", ads.fromMeta({ from: "1" }) === null);

  console.log("\n=== storage ===");
  await query(`DELETE FROM chat_ad_source WHERE uid = ?`, [OWNER]);

  const stored = await ads.captureFromBaileys({
    body: fromAd,
    uid: OWNER,
    chatId: "testchat_ad_1",
  });
  check("stores the referral", stored === true);

  const again = await ads.captureFromBaileys({
    body: fromAd,
    uid: OWNER,
    chatId: "testchat_ad_1",
  });
  check("same customer + same ad is not double counted", again === false);

  await ads.captureFromBaileys({
    body: imageFromAd,
    uid: OWNER,
    chatId: "testchat_ad_2",
  });

  const rows = await query(
    `SELECT sender_mobile, sender_name, source_id, ad_title, origin
       FROM chat_ad_source WHERE uid = ? ORDER BY id`,
    [OWNER],
  );
  check("two distinct customers recorded", rows.length === 2, rows.length + " rows");
  check("  number captured", rows[0] && rows[0].sender_mobile === "201111111111", rows[0] && rows[0].sender_mobile);
  check("  name captured", rows[0] && rows[0].sender_name === "Ahmed");
  check("  arabic title survives the round trip", rows[0] && rows[0].ad_title === "عروض الشتاء ٢٠٢٦", rows[0] && rows[0].ad_title);

  const summary = await query(
    `SELECT source_id, COUNT(DISTINCT chat_id) AS customers
       FROM chat_ad_source WHERE uid = ? GROUP BY source_id`,
    [OWNER],
  );
  check("report groups by ad", summary.length === 2, summary.length + " ads");

  console.log("\n=== cleanup ===");
  await query(`DELETE FROM chat_ad_source WHERE uid = ?`, [OWNER]);
  console.log("  test rows removed");

  console.log("\n==============================");
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  console.log("==============================\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});

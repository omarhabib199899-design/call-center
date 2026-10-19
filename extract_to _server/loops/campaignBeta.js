const { query } = require("../database/dbpromise");
const { sendTemplateMessage } = require("../functions/function");
const moment = require("moment-timezone");
const logger = require("../utils/logger");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Simple processing flags
const processingCampaigns = new Set();

// Configuration
const CONFIG = {
  batchSize: 20,
  checkInterval: 30000,
  messageDelay: 800,
  maxRetries: 3,
  retryDelay: 5000,
};

// ✅ API version
const META_API_VERSION = "v21.0";

// ✅ Disable keep-alive so we never reuse a stale/dead socket from the pool.
// This is the fix for "Invalid response body... Premature close".
const httpsAgent = new https.Agent({ keepAlive: false });

// ✅ Helper: fetch with 15s timeout — used by sendCarouselTemplateMessage /
// sendCatalogTemplateMessage defined in THIS file. (sendTemplateMessage now
// lives in function.js and uses its own fixed fetchWithTimeout there.)
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const logToFile = (content) => {};

  logToFile(
    `OUTGOING REQUEST\nURL: ${url}\nMethod: ${options?.method || "GET"}\nHeaders: ${JSON.stringify(options?.headers || {}, null, 2)}\nBody: ${options?.body || "(none)"}`,
  );

  try {
    const response = await fetch(url, {
      ...options,
      agent: httpsAgent, // 👈 forced fresh connection every time
      signal: controller.signal,
    });

    const rawText = await response.text();

    logToFile(
      `RESPONSE\nURL: ${url}\nStatus: ${response.status} ${response.statusText}\nBody: ${rawText}`,
    );

    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: response.headers,
      text: async () => rawText,
      json: async () => {
        try {
          return JSON.parse(rawText);
        } catch (e) {
          logToFile(
            `JSON PARSE ERROR\nURL: ${url}\nError: ${e.message}\nRaw: ${rawText}`,
          );
          throw new Error(`Non-JSON response: ${rawText}`);
        }
      },
    };
  } catch (error) {
    logToFile(`FETCH ERROR\nURL: ${url}\nError: ${error.message}`);
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ✅ Retry wrapper for transient network errors (Premature close, ECONNRESET, etc.)
// Used here for carousel/catalog sends. sendTemplateMessage already has its
// own retry wrapper inside function.js.
const TRANSIENT_ERROR_PATTERNS = [
  "premature close",
  "econnreset",
  "socket hang up",
  "network",
  "timed out",
];

function isTransientError(message = "") {
  const lower = message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

async function sendWithRetry(
  sendFn,
  maxRetries = CONFIG.maxRetries,
  retryDelay = CONFIG.retryDelay,
) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await sendFn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isTransientError(error.message)) {
        logger.error(
          `Transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${retryDelay}ms...`,
        );
        await new Promise((r) => setTimeout(r, retryDelay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function hasDatePassedInTimezone(timezone, date) {
  const tz = timezone || "UTC";
  const momentDate = moment.tz(date, tz);
  const currentMoment = moment.tz(tz);
  return momentDate.isBefore(currentMoment);
}

async function initCampaign() {
  await handleLegacyCampaigns();

  const interval = setInterval(async () => {
    try {
      await processPendingCampaigns();
    } catch (error) {
      logger.error("Error in campaign processing loop:", error);
    }
  }, CONFIG.checkInterval);

  setTimeout(() => processPendingCampaigns(), 1000);

  return interval;
}

async function handleLegacyCampaigns() {
  try {
    const legacyCampaigns = await query(
      `SELECT c.campaign_id, c.title, c.schedule, c.timezone
       FROM beta_campaign c
       LEFT JOIN beta_campaign_logs l ON c.campaign_id = l.campaign_id
       WHERE c.status IN ('PENDING', 'IN_PROGRESS')
       AND l.campaign_id IS NULL
       AND (c.schedule IS NULL OR CAST(c.schedule AS CHAR) = '')`,
      [],
    );

    if (legacyCampaigns.length > 0) {
      for (const campaign of legacyCampaigns) {
        await query(
          `UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?`,
          [campaign.campaign_id],
        );
      }
    }
  } catch (error) {
    logger.error("Error handling legacy campaigns:", error);
  }
}

async function processPendingCampaigns() {
  try {
    const campaigns = await query(
      `SELECT * FROM beta_campaign 
       WHERE (status = 'PENDING' OR status = 'IN_PROGRESS')
       ORDER BY createdAt ASC
       LIMIT 10`,
      [],
    );

    if (!campaigns || campaigns.length === 0) return;

    for (const campaign of campaigns) {
      if (campaign.schedule) {
        const tz = campaign.timezone || "UTC";
        if (!hasDatePassedInTimezone(tz, campaign.schedule)) continue;
      }

      if (processingCampaigns.has(campaign.campaign_id)) continue;

      processingCampaigns.add(campaign.campaign_id);

      try {
        await processSingleCampaign(campaign);
      } catch (error) {
        logger.error(
          `Error processing campaign ${campaign.campaign_id}:`,
          error,
        );
      } finally {
        processingCampaigns.delete(campaign.campaign_id);
      }
    }
  } catch (error) {
    logger.error("Error in processPendingCampaigns:", error);
  }
}

async function sendCarouselTemplateMessage(
  apiVersion,
  phoneNumberId,
  accessToken,
  templateName,
  language,
  recipientPhone,
  globalBodyVariables = [],
  cards = [],
) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const components = [];

  if (globalBodyVariables.length > 0) {
    components.push({
      type: "body",
      parameters: globalBodyVariables.map((v) => ({
        type: "text",
        text: String(v || ""),
      })),
    });
  }

  const builtCards = cards.map((card, index) => {
    const cardComponents = [];

    if (card.imageUrl) {
      cardComponents.push({
        type: "header",
        parameters: [{ type: "image", image: { link: card.imageUrl } }],
      });
    }

    if (card.bodyVariables?.length > 0) {
      cardComponents.push({
        type: "body",
        parameters: card.bodyVariables.map((v) => ({
          type: "text",
          text: String(v || ""),
        })),
      });
    }

    if (card.buttonVariables?.length > 0) {
      card.buttonVariables.forEach((bv, bi) => {
        cardComponents.push({
          type: "button",
          sub_type: "url",
          index: String(bv.index ?? bi),
          parameters: [{ type: "text", text: String(bv.value || bv || "") }],
        });
      });
    }

    return { card_index: index, components: cardComponents };
  });

  if (builtCards.length > 0) {
    components.push({ type: "carousel", cards: builtCards });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: recipientPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      15000,
    );
    return await response.json();
  } catch (error) {
    logger.error("Error sending carousel template:", error);
    throw error;
  }
}

async function sendCatalogTemplateMessage(
  apiVersion,
  phoneNumberId,
  accessToken,
  templateName,
  language,
  recipientPhone,
  bodyVariables = [],
  thumbnailProductRetailerId = null,
) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const components = [];

  if (bodyVariables.length > 0) {
    components.push({
      type: "body",
      parameters: bodyVariables.map((v) => ({
        type: "text",
        text: String(v || ""),
      })),
    });
  }

  components.push({
    type: "button",
    sub_type: "CATALOG",
    index: 0,
    parameters: [
      {
        type: "action",
        action: thumbnailProductRetailerId
          ? { thumbnail_product_retailer_id: thumbnailProductRetailerId }
          : {},
      },
    ],
  });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipientPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      15000,
    );
    return await response.json();
  } catch (error) {
    logger.error("Error sending catalog template:", error);
    throw error;
  }
}

async function processSingleCampaign(campaign) {
  if (campaign.status === "PENDING") {
    await query(
      "UPDATE beta_campaign SET status = 'IN_PROGRESS' WHERE campaign_id = ?",
      [campaign.campaign_id],
    );
  }

  const pendingLogs = await query(
    `SELECT * FROM beta_campaign_logs 
     WHERE campaign_id = ? AND status = 'PENDING'
     ORDER BY id ASC LIMIT ?`,
    [campaign.campaign_id, CONFIG.batchSize],
  );

  if (!pendingLogs || pendingLogs.length === 0) {
    await checkAndMarkCampaignComplete(campaign);
    return;
  }

  const metaCredentials = await query(
    "SELECT * FROM meta_api WHERE uid = ? LIMIT 1",
    [campaign.uid],
  );

  if (!metaCredentials || metaCredentials.length === 0) {
    await query(
      `UPDATE beta_campaign_logs 
       SET status = 'FAILED', error_message = 'Meta API credentials not found'
       WHERE campaign_id = ? AND status = 'PENDING'`,
      [campaign.campaign_id],
    );
    await updateCampaignCounts(campaign.campaign_id);
    await checkAndMarkCampaignComplete(campaign);
    return;
  }

  let bodyVariables = [];
  let headerVariable = null;
  let buttonVariables = [];

  try {
    bodyVariables = (
      campaign.body_variables ? JSON.parse(campaign.body_variables) : []
    ).map((v) => String(v ?? ""));
    headerVariable = campaign.header_variable
      ? JSON.parse(campaign.header_variable)
      : null;
    buttonVariables = campaign.button_variables
      ? JSON.parse(campaign.button_variables)
      : [];
  } catch (e) {
    logger.error(`Error parsing campaign variables: ${e.message}`);
  }

  const templateType =
    campaign.template_type ||
    (headerVariable?.type === "CAROUSEL"
      ? "CAROUSEL"
      : headerVariable?.type === "CATALOG"
        ? "CATALOG"
        : "STANDARD");

  const credentials = metaCredentials[0];
  const successfulIds = [];
  const failedUpdates = [];

  for (const log of pendingLogs) {
    try {
      const contact = await getContactForLog(log, campaign);
      let result;

      if (templateType === "CAROUSEL") {
        const cards = (headerVariable.cards || []).map((card) => ({
          imageUrl: card.imageUrl,
          bodyVariables: replaceContactVariables(
            card.bodyVariables || [],
            contact,
          ),
          buttonVariables: replaceContactVariables(
            card.buttonVariables || [],
            contact,
          ),
        }));

        result = await sendWithRetry(() =>
          sendCarouselTemplateMessage(
            META_API_VERSION,
            credentials.business_phone_number_id,
            credentials.access_token,
            campaign.template_name,
            campaign.template_language,
            log.contact_mobile,
            replaceContactVariables(bodyVariables, contact),
            cards,
          ),
        );
      } else if (templateType === "CATALOG") {
        result = await sendWithRetry(() =>
          sendCatalogTemplateMessage(
            META_API_VERSION,
            credentials.business_phone_number_id,
            credentials.access_token,
            campaign.template_name,
            campaign.template_language,
            log.contact_mobile,
            replaceContactVariables(bodyVariables, contact),
            headerVariable.thumbnail || null,
          ),
        );
      } else {
        const processedBodyVars = replaceContactVariables(
          bodyVariables,
          contact,
        );
        const processedHeaderVar = replaceContactVariable(
          headerVariable,
          contact,
        );
        const processedButtonVars = replaceContactVariables(
          buttonVariables,
          contact,
        );

        // ✅ Log what we're about to send for STANDARD template
        const logPayload = {
          apiVersion: META_API_VERSION,
          phoneNumberId: credentials.business_phone_number_id,
          templateName: campaign.template_name,
          language: campaign.template_language,
          to: log.contact_mobile,
          bodyVariables: processedBodyVars,
          headerVariable: processedHeaderVar,
          buttonVariables: processedButtonVars,
        };
        const timestamp = new Date().toISOString();
        fs.appendFileSync(
          path.join(__dirname, "f.txt"),
          `[${timestamp}]\nSTANDARD TEMPLATE CALL\n${JSON.stringify(logPayload, null, 2)}\n${"=".repeat(60)}\n`,
          "utf8",
        );

        // ✅ sendTemplateMessage is imported from function.js — it already
        // has the httpsAgent fix + its own internal retry wrapper baked in,
        // so no need to wrap it in sendWithRetry again here.
        result = await sendTemplateMessage(
          META_API_VERSION,
          credentials.business_phone_number_id,
          credentials.access_token,
          campaign.template_name,
          campaign.template_language,
          log.contact_mobile,
          replaceContactVariables(bodyVariables, contact),
          replaceContactVariable(headerVariable, contact),
          replaceContactVariables(buttonVariables, contact),
        );
      }

      if (result && result.messages && result.messages.length > 0) {
        successfulIds.push({ id: log.id, messageId: result.messages[0].id });
      } else {
        const errorMsg = result?.error?.message || "No message ID returned";
        failedUpdates.push({ id: log.id, error: errorMsg });
      }

      await new Promise((resolve) => setTimeout(resolve, CONFIG.messageDelay));
    } catch (error) {
      logger.error(`Error sending to ${log.contact_mobile}:`, error.message);
      failedUpdates.push({ id: log.id, error: error.message });
    }
  }

  for (const success of successfulIds) {
    await query(
      `UPDATE beta_campaign_logs 
       SET status = 'SENT', meta_msg_id = ?, delivery_time = NOW()
       WHERE id = ?`,
      [success.messageId, success.id],
    );
  }

  for (const failed of failedUpdates) {
    await query(
      `UPDATE beta_campaign_logs 
       SET status = 'FAILED', error_message = ?
       WHERE id = ?`,
      [failed.error, failed.id],
    );
  }

  await updateCampaignCounts(campaign.campaign_id);
  await checkAndMarkCampaignComplete(campaign);
}

async function getContactForLog(log, campaign) {
  const contacts = await query(
    `SELECT * FROM contact 
     WHERE mobile = ? AND uid = ? AND phonebook_id = ?
     LIMIT 1`,
    [log.contact_mobile, campaign.uid, campaign.phonebook_id],
  );

  if (contacts && contacts.length > 0) return contacts[0];

  return {
    name: log.contact_name,
    mobile: log.contact_mobile,
    var1: "",
    var2: "",
    var3: "",
    var4: "",
    var5: "",
  };
}

async function updateCampaignCounts(campaignId) {
  try {
    await query(
      `UPDATE beta_campaign SET
        sent_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'SENT'),
        failed_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'FAILED'),
        delivered_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND delivery_status = 'delivered'),
        read_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND delivery_status = 'read')
       WHERE campaign_id = ?`,
      [campaignId, campaignId, campaignId, campaignId, campaignId],
    );
  } catch (error) {
    logger.error(`Error updating campaign counts for ${campaignId}:`, error);
  }
}

async function checkAndMarkCampaignComplete(campaign) {
  const [pendingCount] = await query(
    `SELECT COUNT(*) as count FROM beta_campaign_logs 
     WHERE campaign_id = ? AND status = 'PENDING'`,
    [campaign.campaign_id],
  );

  const [totalLogsCount] = await query(
    `SELECT COUNT(*) as count FROM beta_campaign_logs 
     WHERE campaign_id = ?`,
    [campaign.campaign_id],
  );

  if (pendingCount.count === 0 || totalLogsCount.count === 0) {
    await query(
      "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
      [campaign.campaign_id],
    );
  }
}

function replaceContactVariables(variables, contact) {
  if (!Array.isArray(variables)) return variables;
  return variables.map((variable) => replaceContactVariable(variable, contact));
}

function replaceContactVariable(variable, contact) {
  if (typeof variable !== "string") return variable;

  let result = variable.replace(/\{\{\{name\}\}\}/g, contact.name || "");
  result = result.replace(/\{\{\{mobile\}\}\}/g, contact.mobile || "");

  for (let i = 1; i <= 5; i++) {
    const pattern = new RegExp(`\\{\\{\\{var${i}\\}\\}\\}`, "g");
    result = result.replace(pattern, contact[`var${i}`] || "");
  }

  return result;
}

async function updateMessageStatus(metaMsgId, status, errorMessage = null) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const logs = await query(
      "SELECT * FROM beta_campaign_logs WHERE meta_msg_id = ? LIMIT 1",
      [metaMsgId],
    );

    if (!logs || logs.length === 0) return;

    const log = logs[0];

    if (log.delivery_status === "read" && status === "delivered") return;

    await query(
      `UPDATE beta_campaign_logs 
       SET delivery_status = ?, delivery_time = NOW(), error_message = ?
       WHERE meta_msg_id = ?`,
      [status, errorMessage, metaMsgId],
    );

    await updateCampaignCounts(log.campaign_id);
  } catch (error) {
    logger.error(`Error updating message status for ${metaMsgId}:`, error);
  }
}

module.exports = {
  initCampaign,
  updateMessageStatus,
  sendCarouselTemplateMessage,
  sendCatalogTemplateMessage,
};

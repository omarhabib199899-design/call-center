const axios = require("axios");
const { query } = require("../../../database/dbpromise");
const logger = require("../../../utils/logger");

function checkEmbed() {
  return true;
}

async function registerPhoneNumber({ token, phoneNumId, pin }) {
  logger.log("registerPhoneNumber called with:", { phoneNumId, pin });
  logger.warn("registerPhoneNumber should not be called in coexistence mode");

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v24.0/${phoneNumId}/register`,
      {
        messaging_product: "whatsapp",
        pin: pin,
      },
      {
        params: {
          access_token: token,
        },
      },
    );

    return { success: true, data: response.data };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err?.toString();

    logger.error("Registration error:", errorMsg);

    // Check if already registered
    if (
      errorMsg.includes("already registered") ||
      errorMsg.includes("Register endpoint is not available for SMB businesses")
    ) {
      return { success: true, alreadyRegistered: true };
    }

    return {
      success: false,
      msg: errorMsg,
    };
  }
}

// Get phone number status with coexistence info
async function getPhoneNumberStatus({ token, phoneNumId }) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v24.0/${phoneNumId}`,
      {
        params: {
          fields:
            "name_status,display_phone_number,verified_name,is_on_biz_app,platform_type,quality_rating",
          access_token: token,
        },
      },
    );

    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      msg: err.response?.data?.error?.message || err?.toString(),
    };
  }
}

// Subscribe to webhook
async function subscribeWebhook({ token, wabaId }) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v24.0/${wabaId}/subscribed_apps`,
      {},
      {
        params: {
          access_token: token,
        },
      },
    );

    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      msg: err.response?.data?.error?.message || err?.toString(),
    };
  }
}

// Get WABA details
async function getWABADetails({ token, wabaId }) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v24.0/${wabaId}`,
      {
        params: {
          fields: [
            "id",
            "name",
            "currency",
            "timezone_id",
            "business_verification_status",
            "account_review_status",
            "owner_business_info{name,id}",
          ].join(","),
          access_token: token,
        },
      },
    );

    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      msg: err.response?.data?.error?.message || err?.toString(),
    };
  }
}

async function exchangeEmbedToken({
  appId,
  appSecret,
  authCode,
  wabaId,
  phoneNumId,
  businessId,
  registrationPin = "123456",
  isCoexistence = false,
}) {
  try {
    logger.log("exchangeEmbedToken START");
    logger.log("isCoexistence:", isCoexistence);

    // Step 1: Exchange token
    logger.log("📝 Step 1: Exchanging auth code for access token...");
    const response = await axios.post(
      "https://graph.facebook.com/v24.0/oauth/access_token",
      {
        client_id: appId,
        client_secret: appSecret,
        code: authCode,
        grant_type: "authorization_code",
      },
    );

    if (!response.data.access_token) {
      return { success: false, msg: "Failed to exchange token" };
    }

    const token = response.data.access_token;
    logger.log("✅ Step 1 complete: Token obtained");

    // Step 2: Get WABA details
    logger.log("📝 Step 2: Fetching WABA details...");
    const waba = await getWABADetails({ token, wabaId });
    if (!waba.success) {
      return {
        success: false,
        msg: waba.msg || "Failed to fetch WABA details",
      };
    }
    logger.log("✅ Step 2 complete: WABA details fetched");

    // Step 3: Check phone number status
    logger.log("📝 Step 3: Checking phone number status...");
    const phoneStatus = await getPhoneNumberStatus({ token, phoneNumId });
    if (!phoneStatus.success) {
      return {
        success: false,
        msg: "Failed to fetch phone number details",
      };
    }

    const nameStatus = phoneStatus.data.name_status;
    const isOnBizApp = phoneStatus.data.is_on_biz_app;
    const platformType = phoneStatus.data.platform_type;

    logger.log("✅ Step 3 complete:", {
      nameStatus,
      isOnBizApp,
      platformType,
    });

    // Step 4: Register phone number (CRITICAL CHECK)
    logger.log("📝 Step 4: Phone registration check...");

    const shouldSkipRegistration =
      isCoexistence === true || isCoexistence === "true" || isCoexistence === 1;

    logger.log("   - shouldSkipRegistration:", shouldSkipRegistration);

    if (shouldSkipRegistration) {
      logger.log(
        "✅ Step 4: SKIPPED (coexistence mode - phone already registered on mobile app)",
      );
    } else {
      logger.log("📞 Step 4: Registering phone number...");

      const registration = await registerPhoneNumber({
        token,
        phoneNumId,
        pin: registrationPin,
      });

      if (!registration.success) {
        if (
          registration.msg &&
          registration.msg.includes(
            "Register endpoint is not available for SMB businesses",
          )
        ) {
          logger.log(
            "⚠️ SMB business detected - this is a coexistence account",
          );
          // Continue without failing
        } else {
          return {
            success: false,
            msg: registration.msg,
          };
        }
      }

      if (registration.alreadyRegistered) {
        logger.log("✅ Step 4: Phone already registered");
      } else {
        logger.log("✅ Step 4: Phone registration complete");
      }
    }

    // Step 5: Validate name status (skip for coexistence)
    logger.log("📝 Step 5: Name status validation...");

    if (
      !shouldSkipRegistration &&
      nameStatus !== "APPROVED" &&
      nameStatus !== "AVAILABLE_WITHOUT_REVIEW"
    ) {
      let errorMsg = "";

      switch (nameStatus) {
        case "PENDING":
          errorMsg =
            "Display name verification is pending. Please wait for Meta approval (24-48 hours) and try again.";
          break;
        case "DECLINED":
          errorMsg =
            "Display name was declined by Meta. Please update your display name in Meta Business Manager and try again.";
          break;
        case "NONE":
        case "UNVERIFIED":
          errorMsg =
            "Phone number is not verified. Please complete verification in Meta Business Manager first.";
          break;
        default:
          errorMsg = `Phone number status is ${nameStatus}. Only approved numbers can be added.`;
      }

      return {
        success: false,
        msg: errorMsg,
      };
    }
    logger.log("✅ Step 5: Name status OK or skipped");

    // Step 6: Subscribe to webhook
    logger.log("📝 Step 6: Subscribing to webhooks...");
    const webhook = await subscribeWebhook({ token, wabaId });
    if (!webhook.success) {
      logger.warn("Webhook subscription failed:", webhook.msg);
    } else {
      logger.log("✅ Step 6: Webhooks subscribed");
    }

    // Step 7: Return success
    const obj = {
      token: token,
      authCode: authCode,
      waba: waba.data,
      phoneNumId: phoneNumId,
      businessId: businessId,
      phoneDetails: phoneStatus.data,
      webhookSubscribed: webhook.success,
      isCoexistence: shouldSkipRegistration, // Use the boolean we calculated
      isOnBizApp: isOnBizApp,
      platformType: platformType,
    };

    logger.log("✅ exchangeEmbedToken COMPLETE:", {
      wabaId: obj.waba.id,
      phoneNumId: obj.phoneNumId,
      isCoexistence: obj.isCoexistence,
      platformType: obj.platformType,
    });

    return { success: true, data: obj };
  } catch (err) {
    logger.error("❌ exchangeEmbedToken ERROR:", err);
    logger.error("   Error details:", err.response?.data || err.message);
    return {
      success: false,
      msg: err.response?.data?.error?.message || err?.toString(),
    };
  }
}

async function genEmbedWebhook(params) {
  try {
    const [admin] = await query(`SELECT * FROM admin LIMIT 1`, []);
    const webhook = `${process.env.FRONTENDURI}/api/inbox/embed/webhook/${admin?.uid}`;
    return webhook;
  } catch (err) {
    return null;
  }
}

// Add new webhook fields subscription function
async function subscribeToCoexistenceWebhooks({ token, wabaId }) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v24.0/${wabaId}/subscribed_apps`,
      {},
      {
        params: {
          access_token: token,
        },
      },
    );

    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      msg: err.response?.data?.error?.message || err?.toString(),
    };
  }
}

module.exports = { checkEmbed, exchangeEmbedToken, genEmbedWebhook };

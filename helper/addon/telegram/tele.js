const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { query } = require("../../../database/dbpromise");
const logger = require("../../../utils/logger");

// Store active clients in memory
const activeClients = new Map();

// Store pending auth clients
const pendingClients = new Map();

// Store session metadata
const sessionMetadata = new Map();

// Error message mapper
function getErrorMessage(error) {
  const errorStr = error.message || error.toString();

  const errorMap = {
    PHONE_CODE_INVALID: "Invalid verification code. Please try again.",
    PHONE_CODE_EXPIRED: "Verification code expired. Please request a new code.",
    PHONE_NUMBER_INVALID: "Invalid phone number format.",
    SESSION_PASSWORD_NEEDED:
      "Two-factor authentication enabled. Password required.",
    AUTH_KEY_UNREGISTERED: "Session expired. Please create a new session.",
    USER_DEACTIVATED: "This account has been deactivated.",
    PHONE_NUMBER_BANNED: "This phone number is banned from Telegram.",
    TIMEOUT: "Connection timeout. Please try again.",
    FLOOD_WAIT: "Too many requests. Please wait a moment.",
  };

  for (const [key, message] of Object.entries(errorMap)) {
    if (errorStr.includes(key)) {
      return message;
    }
  }

  return errorStr;
}

// Get user profile info
async function getUserProfile(client) {
  try {
    const me = await client.getMe();
    return {
      id: me.id?.toString(),
      firstName: me.firstName || "",
      lastName: me.lastName || "",
      username: me.username || "",
      phone: me.phone || "",
      number: me.id?.toString(),
      isPremium: me.premium || false,
      isBot: me.bot || false,
    };
  } catch (error) {
    logger.error("Failed to get profile:", getErrorMessage(error));
    return null;
  }
}

// Setup message listener (centralized)
function setupMessageListener(client, title, sessionId) {
  const handler = async (event) => {
    try {
      const message = event.message;

      // Skip if no message text and no media
      if (!message.text && !message.media) {
        return;
      }

      // Extract uid from sessionId
      const uid = sessionId ? sessionId.split("_")[0] : null;

      if (!uid) {
        logger.error("Invalid session ID format:", sessionId);
        return;
      }

      const { processMessage } = require("../../inbox/inbox");
      // Use the unified processMessage function (just like Baileys)
      await processMessage({
        body: message,
        uid: uid,
        origin: "telegram",
        getSession: (sid) => activeClients.get(sid),
        sessionId: sessionId,
        qrType: "upsert",
      });
    } catch (error) {
      logger.error(`Message handler error [${title}]:`, error.message);
      logger.error(error.stack);
    }
  };

  client.addEventHandler(handler, new NewMessage({}));
}

function getSession(sid) {
  return activeClients.get(sid);
}

// Initialize all sessions on app start
async function initTele() {
  try {
    logger.log("Initializing Telegram sessions...");

    const sessions = await query(
      "SELECT * FROM telegram_session WHERE status = ?",
      ["active"],
    );

    let successCount = 0;
    let failCount = 0;

    for (const session of sessions) {
      try {
        await connectSession(session.session_id, false);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error(
          `Failed to init session ${session.title}:`,
          getErrorMessage(error),
        );

        await query(
          "UPDATE telegram_session SET status = ? WHERE session_id = ?",
          ["inactive", session.session_id],
        ).catch(() => {});
      }
    }

    logger.log(`Initialized ${successCount} Telegram sessions`);
    if (failCount > 0) {
      logger.log(`${failCount} sessions marked as inactive`);
    }
  } catch (error) {
    logger.error("Telegram init error:", getErrorMessage(error));
  }
}

// Update connectSession function
async function connectSession(sessionId, isNew = false) {
  let sessionData = null;

  try {
    if (activeClients.has(sessionId)) {
      return { success: true, message: "Already connected" };
    }

    [sessionData] = await query(
      "SELECT * FROM telegram_session WHERE session_id = ?",
      [sessionId],
    );

    if (!sessionData) {
      throw new Error("Session not found");
    }

    // Changed: Now reading from 'session' column instead of 'data'
    if (!sessionData.session || sessionData.session.trim() === "") {
      throw new Error("Invalid session string - empty or null");
    }

    // Use api_id and api_hash from the session record
    const apiId = sessionData.api_id;
    const apiHash = sessionData.api_hash;

    if (!apiId || !apiHash) {
      throw new Error("Telegram API credentials not found in session");
    }

    const session = new StringSession(sessionData.session);
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
      connectionRetries: 3,
      timeout: 10000,
      autoReconnect: true,
      useWSS: false,
    });

    client.setLogLevel("none");

    await client.connect();

    const profile = await getUserProfile(client);
    if (profile) {
      sessionMetadata.set(sessionId, {
        ...profile,
        title: sessionData.title,
        connectedAt: new Date().toISOString(),
      });

      // Update 'data' column with profile metadata
      await query("UPDATE telegram_session SET data = ? WHERE session_id = ?", [
        JSON.stringify(profile),
        sessionId,
      ]).catch(() => {});
    }

    setupMessageListener(client, sessionData.title, sessionId);
    activeClients.set(sessionId, client);

    await query("UPDATE telegram_session SET status = ? WHERE session_id = ?", [
      "active",
      sessionId,
    ]);

    logger.log(`Connected: ${sessionData.title} (${sessionId})`);
    return { success: true, message: "Connected successfully" };
  } catch (error) {
    logger.error(`Connect error for ${sessionId}:`, getErrorMessage(error));

    const errorMessage = getErrorMessage(error);

    if (sessionData) {
      await query(
        "UPDATE telegram_session SET status = ? WHERE session_id = ?",
        [`failed:${errorMessage}`, sessionId],
      ).catch(() => {});
    }

    if (activeClients.has(sessionId)) {
      const client = activeClients.get(sessionId);
      try {
        await client.disconnect();
      } catch (e) {}
      activeClients.delete(sessionId);
    }

    throw error;
  }
}

// Update createSession function
async function createSession(
  uid,
  title,
  phoneNumber,
  sessionId,
  apiId,
  apiHash,
) {
  try {
    // Now accepting apiId and apiHash as parameters
    if (!apiId || !apiHash) {
      throw new Error("Telegram API credentials are required");
    }

    const [existing] = await query(
      "SELECT * FROM telegram_session WHERE session_id = ?",
      [sessionId],
    );

    if (existing) {
      if (
        existing.status === "failed" ||
        existing.status?.startsWith("failed:") ||
        existing.status === "pending_otp"
      ) {
        await query("DELETE FROM telegram_session WHERE session_id = ?", [
          sessionId,
        ]);

        if (pendingClients.has(sessionId)) {
          const { client } = pendingClients.get(sessionId);
          try {
            await client.disconnect();
          } catch (e) {}
          pendingClients.delete(sessionId);
        }
      } else {
        throw new Error(
          "Session already exists with status: " + existing.status,
        );
      }
    }

    // Insert with api_id, api_hash, and empty session/data
    await query(
      `INSERT INTO telegram_session 
       (uid, status, session_id, title, session, data) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uid, "pending_otp", sessionId, title, "", ""],
    );

    const session = new StringSession("");
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
      connectionRetries: 5,
      deviceModel: title || "WaCrm",
      appVersion: "1.0.0",
      autoReconnect: false,
    });

    client.setLogLevel("none");

    await client.connect();

    const result = await client.sendCode(
      {
        apiId: parseInt(apiId),
        apiHash: apiHash,
      },
      phoneNumber,
    );

    pendingClients.set(sessionId, {
      client,
      phoneNumber,
      phoneCodeHash: result.phoneCodeHash,
      uid,
      title,
      apiId: apiId,
      apiHash: apiHash,
    });

    logger.log(`OTP sent to ${phoneNumber} for session ${sessionId}`);

    return {
      success: true,
      sessionId,
      status: "pending_otp",
      message: "OTP sent to your Telegram. Use /verify endpoint with code.",
    };
  } catch (error) {
    logger.error("Create session error:", getErrorMessage(error));

    const errorMessage = getErrorMessage(error);

    if (sessionId) {
      await query(
        "UPDATE telegram_session SET status = ? WHERE session_id = ?",
        [`failed:${errorMessage}`, sessionId],
      ).catch(() => {});

      if (pendingClients.has(sessionId)) {
        const { client } = pendingClients.get(sessionId);
        try {
          await client.disconnect();
        } catch (e) {}
        pendingClients.delete(sessionId);
      }
    }

    const error_obj = new Error(errorMessage);
    error_obj.userMessage = errorMessage;
    throw error_obj;
  }
}

// Update verifyCode function
async function verifyCode(sessionId, code) {
  try {
    const pendingData = pendingClients.get(sessionId);

    if (!pendingData) {
      const [session] = await query(
        "SELECT status FROM telegram_session WHERE session_id = ?",
        [sessionId],
      );

      if (session?.status === "active") {
        return { success: true, message: "Session already active" };
      }

      throw new Error(
        "Session not found or expired. Please create new session.",
      );
    }

    const { client, phoneNumber, phoneCodeHash, title } = pendingData;

    const Api = require("telegram/tl").Api;

    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phoneNumber,
        phoneCodeHash: phoneCodeHash,
        phoneCode: code,
      }),
    );

    const sessionString = client.session.save();

    if (!sessionString || sessionString.trim() === "") {
      throw new Error("Failed to generate valid session string");
    }

    const profile = await getUserProfile(client);

    // Save session string in 'session' column and profile in 'data' column
    await query(
      "UPDATE telegram_session SET status = ?, session = ?, data = ? WHERE session_id = ?",
      ["active", sessionString, JSON.stringify(profile || {}), sessionId],
    );

    if (profile) {
      sessionMetadata.set(sessionId, {
        ...profile,
        title: title,
        connectedAt: new Date().toISOString(),
      });
    }

    setupMessageListener(client, title, sessionId);
    activeClients.set(sessionId, client);
    pendingClients.delete(sessionId);

    logger.log(`Session verified and activated: ${title} (${sessionId})`);

    return {
      success: true,
      sessionId,
      status: "active",
      message: "Session created and activated successfully",
      profile: profile,
    };
  } catch (error) {
    logger.error("Verify code error:", getErrorMessage(error));

    const errorMessage = getErrorMessage(error);

    await query("UPDATE telegram_session SET status = ? WHERE session_id = ?", [
      `failed:${errorMessage}`,
      sessionId,
    ]).catch(() => {});

    if (pendingClients.has(sessionId)) {
      const { client } = pendingClients.get(sessionId);
      try {
        await client.disconnect();
      } catch (e) {}
      pendingClients.delete(sessionId);
    }

    const error_obj = new Error(errorMessage);
    error_obj.userMessage = errorMessage;
    throw error_obj;
  }
}

// Get session status with profile
async function getSessionStatus(sessionId) {
  try {
    const connected = activeClients.has(sessionId);
    const metadata = sessionMetadata.get(sessionId);

    const [sessionData] = await query(
      "SELECT id, uid, status, session_id, title, data, createdAt FROM telegram_session WHERE session_id = ?",
      [sessionId],
    );

    if (!sessionData) {
      throw new Error("Session not found");
    }

    // Parse profile from 'data' column
    let profile = null;
    if (sessionData.data) {
      try {
        profile = JSON.parse(sessionData.data);
      } catch (e) {
        profile = null;
      }
    }

    // If connected but no metadata, fetch it
    if (connected && !metadata) {
      const client = activeClients.get(sessionId);
      const freshProfile = await getUserProfile(client);

      if (freshProfile) {
        sessionMetadata.set(sessionId, {
          ...freshProfile,
          title: sessionData.title,
          connectedAt: new Date().toISOString(),
        });
        profile = freshProfile;
      }
    }

    return {
      success: true,
      connected,
      session: {
        ...sessionData,
        profile: profile || sessionMetadata.get(sessionId) || null,
      },
    };
  } catch (error) {
    logger.error("Get status error:", getErrorMessage(error));
    throw error;
  }
}

// Update getUserSessions function
async function getUserSessions(uid) {
  try {
    const sessions = await query(
      "SELECT id, uid, status, session_id, title, data, createdAt FROM telegram_session WHERE uid = ?",
      [uid],
    );

    return sessions.map((s) => {
      const isFailed = s.status?.startsWith("failed:");
      const errorMessage = isFailed ? s.status.substring(7) : null;

      // Parse profile from 'data' column
      let profile = null;
      if (s.data) {
        try {
          profile = JSON.parse(s.data);
        } catch (e) {
          profile = null;
        }
      }

      return {
        ...s,
        connected: activeClients.has(s.session_id),
        canReconnect: s.status === "inactive" || isFailed,
        needsVerification: s.status === "pending_otp",
        isFailed: isFailed,
        errorMessage: errorMessage,
        profile: profile || sessionMetadata.get(s.session_id) || null,
      };
    });
  } catch (error) {
    logger.error("Get sessions error:", getErrorMessage(error));
    throw error;
  }
}

// Logout and delete session
async function deleteSession(sessionId) {
  try {
    const client = activeClients.get(sessionId);

    if (client) {
      try {
        const Api = require("telegram/tl").Api;
        await client.invoke(new Api.auth.LogOut());
        await client.disconnect();
        await client.destroy();
      } catch (error) {
        // Silently ignore
      }
      activeClients.delete(sessionId);
      sessionMetadata.delete(sessionId);
    }

    // Also check pending
    if (pendingClients.has(sessionId)) {
      const { client } = pendingClients.get(sessionId);
      try {
        await client.disconnect();
      } catch (e) {}
      pendingClients.delete(sessionId);
    }

    await query("DELETE FROM telegram_session WHERE session_id = ?", [
      sessionId,
    ]);

    logger.log(`Session deleted: ${sessionId}`);
    return { success: true, message: "Session deleted successfully" };
  } catch (error) {
    logger.error("Delete session error:", getErrorMessage(error));
    throw error;
  }
}

// Disconnect session
async function disconnectSession(sessionId) {
  try {
    const client = activeClients.get(sessionId);

    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        // Silently ignore
      }
      activeClients.delete(sessionId);
    }

    await query("UPDATE telegram_session SET status = ? WHERE session_id = ?", [
      "inactive",
      sessionId,
    ]);

    logger.log(`Session disconnected: ${sessionId}`);
    return { success: true, message: "Session disconnected successfully" };
  } catch (error) {
    logger.error("Disconnect session error:", getErrorMessage(error));
    throw error;
  }
}

// Send message
async function sendMessage(sessionId, chatId, message) {
  try {
    const client = activeClients.get(sessionId);

    if (!client) {
      try {
        await connectSession(sessionId);
        return await sendMessage(sessionId, chatId, message);
      } catch (error) {
        throw new Error("Session not connected. Please reconnect manually.");
      }
    }

    await client.sendMessage(chatId, { message });
    return { success: true, message: "Message sent successfully" };
  } catch (error) {
    logger.error("Send message error:", getErrorMessage(error));

    if (
      error.message.includes("connection") ||
      error.message.includes("AUTH")
    ) {
      await query(
        "UPDATE telegram_session SET status = ? WHERE session_id = ?",
        ["inactive", sessionId],
      ).catch(() => {});

      activeClients.delete(sessionId);
    }

    throw error;
  }
}

// Get chats/dialogs
async function getChats(sessionId, limit = 50) {
  try {
    const client = activeClients.get(sessionId);

    if (!client) {
      try {
        await connectSession(sessionId);
        return await getChats(sessionId, limit);
      } catch (error) {
        throw new Error("Session not connected. Please reconnect manually.");
      }
    }

    const dialogs = await client.getDialogs({ limit });

    return dialogs.map((dialog) => ({
      id: dialog.id?.toString(),
      name: dialog.name || dialog.title || "Unknown",
      isUser: dialog.isUser,
      isGroup: dialog.isGroup,
      isChannel: dialog.isChannel,
      unreadCount: dialog.unreadCount,
    }));
  } catch (error) {
    logger.error("Get chats error:", getErrorMessage(error));

    if (
      error.message.includes("connection") ||
      error.message.includes("AUTH")
    ) {
      await query(
        "UPDATE telegram_session SET status = ? WHERE session_id = ?",
        ["inactive", sessionId],
      ).catch(() => {});

      activeClients.delete(sessionId);
    }

    throw error;
  }
}

// Check if session is active
function checkTele(sessionId) {
  return activeClients.has(sessionId);
}

// Cleanup on app shutdown
async function cleanupTele() {
  logger.log("Cleaning up Telegram sessions...");

  for (const [sessionId, client] of activeClients.entries()) {
    try {
      await client.disconnect();
    } catch (error) {
      // Silently ignore
    }
  }

  for (const [sessionId, data] of pendingClients.entries()) {
    try {
      await data.client.disconnect();
    } catch (error) {
      // Silently ignore
    }
  }

  activeClients.clear();
  pendingClients.clear();
  sessionMetadata.clear();
  logger.log("Telegram cleanup complete");
}

function checkTelePlugin() {
  return true;
}

module.exports = {
  initTele,
  checkTelePlugin,
  createSession,
  verifyCode,
  connectSession,
  disconnectSession,
  deleteSession,
  sendMessage,
  getChats,
  getUserSessions,
  getSessionStatus,
  cleanupTele,
  checkTele,
  getSession,
};

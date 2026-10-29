const { toDataURL } = require("qrcode");
const pino = require("pino");
const { query } = require("../../../database/dbpromise");
const { processMessage } = require("../../inbox/inbox");
const newLogger = require("../../../utils/logger");

// Declare variables for baileys functions
let baileysLoaded = false;
let makeWASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay,
  downloadMediaMessage,
  getUrlInfo,
  generateProfilePicture,
  useMultiFileAuthState;

// Load baileys functions when needed
async function loadBaileysIfNeeded() {
  if (!baileysLoaded) {
    const baileys = await import("baileys");
    makeWASocket = baileys.default;
    ({
      makeCacheableSignalKeyStore,
      fetchLatestBaileysVersion,
      DisconnectReason,
      delay,
      downloadMediaMessage,
      getUrlInfo,
      generateProfilePicture,
      useMultiFileAuthState,
    } = baileys);
    baileysLoaded = true;
  }
}

// ============= CONFIGURATION =============

// Storage configuration (loaded from database)
let STORAGE_METHOD = "local";
let MONGODB_URI = null;

// MySQL Configuration (from environment or defaults)
const MYSQL_CONFIG = {
  host: process.env.DBHOST || "localhost",
  port: process.env.DBPORT || 3306,
  user: process.env.DBUSER,
  password: process.env.DBPASS,
  database: process.env.DBNAME,
  tableName: "auth",
  retryRequestDelayMs: 200,
};

// Local file storage
const fs = require("fs");
const path = require("path");
const sessionsDir = (sessionId = "") =>
  path.join(process.cwd(), "sessions", sessionId ? `md_${sessionId}` : "");

// Active connections tracking
const activeConnections = new Map();

// Lazy load storage modules
let useMySQLAuthState = null;
let useMongoDBAuthState = null;

// Configuration loaded flag
let configLoaded = false;

/**
 * Load configuration from database
 */
async function loadConfigFromDatabase() {
  if (configLoaded) return;

  try {
    const [config] = await query(`SELECT * FROM web_private`, []);

    if (config) {
      // Load MongoDB connection string from database
      if (config.mongodb_string) {
        MONGODB_URI = config.mongodb_string;
        newLogger.log("MongoDB URI loaded from database");
      }

      // Load storage method from database
      if (config.qr_storage) {
        STORAGE_METHOD = config.qr_storage.toLowerCase(); // mongodb/mysql/local
        newLogger.log(`Storage method loaded from database: ${STORAGE_METHOD}`);
      }
    }

    configLoaded = true;
  } catch (error) {
    newLogger.error("Error loading config from database:", error);
    newLogger.log("Using default configuration");
    configLoaded = true;
  }
}

/**
 * Get MongoDB configuration
 */
function getMongoDBConfig() {
  return {
    mongoUri: MONGODB_URI || "mongodb://localhost:27017",
    dbName: process.env.MONGO_DB_NAME || "wacrm_session",
  };
}

/**
 * Load the appropriate auth state module based on storage method
 */
async function loadAuthStateModule() {
  // Ensure config is loaded first
  await loadConfigFromDatabase();

  if (STORAGE_METHOD === "mysql" && !useMySQLAuthState) {
    const mysqlBaileys = require("mysql-baileys");
    useMySQLAuthState = mysqlBaileys.useMySQLAuthState;
  } else if (STORAGE_METHOD === "mongodb" && !useMongoDBAuthState) {
    const mongoSession = require("./mongoSession");
    useMongoDBAuthState = mongoSession.useMongoDBAuthState;
  } else if (STORAGE_METHOD === "local") {
  }
}

/**
 * Extract user ID from session ID
 */
function extractUidFromSessionId(input) {
  return input.split("_")[0];
}

/**
 * Extract phone number from WhatsApp ID
 */
function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

/**
 * Check if a session exists in active connections
 */
const isSessionExists = (sessionId) => {
  return activeConnections.has(sessionId);
};

/**
 * Helper to delete local session files
 */
const deleteSessionFiles = async (sessionId) => {
  const sessionDir = sessionsDir(sessionId);
  try {
    await fs.promises.access(sessionDir);
  } catch {
    return; // directory doesn't exist
  }

  const files = await fs.promises.readdir(sessionDir);

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const stat = await fs.promises.lstat(filePath);
    if (stat.isDirectory()) {
      await deleteSessionFiles(filePath);
    } else {
      await fs.promises.unlink(filePath);
    }
  }
  await fs.promises.rmdir(sessionDir);
};

// ============= AUTH STATE HANDLER =============

/**
 * Get authentication state based on storage method
 */
async function getAuthState(sessionId) {
  await loadAuthStateModule();

  switch (STORAGE_METHOD) {
    case "mysql":
      newLogger.log(`Using MySQL storage for session: ${sessionId}`);
      return await useMySQLAuthState({
        ...MYSQL_CONFIG,
        session: sessionId,
      });

    case "mongodb":
      newLogger.log(`Using MongoDB storage for session: ${sessionId}`);
      const mongoConfig = getMongoDBConfig();

      if (
        !mongoConfig.mongoUri ||
        mongoConfig.mongoUri === "mongodb://localhost:27017"
      ) {
        newLogger.warn("Warning: MongoDB URI not configured properly!");
      }

      return await useMongoDBAuthState({
        ...mongoConfig,
        session: sessionId,
      });

    case "local":
      // [CUSTOM] crash-safe writes + creds.json.bak (see safeAuthState.js);
      // same files, so existing sessions load unchanged.
      return await require("./safeAuthState").useSafeMultiFileAuthState(
        sessionsDir(sessionId),
      );

    default:
      throw new Error(`Invalid storage method: ${STORAGE_METHOD}`);
  }
}

/**
 * Delete session data based on storage method
 */
async function deleteSessionData(sessionId) {
  switch (STORAGE_METHOD) {
    case "mysql":
      // MySQL cleanup is handled by removeCreds() during logout
      newLogger.log(`MySQL session data cleaned for: ${sessionId}`);
      break;

    case "mongodb":
      const { deleteSessionFromDB } = require("./mongoSession");
      await deleteSessionFromDB(sessionId);
      newLogger.log(`MongoDB session data deleted for: ${sessionId}`);
      break;

    case "local":
      await deleteSessionFiles(sessionId);
      newLogger.log(`Local files deleted for: ${sessionId}`);
      break;
  }
}

// ============= SESSION MANAGEMENT =============

// [CUSTOM] Reconnect bookkeeping. Stock code opened a brand-new socket on
// every disconnect without closing the old one and with a fixed 5s delay, so
// sockets piled up and kept knocking each other off ("connection replaced"),
// which is how numbers dropped while they were in use.
const reconnectState = new Map(); // sessionId -> { attempts, timer }
let cachedWaVersion = null;

function waLog(sessionId, ...args) {
  // newLogger is silent unless NODE_ENV=logs; connection events must always
  // reach the process log so disconnects can be diagnosed.
  console.log(`[WA ${sessionId}]`, ...args);
}

async function getWaVersion() {
  try {
    const { version, error } = await fetchLatestBaileysVersion();
    if (!error && version) cachedWaVersion = version;
  } catch (e) {}
  return cachedWaVersion; // null -> Baileys uses its bundled version
}

function clearReconnect(sessionId) {
  const st = reconnectState.get(sessionId);
  if (st?.timer) clearTimeout(st.timer);
  if (st) st.timer = null;
}

function scheduleReconnect(sessionId, title, options, delayMs, why) {
  const st = reconnectState.get(sessionId) || { attempts: 0, timer: null };
  if (st.timer) clearTimeout(st.timer);
  st.attempts += 1;
  waLog(
    sessionId,
    `reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${st.attempts}, ${why})`,
  );
  st.timer = setTimeout(() => {
    st.timer = null;
    createSession(sessionId, title, options);
  }, delayMs);
  reconnectState.set(sessionId, st);
}

function backoffMs(sessionId, base = 5000, max = 60000) {
  const attempts = reconnectState.get(sessionId)?.attempts || 0;
  return Math.min(base * Math.pow(2, attempts), max);
}

/**
 * Pick the phone-number JID (@s.whatsapp.net) when Baileys gives a LID.
 * Status/story messages are tagged so callers can skip them.
 */
const normalizeMessageJid = (msg) => {
  if (!msg?.key) return msg;

  const main = msg.key.remoteJid;
  const alt = msg.key.remoteJidAlt;

  if (main === "status@broadcast" || alt === "status@broadcast") {
    // Tag it so downstream code can detect it easily
    msg._isStatusBroadcast = true;
    return msg;
  }

  // For regular messages: pick the one ending with @s.whatsapp.net
  const correct =
    main && main.endsWith("@s.whatsapp.net")
      ? main
      : alt && alt.endsWith("@s.whatsapp.net")
        ? alt
        : main || alt;

  msg.key.remoteJid = correct;

  return msg;
};

/** Close a socket we are about to replace, without triggering a reconnect. */
function retireSocket(sessionId) {
  const old = activeConnections.get(sessionId);
  if (!old) return;
  activeConnections.delete(sessionId); // makes its close event a no-op
  try {
    old.end(undefined);
  } catch (e) {}
}

/**
 * Create a new WhatsApp session
 */
const createSession = async (
  sessionId,
  title = "Chrome",
  options = {
    onQr: null,
    syncFullHistory: process.env.QR_FULL_HISTORY === "true",
  },
) => {
  try {
    // Load baileys functions first
    await loadBaileysIfNeeded();

    // Ensure configuration is loaded
    await loadConfigFromDatabase();

    clearReconnect(sessionId);
    retireSocket(sessionId);

    const logger = pino({ level: "silent" });
    const version = await getWaVersion();

    // Get authentication state based on storage method
    const { state, saveCreds, removeCreds } = await getAuthState(sessionId);

    // Create WhatsApp connection
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      ...(version ? { version } : {}),
      logger,
      printQRInTerminal: false,
      // [CUSTOM] Keep the stock identity. A desktop identity ("Mac OS",
      // "Desktop") made WhatsApp terminate (428) every already-linked number
      // on 2026-10-27. Do not change it.
      browser: [title, "", ""],
      syncFullHistory: !!options?.syncFullHistory,
      // [CUSTOM] Baileys v7 defaults this to `() => !!syncFullHistory`, which
      // DROPS every history sync (even the recent chats WhatsApp sends right
      // after linking) unless full history is on. Always process it;
      // historySync.js decides what to keep (QR_HISTORY_DAYS).
      shouldSyncHistoryMessage: () => true,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      // [CUSTOM] false so the phone keeps getting notifications and the
      // linked device does not look "always online".
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
    });

    // Store active connection
    activeConnections.set(sessionId, sock);
    const isCurrent = () => activeConnections.get(sessionId) === sock;

    // Handle credential updates
    sock.ev.on("creds.update", saveCreds);

    // Handle messages update (for poll updates)
    sock.ev.on("messages.update", async (m) => {
      const uid = extractUidFromSessionId(sessionId);
      if (!uid) return;

      // [CUSTOM] Stock code looked only at m[0]; a single event can carry
      // several updates.
      const readOnPhone = [];
      for (const message of m || []) {
        if (!message?.update || message?.key?.remoteJid === "status@broadcast") {
          continue;
        }
        if (!message.update.status) continue;

        // A customer message (fromMe = false) turning READ means it was read
        // on the phone or another linked device: WhatsApp copies that read
        // receipt to every device of the account.
        if (!message.key?.fromMe && message.update.status >= 4) {
          readOnPhone.push({ id: message.key.remoteJid, unreadCount: 0 });
          continue;
        }

        processMessage({
          body: message,
          uid,
          origin: "qr",
          getSession,
          sessionId,
          qrType: "update",
        });
      }

      if (readOnPhone.length) {
        require("../../readSync").onWhatsAppChatsUpdate({
          updates: readOnPhone,
          uid,
          sessionId,
          sock,
        });
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      // [CUSTOM] Stock code read only m.messages[0] and only type "notify".
      // Messages that arrived while the number was offline come back as
      // type "append" (and often several per event), so they were dropped.
      for (let message of m.messages || []) {
        if (!message) continue;

        message = normalizeMessageJid(message);

        const remoteJid = message.key.remoteJid;

        if (
          !remoteJid ||
          remoteJid === "status@broadcast" ||
          remoteJid.includes("broadcast") ||
          message._isStatusBroadcast === true ||
          message.key.fromMe === undefined ||
          // Stories often have a statusValue or status message type
          message.message?.protocolMessage?.type === 25 ||
          message.message?.senderKeyDistributionMessage?.groupId ===
            "status@broadcast"
        ) {
          continue; // Skip — this is a Story/Status update
        }

        // "append" + fromMe is our own outgoing message echoed back by
        // Baileys right after sendMessage(); the inbox already saves those,
        // so only customer messages are taken from "append".
        const accept =
          m.type === "notify" || (m.type === "append" && !message.key.fromMe);

        // [CUSTOM] groups (@g.us) are shown in the inbox too
        if (
          accept &&
          (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@g.us"))
        ) {
          const uid = extractUidFromSessionId(sessionId);
          if (uid) {
            await processMessage({
              body: message,
              uid,
              origin: "qr",
              getSession,
              sessionId,
              qrType: m.type === "append" ? "append" : "upsert",
            });
          }
        }
      }
    });

    // [CUSTOM] Old messages WhatsApp sends right after a number is linked.
    // Stock code ignored this event, so a re-linked number started empty.
    sock.ev.on("messaging-history.set", (data) => {
      const uid = extractUidFromSessionId(sessionId);
      if (!uid) return;
      require("./historySync")
        .importHistory({ data, uid, sessionId, getSession, normalizeMessageJid })
        .catch((e) => waLog(sessionId, "history import failed:", e?.message));
    });

    // [CUSTOM] Chat read on the phone (or another linked device) -> clear
    // its unread counter in the inbox too.
    sock.ev.on("chats.update", (updates) => {
      const uid = extractUidFromSessionId(sessionId);
      require("../../readSync").onWhatsAppChatsUpdate({
        updates,
        uid,
        sessionId,
        sock,
      });
    });

    // [CUSTOM] group created / renamed -> keep its name in the inbox current
    const onGroups = (groups) => {
      const named = (groups || []).filter((g) => g?.id && g?.subject);
      if (!named.length) return;
      require("./processThings").syncGroupNames({ session: sock, sessionId, groups: named });
    };
    sock.ev.on("groups.upsert", onGroups);
    sock.ev.on("groups.update", onGroups);

    // Handle connection updates
    sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
        if (connection === "open") {
          reconnectState.delete(sessionId);
          waLog(sessionId, "connected");
          try {
            const userData = sock.user || {};
            await query(
              "UPDATE instance SET status = ?, number = ?, data = ? WHERE uniqueId = ?",
              [
                "ACTIVE",
                extractPhoneNumber(userData?.id) || null,
                userData?.id ? JSON.stringify(userData) : null,
                sessionId,
              ],
            );
          } catch (error) {
            newLogger.error("Database update error (open):", error);
          }
          // [CUSTOM] refresh group names in the inbox once the link settles
          setTimeout(() => {
            if (!isCurrent()) return;
            require("./processThings").syncGroupNames({ session: sock, sessionId });
          }, 20000);
        } else if (connection === "close") {
          // A socket we already replaced: its close must not start another
          // reconnect, or two sockets fight over the same number.
          if (!isCurrent()) return;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.message || "unknown";
          waLog(sessionId, `closed (code: ${statusCode}, ${reason})`);

          if (statusCode === DisconnectReason.loggedOut) {
            newLogger.log(`Session ${sessionId} logged out`);
            waLog(sessionId, "logged out from the phone — needs a new QR");
            activeConnections.delete(sessionId);
            reconnectState.delete(sessionId);

            // Remove credentials based on storage method
            if (removeCreds) {
              await removeCreds();
            }
            await deleteSessionData(sessionId);

            try {
              await query("UPDATE instance SET status = ? WHERE uniqueId = ?", [
                "INACTIVE",
                sessionId,
              ]);
            } catch (error) {
              newLogger.error("Database update error (logout):", error);
            }
          } else if (statusCode === DisconnectReason.connectionReplaced) {
            // Another socket (often a second copy of this app, e.g. two
            // Passenger processes or an overlapping restart) opened the same
            // session. Back off hard instead of fighting it.
            scheduleReconnect(
              sessionId,
              title,
              options,
              backoffMs(sessionId, 60000, 5 * 60000),
              "connection replaced — is the app running twice?",
            );
          } else if (statusCode === DisconnectReason.restartRequired) {
            // Normal right after scanning the QR.
            scheduleReconnect(sessionId, title, options, 1000, "restart required");
          } else {
            scheduleReconnect(
              sessionId,
              title,
              options,
              backoffMs(sessionId),
              `code ${statusCode}`,
            );
          }
        }

        if (qr) {
          // [CUSTOM] A QR means this number is NOT logged in. Stock code left
          // the row on ACTIVE, so a number whose login was lost still looked
          // connected in the panel. Mark it so the owner knows to scan.
          if (!state.creds?.me) {
            query(
              "UPDATE instance SET status = 'INACTIVE' WHERE uniqueId = ? AND status = 'ACTIVE'",
              [sessionId],
            )
              .then((r) => {
                if (r?.affectedRows) waLog(sessionId, "not logged in — marked INACTIVE, needs QR scan");
              })
              .catch(() => {});
          }
          try {
            const qrCodeImage = await toDataURL(qr);
            try {
              await query("UPDATE instance SET qr = ? WHERE uniqueId = ?", [
                qrCodeImage,
                sessionId,
              ]);
            } catch (error) {
              newLogger.error("Database update error (qr):", error);
            }

            if (typeof options?.onQr === "function") {
              options.onQr(qrCodeImage);
            }
          } catch (error) {
            newLogger.error("QR processing error:", error);
          }
        }
      },
    );

    return "Session initiated";
  } catch (error) {
    newLogger.error(`Error creating session ${sessionId}:`, error);
    waLog(sessionId, "failed to start:", error?.message || error);
    // [CUSTOM] Stock code gave up here, leaving the number offline until
    // someone noticed. Retry with backoff instead.
    scheduleReconnect(
      sessionId,
      title,
      options,
      backoffMs(sessionId),
      "start failed",
    );
    return "Failed to create session";
  }
};

/**
 * Get an active session
 */
const getSession = (sessionId) => {
  return activeConnections.get(sessionId) || null;
};

/**
 * Delete a session
 */
const deleteSession = async (sessionId) => {
  try {
    // [CUSTOM] Cancel any pending reconnect and forget the socket before
    // logging out, so its close event cannot bring a deleted number back.
    clearReconnect(sessionId);
    reconnectState.delete(sessionId);
    const session = getSession(sessionId);
    if (session) {
      activeConnections.delete(sessionId);
      try {
        await session.logout();
      } catch (error) {
        newLogger.error(`Error logging out session ${sessionId}:`, error);
      }
    }

    // Delete session data based on storage method
    await deleteSessionData(sessionId);

    try {
      await query("UPDATE instance SET status = ? WHERE uniqueId = ?", [
        "INACTIVE",
        sessionId,
      ]);
    } catch (error) {
      newLogger.error("Database update error (deleteSession):", error);
    }
  } catch (error) {
    newLogger.error(`Error deleting session ${sessionId}:`, error);
  }
};

/**
 * Check if a phone number or group exists
 */
const isExists = async (session, jid, isGroup = false) => {
  try {
    let result;
    if (isGroup) {
      result = await session.groupMetadata(jid);
      return Boolean(result.id);
    }
    [result] = await session.onWhatsApp(jid);
    if (typeof result === "undefined") {
      const getNum = jid.replace("@s.whatsapp.net", "");
      [result] = await session.onWhatsApp(`+${getNum}`);
    }
    return result?.exists;
  } catch (err) {
    newLogger.error("isExists error:", err);
    return false;
  }
};

/**
 * Send a message
 */
const sendMessage = async (session, receiver, message) => {
  try {
    await loadBaileysIfNeeded();

    if (message?.text) {
      try {
        const linkPreview = await getUrlInfo(message.text, {
          thumbnailWidth: 1024,
          fetchOpts: { timeout: 5000 },
          uploadImage: session.waUploadToServer,
        });

        message = {
          text: message.text,
          linkPreview,
        };
      } catch (error) {
        newLogger.error("Error generating link preview:", error);
      }
    }

    await delay(1000);
    return session.sendMessage(receiver, message);
  } catch (err) {
    newLogger.error("sendMessage error:", err);
    return Promise.reject(null);
  }
};

/**
 * Get group metadata
 */
const getGroupData = async (session, jid) => {
  try {
    return await session.groupMetadata(jid);
  } catch (err) {
    newLogger.error("getGroupData error:", err);
    return Promise.reject(null);
  }
};

/**
 * Format phone number to WhatsApp JID
 */
const formatPhone = (phone) => {
  if (phone.endsWith("@s.whatsapp.net")) return phone;
  let formatted = phone.replace(/\D/g, "");
  return formatted + "@s.whatsapp.net";
};

/**
 * Format group ID to WhatsApp group JID
 */
const formatGroup = (group) => {
  if (group.endsWith("@g.us")) return group;
  let formatted = group.replace(/[^\d-]/g, "");
  return formatted + "@g.us";
};

/**
 * Cleanup function for graceful shutdown
 */
const cleanup = async () => {
  newLogger.log("Running cleanup before exit...");
  const cleanupPromises = [];

  activeConnections.forEach((session, sessionId) => {
    newLogger.log(`Closing session ${sessionId}`);
    // [CUSTOM] end() is synchronous in Baileys; calling .catch on its
    // return value threw and aborted the cleanup.
    cleanupPromises.push(
      Promise.resolve()
        .then(() => session.end(undefined))
        .catch((error) => {
          newLogger.error(`Error closing session ${sessionId}:`, error);
        }),
    );
  });

  await Promise.allSettled(cleanupPromises);
  newLogger.log("Cleanup completed");
};

/**
 * Initialize existing sessions from database or local files
 */
const init = async () => {
  try {
    await loadBaileysIfNeeded();
    await loadConfigFromDatabase();

    if (STORAGE_METHOD === "local") {
      // Initialize from local files
      const sessionsPath = sessionsDir();
      try {
        await fs.promises.access(sessionsPath);
      } catch {
        await fs.promises.mkdir(sessionsPath, { recursive: true });
      }

      const files = await fs.promises.readdir(sessionsPath);
      const sessionFiles = [];
      for (const file of files) {
        if (!file.startsWith("md_")) continue;
        const stat = await fs.promises.lstat(path.join(sessionsPath, file));
        if (stat.isDirectory()) sessionFiles.push(file);
      }
      for (const dir of sessionFiles) {
        const sessionId = dir.replace("md_", "");
        await createSession(sessionId);
      }
    } else {
      // Initialize from database (MySQL/MongoDB)
      const instances = await query(
        "SELECT uniqueId FROM instance WHERE status = 'ACTIVE'",
        [],
      );

      for (const instance of instances) {
        await createSession(instance.uniqueId);
      }
    }
  } catch (error) {
    newLogger.error("Error initializing sessions:", error);
  }
};

/**
 * Check if QR code functionality is available
 */
function checkQr() {
  return true;
}

/**
 * Get current storage configuration (for debugging/monitoring)
 */
const getStorageConfig = async () => {
  await loadConfigFromDatabase();
  return {
    method: STORAGE_METHOD,
    mongoUri: MONGODB_URI ? "***configured***" : "not set",
    mysqlHost: MYSQL_CONFIG.host,
  };
};

// Wrapper functions
const wrappedGetUrlInfo = async (...args) => {
  await loadBaileysIfNeeded();
  return getUrlInfo(...args);
};

const wrappedDownloadMediaMessage = async (...args) => {
  await loadBaileysIfNeeded();
  return downloadMediaMessage(...args);
};

const wrappedGenerateProfilePicture = async (...args) => {
  await loadBaileysIfNeeded();
  return generateProfilePicture(...args);
};

// ============= EXPORTS =============

module.exports = {
  isSessionExists,
  createSession,
  getSession,
  deleteSession,
  isExists,
  sendMessage,
  formatPhone,
  formatGroup,
  cleanup,
  init,
  getGroupData,
  getUrlInfo: wrappedGetUrlInfo,
  downloadMediaMessage: wrappedDownloadMediaMessage,
  checkQr,
  generateProfilePicture: wrappedGenerateProfilePicture,
  getStorageConfig, // Export for debugging
};

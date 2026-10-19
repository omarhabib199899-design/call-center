const path = require("path");
const fs = require("fs").promises;
const { query } = require("../../../database/dbpromise");
const randomstring = require("randomstring");
const { CustomFile } = require("telegram/client/uploads");
const logger = require("../../../utils/logger");
const { Api } = require("telegram");
const { getSession } = require("./tele");

/**
 * Generate unique message ID
 */
function generateMessageId() {
  return `tg_${Date.now()}_${randomstring.generate({
    length: 16,
    charset: "alphanumeric",
  })}`;
}

/**
 * Format Telegram user ID to standard format
 */
function formatTelegramId(id) {
  return `${id}@telegram`;
}

/**
 * Download and save media file
 */

async function downloadTelegramMedia(client, message, sessionId) {
  try {
    // Absolute path to: ../../../client/public/telegram/<sessionId>
    const mediaDir = path.resolve(
      __dirname,
      "../../../client/public/telegram",
      sessionId,
    );

    // Ensure folder exists
    await fs.mkdir(mediaDir, { recursive: true });

    const timestamp = Date.now();
    const randomStr = randomstring.generate({
      length: 8,
      charset: "alphanumeric",
    });

    let fileName = `${timestamp}_${randomStr}`;
    let mimeType = "application/octet-stream";
    let fileExtension = "";

    // Detect file type
    if (message.photo) {
      fileExtension = ".jpg";
      mimeType = "image/jpeg";
    } else if (message.video) {
      fileExtension = ".mp4";
      mimeType = "video/mp4";
    } else if (message.audio || message.voice) {
      fileExtension = ".ogg";
      mimeType = "audio/ogg";
    } else if (message.document) {
      const doc = message.document;

      if (doc.mimeType) {
        mimeType = doc.mimeType;
        const ext = doc.mimeType.split("/")[1];
        if (ext) fileExtension = `.${ext}`;
      }

      if (doc.attributes) {
        const fileNameAttr = doc.attributes.find(
          (attr) => attr.className === "DocumentAttributeFilename",
        );

        if (fileNameAttr?.fileName) {
          const originalName = fileNameAttr.fileName;
          const extMatch = originalName.match(/\.[^.]+$/);
          fileExtension = extMatch ? extMatch[0] : fileExtension;

          fileName = `${timestamp}_${randomStr}_${originalName.replace(
            /\.[^.]+$/,
            "",
          )}`;
        }
      }
    } else if (message.sticker) {
      fileExtension = ".webp";
      mimeType = "image/webp";
    }

    const fullFileName = `${fileName}${fileExtension}`;
    const filePath = path.join(mediaDir, fullFileName);

    // Download file buffer
    const buffer = await client.downloadMedia(message, {});

    if (!buffer) {
      throw new Error("Failed to download media");
    }

    await fs.writeFile(filePath, buffer);

    const fileSize = buffer.length;

    // This is what frontend will use
    const publicPath = `/telegram/${sessionId}/${fullFileName}`;

    return {
      filePath: publicPath, // usable in browser
      fileName: fullFileName,
      mimeType,
      fileSize,
      localPath: filePath, // absolute server path
    };
  } catch (error) {
    logger.error("Error downloading Telegram media:", error);
    return null;
  }
}

/**
 * Download profile picture
 */
async function downloadProfilePicture(client, userId, sessionId) {
  try {
    const profileDir = path.join(
      process.cwd(),
      "media",
      "telegram",
      "profiles",
      sessionId,
    );
    await fs.mkdir(profileDir, { recursive: true });

    const randomStr = randomstring.generate({
      length: 8,
      charset: "alphanumeric",
    });

    const fileName = `${userId}_${Date.now()}_${randomStr}.jpg`;
    const filePath = path.join(profileDir, fileName);

    // Get user entity
    const user = await client.getEntity(userId);

    // Download profile photo
    const buffer = await client.downloadProfilePhoto(user, {
      isBig: false,
    });

    if (!buffer) {
      return null;
    }

    await fs.writeFile(filePath, buffer);

    const relativePath = path.join(
      "media",
      "telegram",
      "profiles",
      sessionId,
      fileName,
    );

    return relativePath;
  } catch (error) {
    logger.error("Error downloading profile picture:", error);
    return null;
  }
}

/**
 * Process text message
 */
function processTextMessage(message) {
  return {
    type: "text",
    text: {
      body: message.text || "",
      preview_url: true,
    },
  };
}

/**
 * Process image message
 */
async function processImageMessage(client, message, sessionId) {
  const mediaData = await downloadTelegramMedia(client, message, sessionId);

  if (!mediaData) {
    return null;
  }

  return {
    type: "image",
    image: {
      link: mediaData.filePath,
      caption: message.text || "",
    },
  };
}

/**
 * Process video message
 */
async function processVideoMessage(client, message, sessionId) {
  const mediaData = await downloadTelegramMedia(client, message, sessionId);

  if (!mediaData) {
    return null;
  }

  return {
    type: "video",
    video: {
      link: mediaData.filePath,
      caption: message.text || "",
    },
  };
}

/**
 * Process audio/voice message
 */
async function processAudioMessage(client, message, sessionId) {
  const mediaData = await downloadTelegramMedia(client, message, sessionId);

  if (!mediaData) {
    return null;
  }

  return {
    type: "audio",
    audio: {
      link: mediaData.filePath,
      isVoice: !!message.voice,
    },
  };
}

/**
 * Process document message
 */
async function processDocumentMessage(client, message, sessionId) {
  const mediaData = await downloadTelegramMedia(client, message, sessionId);

  if (!mediaData) {
    return null;
  }

  return {
    type: "document",
    document: {
      link: mediaData.filePath,
      caption: message.text || "",
      filename: mediaData.fileName,
    },
  };
}

/**
 * Process sticker message
 */
async function processStickerMessage(client, message, sessionId) {
  const mediaData = await downloadTelegramMedia(client, message, sessionId);

  if (!mediaData) {
    return null;
  }

  return {
    type: "sticker",
    sticker: {
      link: mediaData.filePath,
    },
  };
}

/**
 * Process location message
 */
function processLocationMessage(message) {
  if (!message.geo) {
    return null;
  }

  return {
    type: "location",
    location: {
      latitude: message.geo.lat,
      longitude: message.geo.long,
      name: message.text || "Location",
    },
  };
}

/**
 * Process contact message
 */
function processContactMessage(message) {
  if (!message.contact) {
    return null;
  }

  return {
    type: "contact",
    contact: {
      contacts: [
        {
          name: {
            formatted_name: `${message.contact.firstName || ""} ${
              message.contact.lastName || ""
            }`.trim(),
            first_name: message.contact.firstName || "",
            last_name: message.contact.lastName || "",
          },
          phones: [
            {
              phone: message.contact.phoneNumber || "",
            },
          ],
        },
      ],
    },
  };
}

/**
 * Process poll message
 */
function processPollMessage(message) {
  if (!message.poll) {
    return null;
  }

  return {
    type: "poll",
    poll: {
      question: message.poll.question,
      options: message.poll.answers.map((answer) => ({
        text: answer.text,
        voters: answer.voters || 0,
      })),
    },
  };
}

/**
 * Get chat information
 */
async function getChatInfo(client, message) {
  try {
    //  For outgoing messages, get the RECIPIENT (peer), not the sender
    const chat = await message.getChat();

    let chatType = "private";
    let chatName = "Unknown";
    let chatId = message.chatId?.toString();

    // Handle different chat types
    if (!chat) {
      return {
        chatId: formatTelegramId(chatId || "unknown"),
        chatName: "Unknown",
        chatType: "private",
        isGroup: false,
        isChannel: false,
      };
    }

    // Check if it's a group/channel (has title)
    if (chat.title) {
      chatName = chat.title;
      chatType = chat.broadcast ? "channel" : "group";
    }
    // Check if it's a user (has firstName)
    else if (chat.firstName) {
      chatName = `${chat.firstName} ${chat.lastName || ""}`.trim();
      chatType = "private";
    }
    // Check if it has username
    else if (chat.username) {
      chatName = `@${chat.username}`;
      chatType = "private";
    }
    // Fallback to ID
    else {
      chatName = `User ${chatId}`;
      chatType = "private";
    }

    return {
      chatId: formatTelegramId(chatId),
      chatName,
      chatType,
      isGroup: chatType === "group",
      isChannel: chatType === "channel",
    };
  } catch (error) {
    logger.error("Error getting chat info:", error.message);

    // Fallback to basic info from message
    const chatId = message.chatId?.toString() || "unknown";
    return {
      chatId: formatTelegramId(chatId),
      chatName: `Chat ${chatId}`,
      chatType: "private",
      isGroup: false,
      isChannel: false,
    };
  }
}

/**
 * Get sender information
 */
async function getSenderInfo(client, message, sessionId) {
  try {
    const senderId = message.senderId?.toString();

    if (!senderId) {
      return {
        senderId: "unknown",
        senderName: "Unknown",
        senderMobile: "unknown",
        profileImage: null,
        username: null,
      };
    }

    const sender = await message.getSender();

    // Build sender name with fallbacks
    let senderName = "Unknown";
    if (sender.firstName) {
      senderName = `${sender.firstName} ${sender.lastName || ""}`.trim();
    } else if (sender.username) {
      senderName = `@${sender.username}`;
    } else {
      senderName = `User ${senderId}`;
    }

    // Download profile picture
    let profileImage = null;
    try {
      profileImage = await downloadProfilePicture(client, senderId, sessionId);
    } catch (error) {
      // Silently fail - profile picture is optional
    }

    return {
      senderId: formatTelegramId(senderId),
      senderName,
      senderMobile: senderId, // Use Telegram ID as mobile (always available)
      profileImage,
      username: sender.username || null,
      // Store full user data for manual extraction later
      userData: {
        id: senderId,
        firstName: sender.firstName || null,
        lastName: sender.lastName || null,
        username: sender.username || null,
        phone: sender.phone || null, // Will be null 99% of the time
      },
    };
  } catch (error) {
    logger.error("Error getting sender info:", error.message);

    const senderId = message.senderId?.toString() || "unknown";
    return {
      senderId: formatTelegramId(senderId),
      senderName: `User ${senderId}`,
      senderMobile: senderId,
      profileImage: null,
      username: null,
      userData: null,
    };
  }
}

async function extractUserDetails(client, userId) {
  try {
    const user = await client.getEntity(userId);

    return {
      id: user.id?.toString(),
      firstName: user.firstName || null,
      lastName: user.lastName || null,
      username: user.username || null,
      phone: user.phone || null,
      bio: user.about || null,
      isBot: user.bot || false,
      isPremium: user.premium || false,
      isVerified: user.verified || false,
      isScam: user.scam || false,
      isFake: user.fake || false,
      isSupport: user.support || false,
      languageCode: user.langCode || null,
    };
  } catch (error) {
    logger.error("Error extracting user details:", error.message);
    return null;
  }
}

async function extractChatDetails(client, chatId) {
  try {
    const chat = await client.getEntity(chatId);

    const details = {
      id: chat.id?.toString(),
      title: chat.title || null,
      username: chat.username || null,
      type: chat.broadcast
        ? "channel"
        : chat.megagroup
          ? "supergroup"
          : chat.gigagroup
            ? "gigagroup"
            : "group",
      participantsCount: chat.participantsCount || 0,
      about: chat.about || null,
      isVerified: chat.verified || false,
      isScam: chat.scam || false,
      isFake: chat.fake || false,
    };

    // Get participants for small groups
    if (!chat.broadcast && chat.participantsCount < 200) {
      try {
        const participants = await client.getParticipants(chat, { limit: 200 });
        details.participants = participants.map((p) => ({
          id: p.id?.toString(),
          firstName: p.firstName || null,
          lastName: p.lastName || null,
          username: p.username || null,
          phone: p.phone || null,
        }));
      } catch (e) {
        details.participants = [];
      }
    }

    return details;
  } catch (error) {
    logger.error("Error extracting chat details:", error.message);
    return null;
  }
}

/**
 * Save message to database (using beta_conversation table)
 */
async function saveMessageToDatabase(message, chatId, uid) {
  try {
    const messageId = message.metaChatId || generateMessageId();

    await query(
      `INSERT INTO beta_conversation 
       (type, chat_id, uid, status, metaChatId, msgContext, reaction, 
        timestamp, senderName, senderMobile, star, route, context, origin, sentBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.type,
        chatId,
        uid,
        message.status || null,
        messageId,
        JSON.stringify(message.msgContext),
        message.reaction || "",
        message.timestamp,
        message.senderName,
        message.senderMobile,
        message.star ? 1 : 0,
        message.route,
        message.context || null,
        message.origin,
        message.sentBy || null,
      ],
    );

    return messageId;
  } catch (error) {
    logger.error("Error saving message to database:", error);
    return null;
  }
}

/**
 * Update or create chat in database (using beta_chats table)
 */
async function updateChatInDatabase(message, uid, chatName) {
  try {
    // Check if chat exists
    const [existingChat] = await query(
      `SELECT * FROM beta_chats WHERE chat_id = ? AND uid = ?`,
      [message.chatId, uid],
    );

    // Create last_message object
    const lastMessageObj = {
      type: message.type,
      metaChatId: message.metaChatId,
      msgContext: message.msgContext,
      reaction: message.reaction || "",
      timestamp: message.timestamp,
      senderName: message.senderName,
      senderMobile: message.senderMobile,
      status: message.status || "",
      star: message.star || false,
      route: message.route,
      context: message.context || null,
      origin: message.origin,
    };

    // Create profile object
    const profileObj = message.profileImage
      ? { profileImage: message.profileImage }
      : null;

    //  Create origin_instance_id with RECIPIENT info (not sender)
    const recipientInfo = message.recipientInfo || {
      id: message.chatId.replace("@telegram", ""),
      name: chatName || message.senderName,
    };

    const originInstanceObj = {
      id: recipientInfo.id,
      name: recipientInfo.name,
    };

    if (recipientInfo.username) {
      originInstanceObj.username = recipientInfo.username;
    }

    //  For chat name, use recipient name (not sender name)
    const finalChatName = chatName || recipientInfo.name || message.senderName;
    const finalChatMobile = recipientInfo.id;

    if (existingChat) {
      // Update existing chat
      await query(
        `UPDATE beta_chats 
         SET last_message = ?, 
             unread_count = unread_count + ?,
             updatedAt = NOW()
         WHERE chat_id = ? AND uid = ?`,
        [
          JSON.stringify(lastMessageObj),
          message.route === "INCOMING" ? 1 : 0,
          message.chatId,
          uid,
        ],
      );
    } else {
      //  Create new chat with RECIPIENT info
      await query(
        `INSERT INTO beta_chats 
         (uid, chat_id, last_message, sender_name, sender_mobile, 
          unread_count, origin, profile, origin_instance_id, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          uid,
          message.chatId,
          JSON.stringify(lastMessageObj),
          finalChatName, //  Recipient name
          finalChatMobile, //  Recipient ID
          message.route === "INCOMING" ? 1 : 0,
          message.origin,
          profileObj ? JSON.stringify(profileObj) : null,
          JSON.stringify(originInstanceObj), //  Recipient info
        ],
      );
    }

    return message.chatId;
  } catch (error) {
    logger.error("Error updating chat in database:", error);
    return null;
  }
}

/**
 * Main Telegram message processor (similar to processMessageQr)
 */
async function processMessageTelegram({
  getSession,
  message,
  sessionId,
  type = "upsert",
  uid,
  userData,
}) {
  try {
    const client = getSession(sessionId);

    if (!client) {
      logger.error("Telegram client not found for session:", sessionId);
      return null;
    }

    // Get current user (me)
    const me = await client.getMe();
    const myId = me.id?.toString();
    const isFromMe = message.senderId?.toString() === myId;
    const route = isFromMe ? "OUTGOING" : "INCOMING";

    //  FIX: Get the OTHER person's info (not yours)
    let chatId, chatName, senderInfo, recipientInfo;

    if (isFromMe) {
      //  OUTGOING: You sent to someone
      // chatId should be the RECIPIENT (message.chatId or message.peerId)

      const recipientId =
        message.peerId?.userId?.toString() || message.chatId?.toString();

      if (!recipientId) {
        logger.error("Cannot determine recipient ID");
        return null;
      }

      // Get recipient's info (the person you're chatting with)
      try {
        const recipient = await client.getEntity(parseInt(recipientId));

        chatId = formatTelegramId(recipientId);
        chatName = recipient.firstName
          ? `${recipient.firstName} ${recipient.lastName || ""}`.trim()
          : recipient.username
            ? `@${recipient.username}`
            : `User ${recipientId}`;

        recipientInfo = {
          id: recipientId,
          name: chatName,
          username: recipient.username || null,
          firstName: recipient.firstName || null,
          lastName: recipient.lastName || null,
        };

        // Sender is YOU
        senderInfo = {
          senderId: formatTelegramId(myId),
          senderName:
            `${me.firstName || ""} ${me.lastName || ""}`.trim() || "You",
          senderMobile: myId,
          profileImage: null,
          username: me.username || null,
          userData: {
            id: myId,
            firstName: me.firstName || null,
            lastName: me.lastName || null,
            username: me.username || null,
            phone: me.phone || null,
          },
        };
      } catch (error) {
        logger.error("Error getting recipient info:", error);
        return null;
      }
    } else {
      //  INCOMING: Someone sent to you
      const senderId = message.senderId?.toString();

      if (!senderId) {
        logger.error("Cannot determine sender ID");
        return null;
      }

      // Chat is the SENDER
      chatId = formatTelegramId(senderId);
      senderInfo = await getSenderInfo(client, message, sessionId);
      chatName = senderInfo.senderName;

      recipientInfo = {
        id: senderId,
        name: chatName,
        username: senderInfo.username || null,
      };
    }

    // Process message based on type
    let msgContext = null;
    let messageType = "text";

    if (message.photo) {
      msgContext = await processImageMessage(client, message, sessionId);
      messageType = "image";
    } else if (message.video) {
      msgContext = await processVideoMessage(client, message, sessionId);
      messageType = "video";
    } else if (message.audio || message.voice) {
      msgContext = await processAudioMessage(client, message, sessionId);
      messageType = "audio";
    } else if (message.document) {
      msgContext = await processDocumentMessage(client, message, sessionId);
      messageType = "document";
    } else if (message.sticker) {
      msgContext = await processStickerMessage(client, message, sessionId);
      messageType = "sticker";
    } else if (message.geo) {
      msgContext = processLocationMessage(message);
      messageType = "location";
    } else if (message.contact) {
      msgContext = processContactMessage(message);
      messageType = "contact";
    } else if (message.poll) {
      msgContext = processPollMessage(message);
      messageType = "poll";
    } else if (message.text) {
      msgContext = processTextMessage(message);
      messageType = "text";
    }

    if (!msgContext) {
      logger.log("Unsupported message type or processing failed");
      return null;
    }

    //  Download profile picture for the OTHER person (not you)
    let profileImage = null;
    if (!isFromMe && senderInfo.senderId) {
      try {
        const senderId = senderInfo.senderId.replace("@telegram", "");
        profileImage = await downloadProfilePicture(
          client,
          senderId,
          sessionId,
        );
      } catch (error) {
        // Silently fail
      }
    } else if (isFromMe && recipientInfo.id) {
      try {
        profileImage = await downloadProfilePicture(
          client,
          recipientInfo.id,
          sessionId,
        );
      } catch (error) {
        // Silently fail
      }
    }

    //  Create message object
    const processedMessage = {
      type: messageType,
      metaChatId: `tg_${message.id}`,
      msgContext,
      reaction: "",
      timestamp: message.date ? message.date : Math.floor(Date.now() / 1000),
      senderName: senderInfo.senderName,
      senderMobile: senderInfo.senderMobile,
      status: route === "OUTGOING" ? "sent" : "",
      star: false,
      route,
      context: message.replyTo?.replyToMsgId?.toString() || null,
      origin: "telegram",
      sentBy: null,
      //  CRITICAL: chatId is ALWAYS the OTHER person
      chatId: chatId,
      senderId: senderInfo.senderId,
      profileImage: profileImage,
      username: recipientInfo.username,
      userData: senderInfo.userData,
      sessionId,
      uid,
      //  Store recipient info for chat creation
      recipientInfo: recipientInfo,
    };

    // Save to database
    const savedMessageId = await saveMessageToDatabase(
      processedMessage,
      chatId,
      uid,
    );

    if (savedMessageId) {
      processedMessage.metaChatId = savedMessageId;
    }

    // Update chat with RECIPIENT info
    await updateChatInDatabase(processedMessage, uid, chatName);

    return {
      newMessage: processedMessage,
      chatId: chatId,
    };
  } catch (error) {
    logger.error("Error processing Telegram message:", error);
    return null;
  }
}

function setTelegramMsgObj(obj) {
  if (!obj || typeof obj !== "object") return null;

  switch (obj.type) {
    case "text":
      return {
        type: "text",
        message: obj.text?.body || "",
      };

    case "image":
      return {
        type: "photo",
        file: obj.image?.link,
        caption: obj.image?.caption || undefined,
      };

    case "video":
      return {
        type: "video",
        file: obj.video?.link,
        caption: obj.video?.caption || undefined,
      };

    case "audio":
      return {
        type: "audio",
        file: obj.audio?.link,
        voice: obj.audio?.isVoice || false,
      };

    case "document":
      return {
        type: "document",
        file: obj.document?.link,
        caption: obj.document?.caption || undefined,
        filename: obj.document?.filename || undefined,
      };

    case "location":
      return {
        type: "location",
        latitude: obj.location?.latitude,
        longitude: obj.location?.longitude,
        name: obj.location?.name || undefined,
      };

    case "contact":
      const contact = obj.contact?.contacts?.[0];
      if (!contact) return null;

      return {
        type: "contact",
        firstName: contact.name?.first_name || "",
        lastName: contact.name?.last_name || "",
        phoneNumber: contact.phones?.[0]?.phone || "",
      };

    case "sticker":
      return {
        type: "sticker",
        file: obj.sticker?.link,
      };

    default:
      return null;
  }
}

function extractTelegramChatId(chatId) {
  if (!chatId) return null;

  // Format: "123456789@telegram" or just "123456789"
  if (chatId.includes("@telegram")) {
    return chatId.split("@telegram")[0];
  }

  // If it's already a number
  if (/^\d+$/.test(chatId)) {
    return chatId;
  }

  return null;
}

async function getTelegramSessionFromChat(chatInfo, uid) {
  try {
    // Get all Telegram sessions for this user
    const sessions = await query(
      `SELECT session_id FROM telegram_session WHERE uid = ? AND status = 'active'`,
      [uid],
    );

    if (!sessions || sessions.length === 0) {
      return null;
    }

    // If only one session, return it
    if (sessions.length === 1) {
      return sessions[0].session_id;
    }

    // If multiple sessions, try to match by checking recent messages
    // This is a fallback - ideally you should store session_id in beta_chats
    for (const session of sessions) {
      const [recentMsg] = await query(
        `SELECT * FROM beta_conversation 
         WHERE chat_id = ? AND uid = ? AND origin = 'telegram' 
         ORDER BY timestamp DESC LIMIT 1`,
        [chatInfo.chat_id, uid],
      );

      if (recentMsg) {
        // Extract session from message metadata if stored
        // For now, return first active session
        return session.session_id;
      }
    }

    // Default to first active session
    return sessions[0].session_id;
  } catch (error) {
    logger.error("Error getting Telegram session:", error);
    return null;
  }
}

async function uploadFileToTelegram(client, filePath) {
  try {
    let actualFilePath;
    let fileName;

    const isUrl =
      filePath.startsWith("http://") || filePath.startsWith("https://");

    if (isUrl) {
      const urlObj = new URL(filePath);
      const cleanPath = urlObj.pathname.startsWith("/")
        ? urlObj.pathname.substring(1)
        : urlObj.pathname;

      actualFilePath = path.join(process.cwd(), "client", "public", cleanPath);

      fileName = path.basename(cleanPath);
    } else {
      const cleanPath = filePath.startsWith("/")
        ? filePath.substring(1)
        : filePath;

      actualFilePath = path.join(process.cwd(), "client", "public", cleanPath);

      fileName = path.basename(cleanPath);
    }

    //  Read file manually
    const fileBuffer = await fs.readFile(actualFilePath);
    const fileSize = fileBuffer.length;

    //  Create CustomFile
    const customFile = new CustomFile(fileName, fileSize, actualFilePath);

    //  Upload using buffer
    const file = await client.uploadFile({
      file: customFile,
      workers: 1,
    });

    return {
      file,
      fileName,
      fileSize,
    };
  } catch (error) {
    logger.error("Error uploading file to Telegram:", error);
    throw error;
  }
}

/**
 * Send message via Telegram with status tracking
 */
async function sendMessageTelegram({ uid, to, msgObj, chatInfo }) {
  try {
    // Get session ID
    const sessionId = await getTelegramSessionFromChat(chatInfo, uid);

    if (!sessionId) {
      return {
        success: false,
        msg: "No active Telegram session found. Please connect your Telegram account first.",
      };
    }

    // Get Telegram client
    const client = getSession(sessionId);

    if (!client) {
      return {
        success: false,
        msg: "Telegram session not found. Please reconnect your Telegram account.",
      };
    }

    // Extract chat ID (recipient)
    const chatId = extractTelegramChatId(to);

    if (!chatId) {
      return {
        success: false,
        msg: "Invalid Telegram chat ID",
      };
    }

    // Convert message object to Telegram format
    const telegramMsg = setTelegramMsgObj(msgObj);

    if (!telegramMsg) {
      return {
        success: false,
        msg: "Invalid message type or format",
      };
    }

    let sentMessage = null;

    // Send based on message type
    switch (telegramMsg.type) {
      case "text":
        sentMessage = await client.sendMessage(chatId, {
          message: telegramMsg.message,
        });
        break;

      case "photo":
        const photoFile = await uploadFileToTelegram(client, telegramMsg.file);
        sentMessage = await client.sendMessage(chatId, {
          message: telegramMsg.caption || "",
          file: photoFile.file,
        });
        break;

      case "video":
        const videoFile = await uploadFileToTelegram(client, telegramMsg.file);
        sentMessage = await client.sendMessage(chatId, {
          message: telegramMsg.caption || "",
          file: videoFile.file,
          attributes: [
            new Api.DocumentAttributeVideo({
              duration: 0,
              w: 0,
              h: 0,
              supportsStreaming: true,
            }),
          ],
        });
        break;

      case "audio":
        const audioFile = await uploadFileToTelegram(client, telegramMsg.file);

        if (telegramMsg.voice) {
          sentMessage = await client.sendMessage(chatId, {
            file: audioFile.file,
            attributes: [
              new Api.DocumentAttributeAudio({
                duration: 0,
                voice: true,
              }),
            ],
          });
        } else {
          sentMessage = await client.sendMessage(chatId, {
            file: audioFile.file,
            attributes: [
              new Api.DocumentAttributeAudio({
                duration: 0,
                title: audioFile.fileName,
                performer: "",
              }),
            ],
          });
        }
        break;

      case "document":
        const docFile = await uploadFileToTelegram(client, telegramMsg.file);
        sentMessage = await client.sendMessage(chatId, {
          message: telegramMsg.caption || "",
          file: docFile.file,
          attributes: [
            new Api.DocumentAttributeFilename({
              fileName: telegramMsg.filename || docFile.fileName,
            }),
          ],
        });
        break;

      case "location":
        sentMessage = await client.sendMessage(chatId, {
          message: telegramMsg.name || "Location",
          geoPoint: new Api.InputGeoPoint({
            lat: telegramMsg.latitude,
            long: telegramMsg.longitude,
          }),
        });
        break;

      case "contact":
        sentMessage = await client.sendMessage(chatId, {
          message: `${telegramMsg.firstName} ${telegramMsg.lastName}`.trim(),
          contact: new Api.InputMediaContact({
            phoneNumber: telegramMsg.phoneNumber,
            firstName: telegramMsg.firstName,
            lastName: telegramMsg.lastName,
          }),
        });
        break;

      case "sticker":
        const stickerFile = await uploadFileToTelegram(
          client,
          telegramMsg.file,
        );
        sentMessage = await client.sendMessage(chatId, {
          file: stickerFile.file,
          attributes: [
            new Api.DocumentAttributeSticker({
              alt: "🙂",
              stickerset: new Api.InputStickerSetEmpty(),
            }),
          ],
        });
        break;

      default:
        return {
          success: false,
          msg: "Unsupported message type",
        };
    }

    // Check if message was sent successfully
    if (sentMessage && sentMessage.id) {
      //  Telegram message is ALWAYS "sent" immediately if no error
      // There's no "delivered" or "read" status in Telegram API like WhatsApp
      return {
        success: true,
        id: `tg_${sentMessage.id}`,
        messageId: sentMessage.id,
        status: "sent", //  Telegram doesn't have delivery/read receipts
      };
    } else {
      return {
        success: false,
        msg: "Failed to send message",
      };
    }
  } catch (error) {
    logger.error("Error sending Telegram message:", error);
    return {
      success: false,
      msg: error.message || "Failed to send message",
      status: "failed", //  Mark as failed
    };
  }
}

/**
 * Send new message to a Telegram user (for starting new conversations)
 */
async function sendNewTelegramMessage({
  sessionId,
  message,
  username,
  userId,
}) {
  try {
    const client = getSession(sessionId);

    if (!client) {
      return {
        success: false,
        msg: "Telegram session not found. Please reconnect your account.",
      };
    }

    let entity;

    // Try to get entity by username or user ID
    if (username) {
      entity = await client.getEntity(username);
    } else if (userId) {
      entity = await client.getEntity(parseInt(userId));
    } else {
      return {
        success: false,
        msg: "Please provide either username or user ID",
      };
    }

    if (!entity) {
      return {
        success: false,
        msg: "User not found on Telegram",
      };
    }

    // Send message
    const sentMessage = await client.sendMessage(entity, {
      message: message,
    });

    if (sentMessage && sentMessage.id) {
      return {
        success: true,
        id: `tg_${sentMessage.id}`,
        messageId: sentMessage.id,
        chatId: entity.id?.toString(),
      };
    } else {
      return {
        success: false,
        msg: "Failed to send message",
      };
    }
  } catch (error) {
    logger.error("Error sending new Telegram message:", error);
    return {
      success: false,
      msg: error.message || "Failed to send message",
    };
  }
}

module.exports = {
  processMessageTelegram,
  formatTelegramId,
  extractUserDetails,
  extractChatDetails,
  sendMessageTelegram,
  sendNewTelegramMessage,
  setTelegramMsgObj,
  extractTelegramChatId,
};

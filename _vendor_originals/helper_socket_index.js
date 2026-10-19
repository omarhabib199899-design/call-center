const { query } = require("../../database/dbpromise");
const {
  mergeArraysWithPhonebook,
  deleteMediaFromConversation,
  returnMsgObjAfterAddingKey,
  sendMetaMsg,
  sendQrMsg,
  getCurrentTimestampInTimeZone,
  sendNewMessage,
  extractPhoneNumber,
  translateWithOpenAI,
  translateWithGemini,
  translateWithDeepseek,
  sendInstaMsg,
  sendMessengerMsg,
} = require("./function");
const {
  addObjectToFile,
  saveMessageToConversation,
  getRecentMessages,
  suggestReplyWithOpenAI,
  suggestReplyWithGemini,
  suggestReplyWithDeepseek,
  sendTemplateMessage,
} = require("../../functions/function.js");
const moment = require("moment-timezone");
const randomstring = require("randomstring");
const {
  sendMessageTelegram,
} = require("../addon/telegram/processTelegramInbox.js");
const logger = require("../../utils/logger.js");
const fetch = require("node-fetch");
const { handleForwardMessage } = require("./forwardMessage.js");

function processSocketEvent({
  socket,
  initializeSocket,
  sendToUid,
  sendToSocket,
  sendToAll,
  getConnectedUsers,
  getConnectionsByUid,
  getConnectionBySocketId,
  getAllSocketData,
}) {
  socket.on("message", async ({ type, payload }) => {
    const { isAgent, uid } = socket?.userData || {};

    try {
      switch (type) {
        case "get_chat_list":
          const {
            search = "",
            origin = "",
            unreadOnly = false,
            assignedOnly = false,
            dateRange = {},
            limit = 20,
            offset = 0,
            filterType = "all",
            hasNote = false,
            statusFilter = "all",
            agentFilter = "",
            labelFilter = "",
          } = payload;

          // Base query
          let queryStr = `FROM beta_chats WHERE `;
          const queryParams = [];
          let conditions = [];

          if (labelFilter) {
            conditions.push(`chat_label LIKE ?`);
            queryParams.push(`%"title":"${labelFilter}"%`);
          }

          // Agent vs user filtering
          if (isAgent) {
            // First restrict chats to the owner account.
            // This makes the assigned_agent LIKE scan much smaller.
            conditions.push(`uid = ?`);
            queryParams.push(socket?.userData?.owner_uid);

            // Then filter chats assigned to this agent.
            conditions.push(`(
              assigned_agent LIKE ? OR 
              assigned_agent LIKE ?
            )`);

            queryParams.push(
              `%"id":${socket.userData.id}%`,
              `%"id":"${socket.userData.id}"%`,
            );
          } else {
            conditions.push(`uid = ?`);
            queryParams.push(uid);
          }

          // Enhanced search to include chat tags
          if (search) {
            conditions.push(`(
            sender_name LIKE ? OR 
            sender_mobile LIKE ? OR 
            last_message LIKE ? OR
            chat_label LIKE ?
        )`);
            queryParams.push(
              `%${search}%`,
              `%${search}%`,
              `%${search}%`,
              `%"title":"${search}%`,
            );

            // Also search for partial matches in tag titles
            queryParams[queryParams.length - 1] = `%"title":"%${search}%"%`;
          }

          if (origin) {
            conditions.push(`origin = ?`);
            queryParams.push(origin);
          }

          if (unreadOnly) {
            conditions.push(`unread_count > 0`);
          }

          if (assignedOnly && isAgent) {
            conditions.push(
              `assigned_agent IS NOT NULL AND assigned_agent != 'null' AND assigned_agent != ''`,
            );
          }

          // Updated agent filter to work with both array and single object
          if (agentFilter) {
            conditions.push(`(
            assigned_agent LIKE ? OR 
            assigned_agent LIKE ?
        )`);
            queryParams.push(
              `%"name":"${agentFilter}"%`, // Matches when agent is in array
              `%"name":"${agentFilter}%"`, // Matches when agent is single object
            );
          }

          if (dateRange.start) {
            conditions.push(`createdAt >= ?`);
            queryParams.push(
              moment(dateRange.start).format("YYYY-MM-DD HH:mm:ss"),
            );
          }

          if (dateRange.end) {
            conditions.push(`createdAt <= ?`);
            queryParams.push(
              moment(dateRange.end).format("YYYY-MM-DD HH:mm:ss"),
            );
          }

          // Status filter
          if (statusFilter === "read") {
            conditions.push(`unread_count = 0`);
          } else if (statusFilter === "unread") {
            conditions.push(`unread_count > 0`);
          }

          // Has Note filter
          if (hasNote) {
            conditions.push(`(chat_note IS NOT NULL AND chat_note != '')`);
          }

          queryStr += conditions.join(" AND ");

          // Rest of your query execution remains the same
          const [totalResult] = await query(
            `SELECT COUNT(*) as total ${queryStr}`,
            queryParams,
          );
          const total = totalResult.total;

          const chats = await query(
            `SELECT * ${queryStr} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`,
            [...queryParams, limit, offset],
          );

          const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
            isAgent ? socket?.userData?.owner_uid : uid,
          ]);
          const chatData = mergeArraysWithPhonebook(chats, contacts);

          const agentData = await query(
            `SELECT * FROM agents WHERE owner_uid = ?`,
            [uid],
          );

          socket.emit("chat_list", {
            chats: chatData,
            total,
            offset,
            agentData,
          });
          break;

        case "export_chats": {
          const {
            chatIds = [], // empty array = export ALL
            format = "json", // "json" | "csv"
          } = payload;

          const ownerUid = isAgent ? socket?.userData?.owner_uid : uid;

          let chats;
          if (chatIds.length > 0) {
            // Export selected chats
            const placeholders = chatIds.map(() => "?").join(",");
            chats = await query(
              `SELECT * FROM beta_chats WHERE uid = ? AND chat_id IN (${placeholders})`,
              [ownerUid, ...chatIds],
            );
          } else {
            // Export ALL chats
            chats = await query(`SELECT * FROM beta_chats WHERE uid = ?`, [
              ownerUid,
            ]);
          }

          // Enrich with phonebook contact names
          const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
            ownerUid,
          ]);

          const enriched = chats.map((chat) => {
            const contact = contacts.find(
              (c) => String(c.mobile) === String(chat.sender_mobile),
            );
            let lastMsg = null;
            try {
              lastMsg = JSON.parse(chat.last_message);
            } catch {}
            return {
              chat_id: chat.chat_id,
              sender_name: contact?.name || chat.sender_name || "",
              sender_mobile: chat.sender_mobile,
              origin: chat.origin,
              unread_count: chat.unread_count,
              status: chat.unread_count > 0 ? "unread" : "read",
              last_message_type: lastMsg?.type || "",
              last_message_body: lastMsg?.msgContext?.text?.body || "",
              last_message_timestamp: lastMsg?.timestamp || "",
              assigned_agent: (() => {
                try {
                  const a = JSON.parse(chat.assigned_agent || "[]");
                  return Array.isArray(a)
                    ? a.map((x) => x.name).join(", ")
                    : a?.name || "";
                } catch {
                  return "";
                }
              })(),
              labels: (() => {
                try {
                  const l = JSON.parse(chat.chat_label || "[]");
                  return Array.isArray(l)
                    ? l.map((x) => x.title).join(", ")
                    : l?.title || "";
                } catch {
                  return "";
                }
              })(),
              created_at: chat.createdAt,
              updated_at: chat.updatedAt,
            };
          });

          if (format === "csv") {
            const headers = Object.keys(enriched[0] || {});
            const csvRows = [
              headers.join(","),
              ...enriched.map((row) =>
                headers
                  .map((h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`)
                  .join(","),
              ),
            ];
            socket.emit("export_chats_result", {
              format: "csv",
              data: csvRows.join("\n"),
              count: enriched.length,
            });
          } else {
            socket.emit("export_chats_result", {
              format: "json",
              data: JSON.stringify(enriched, null, 2),
              count: enriched.length,
            });
          }
          break;
        }

        case "export_conversation": {
          const { chatId: exportChatId, format: exportFormat = "json" } =
            payload;

          if (!exportChatId) {
            return socket.emit("error", {
              msg: "Chat ID is required for export",
            });
          }

          const ownerUid = isAgent ? socket?.userData?.owner_uid : uid;

          const [chatRow] = await query(
            `SELECT * FROM beta_chats WHERE chat_id = ? AND uid = ?`,
            [exportChatId, ownerUid],
          );

          const messages = await query(
            `SELECT * FROM beta_conversation WHERE chat_id = ? AND uid = ? ORDER BY timestamp ASC`,
            [exportChatId, ownerUid],
          );

          const parsed = messages.map((m) => {
            let ctx = null;
            try {
              ctx = JSON.parse(m.msgContext);
            } catch {}
            return {
              id: m.id,
              route: m.route,
              type: m.type,
              sender_name: m.senderName,
              sender_mobile: m.senderMobile,
              timestamp: m.timestamp,
              timestamp_readable: m.timestamp
                ? new Date(m.timestamp * 1000).toISOString()
                : "",
              message_body: ctx?.text?.body || "",
              media_link:
                ctx?.image?.link ||
                ctx?.video?.link ||
                ctx?.audio?.link ||
                ctx?.document?.link ||
                "",
              media_caption:
                ctx?.image?.caption ||
                ctx?.video?.caption ||
                ctx?.document?.caption ||
                "",
              status: m.status || "",
              sent_by: m.sentBy || "user",
              origin: chatRow?.origin || "",
            };
          });

          if (exportFormat === "csv") {
            const headers = Object.keys(parsed[0] || {});
            const csvRows = [
              headers.join(","),
              ...parsed.map((row) =>
                headers
                  .map((h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`)
                  .join(","),
              ),
            ];
            socket.emit("export_conversation_result", {
              format: "csv",
              data: csvRows.join("\n"),
              count: parsed.length,
              chatId: exportChatId,
            });
          } else {
            socket.emit("export_conversation_result", {
              format: "json",
              data: JSON.stringify(parsed, null, 2),
              count: parsed.length,
              chatId: exportChatId,
            });
          }
          break;
        }

        case "load_conversation":
          const { chat, filters = {} } = payload;

          const {
            search: msgSearch = "",
            dateRange: msgDateRange = {},
            limit: msgLimit = 20,
            offset: msgOffset = 0,
          } = filters;

          // unreading the message count
          await query(`UPDATE beta_chats SET unread_count = ? WHERE id = ?`, [
            0,
            chat?.id,
          ]);

          // Build query for conversations with filters
          let conversationQueryStr = `FROM beta_conversation WHERE chat_id = ? AND uid = ?`;
          const conversationParams = [
            chat.chat_id,
            isAgent ? socket?.userData?.owner_uid : uid,
          ];

          // Add search filter if provided
          if (msgSearch) {
            conversationQueryStr += ` AND msgContext LIKE ?`;
            conversationParams.push(`%${msgSearch}%`);
          }

          // Add date range filters if provided
          if (msgDateRange.start) {
            conversationQueryStr += ` AND timestamp >= ?`;
            conversationParams.push(moment(msgDateRange.start).unix());
          }

          if (msgDateRange.end) {
            conversationQueryStr += ` AND timestamp <= ?`;
            conversationParams.push(moment(msgDateRange.end).unix());
          }

          // Get total count for pagination
          const [conversationTotalResult] = await query(
            `SELECT COUNT(*) as total ${conversationQueryStr}`,
            conversationParams,
          );
          const conversationTotal = conversationTotalResult.total;

          // Get conversations with pagination
          const conversationData = await query(
            `SELECT * ${conversationQueryStr} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
            [...conversationParams, msgLimit, msgOffset],
          );

          const parsedChatList = conversationData.map((row) => ({
            ...row,
            msgContext: row.msgContext ? JSON.parse(row.msgContext) : null,
            context: row.context ? JSON.parse(row.context) : null,
          }));

          const labelAdded = await query(
            `SELECT * FROM chat_tags WHERE uid = ?`,
            [isAgent ? socket?.userData?.owner_uid : uid],
          );

          let [updatedChat] = await query(
            `SELECT * FROM beta_chats WHERE id = ?`,
            [chat?.id],
          );
          const agents = await query(
            `SELECT * FROM agents WHERE owner_uid = ?`,
            [uid],
          );

          const [getContact] = await query(
            `SELECT * FROM contact WHERE uid = ? AND mobile = ?`,
            [
              isAgent ? socket?.userData?.owner_uid : uid,
              updatedChat?.sender_mobile,
            ],
          );

          const phonebookData = await query(
            `SELECT * FROM phonebook WHERE uid = ?`,
            [isAgent ? socket?.userData?.owner_uid : uid],
          );

          updatedChat = { ...updatedChat, contactData: getContact || null };
          updatedChat.chat_note = updatedChat?.chat_note
            ? JSON.parse(updatedChat?.chat_note)
            : [];

          if (socket?.userData?.role === "agent") {
            updatedChat.chat_note = updatedChat.chat_note?.filter(
              (x) => x.email === socket?.userData?.email,
            );
          }

          const chatBots = await query(
            `SELECT * FROM beta_chatbot WHERE uid = ? AND active = ? AND source = ?`,
            [isAgent ? socket?.userData?.owner_uid : uid, 1, "wa_chatbot"],
          );

          const [lastSenderMsg] = await query(
            `SELECT * 
                FROM beta_conversation 
                WHERE chat_id = ? AND route = ? AND uid = ?
                ORDER BY timestamp DESC 
                LIMIT 1`,
            [
              chat.chat_id,
              "INCOMING",
              isAgent ? socket?.userData?.owner_uid : uid,
            ],
          );

          socket.emit("load_conversation", {
            conversation: parsedChatList,
            total: conversationTotal,
            offset: msgOffset,
            chatInfo: updatedChat,
            labelsAdded: labelAdded,
            agentData: agents,
            countDownTimer: {
              timestamp: lastSenderMsg?.timestamp ? lastSenderMsg.timestamp : 0,
              timezone: socket?.userData?.timezone || "Asia/Kolkata",
            },
            phonebookData: phonebookData,
            chatBots: chatBots,
          });
          break;

        case "add_label":
          const { label, hex } = payload;
          if (!label || !hex) {
            return socket.emit("error", {
              msg: "Please provide Label",
            });
          }

          const labelsData = await query(
            `SELECT * FROM chat_tags WHERE uid = ?`,
            [uid],
          );
          const allLablesTitles = labelsData?.map((x) => x.title);
          if (allLablesTitles?.includes(label)) {
            return socket.emit("error", {
              msg: "Duplicate label is not allowed",
            });
          }

          await query(
            `INSERT INTO chat_tags (uid, hex, title) VALUES (?,?,?)`,
            [uid, hex, label],
          );

          const labelsDataNew = await query(
            `SELECT * FROM chat_tags WHERE uid = ?`,
            [uid],
          );

          socket.emit("update_labels", labelsDataNew);
          break;

        case "on_label_delete":
          const { labelId } = payload;
          await query(`DELETE FROM chat_tags WHERE id = ?`, [labelId]);

          const labelNew = await query(
            `SELECT * FROM chat_tags WHERE uid = ?`,
            [uid],
          );

          socket.emit("update_labels", labelNew);
          break;

        case "set_chat_label":
          const { labelData, chatIdRow } = payload;
          if (!labelData || !chatIdRow) {
            return socket.emit("error", {
              msg: "Invalid request",
            });
          }

          // Get existing labels first
          const [existingLabelsRow] = await query(
            `SELECT chat_label FROM beta_chats WHERE id = ?`,
            [chatIdRow],
          );

          let existingLabels = [];
          if (existingLabelsRow?.chat_label) {
            try {
              const parsed = JSON.parse(existingLabelsRow.chat_label);
              // Handle both single object and array formats
              existingLabels = Array.isArray(parsed) ? parsed : [parsed];
            } catch (err) {
              existingLabels = [];
            }
          }

          // Check if this label already exists (avoid duplicates)
          const labelExists = existingLabels.some(
            (label) => label.id === labelData.id,
          );

          // If it doesn't exist, add it to the array
          if (!labelExists) {
            existingLabels.push(labelData);
          }

          // Update with the new labels array
          await query(`UPDATE beta_chats SET chat_label = ? WHERE id = ?`, [
            JSON.stringify(existingLabels),
            chatIdRow,
          ]);

          socket.emit("request_update_opened_chat", {});
          socket.emit("request_update_chat_list", {});
          break;

        case "remove_chat_label":
          const { labelId: labelIdd, chatId: chatIdd } = payload;
          if (!labelIdd || !chatIdd) {
            return socket.emit("error", {
              msg: "Invalid request",
            });
          }

          // Get existing labels
          const [labelsRow] = await query(
            `SELECT chat_label FROM beta_chats WHERE id = ?`,
            [chatIdd],
          );

          if (labelsRow?.chat_label) {
            let labels = [];
            try {
              labels = JSON.parse(labelsRow.chat_label);
              // Ensure we're working with an array
              if (!Array.isArray(labels)) {
                labels = [labels];
              }

              // Filter out the label to remove
              const updatedLabels = labels.filter(
                (label) => label.id !== labelIdd,
              );

              // Update the database
              await query(`UPDATE beta_chats SET chat_label = ? WHERE id = ?`, [
                JSON.stringify(updatedLabels),
                chatIdd,
              ]);
            } catch (err) {
              logger.error("Error parsing labels:", err);
            }
          }

          socket.emit("request_update_opened_chat", {});
          socket.emit("request_update_chat_list", {});
          break;

        case "delete_chat_note":
          const { chatNoteId, chatRealId } = payload;

          if (chatNoteId && chatRealId) {
            const [getFirst] = await query(
              `SELECT * FROM beta_chats WHERE id = ?`,
              [chatRealId],
            );

            // get notes array
            const oldNotes = JSON.parse(getFirst?.chat_note || "[]");

            // filter out the note to be deleted
            const newNotes = oldNotes.filter((note) => note.id !== chatNoteId);

            await query(`UPDATE beta_chats SET chat_note = ? WHERE id = ?`, [
              JSON.stringify(newNotes),
              chatRealId,
            ]);
          }

          socket.emit("request_update_opened_chat", {});
          break;

        case "save_chat_note":
          const { id, chatNote, rating } = payload;

          if (id) {
            const [getFirst] = await query(
              `SELECT * FROM beta_chats WHERE id = ?`,
              [id],
            );

            // get notes array
            const oldNotes = JSON.parse(getFirst?.chat_note || "[]");
            const { email: userEmail, name: userName } = socket?.userData;

            const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [
              isAgent ? socket?.userData?.owner_uid : uid,
            ]);

            const userTimezone = getCurrentTimestampInTimeZone(
              user?.timezone || "Asia/Kolkata",
            );

            // adding new array with rating included
            const newArr = [
              ...oldNotes,
              {
                email: userEmail,
                name: userName,
                note: chatNote,
                rating: rating || 0, // Include the rating (default to 0 if not provided)
                craetedAt: userTimezone,
                id: randomstring.generate(5),
              },
            ];

            await query(`UPDATE beta_chats SET chat_note = ? WHERE id = ?`, [
              JSON.stringify(newArr),
              id,
            ]);
          }
          socket.emit("request_update_opened_chat", {});
          break;

        case "send_chat_message":
          const { type, msgCon, chatInfo } = payload;

          if (!msgCon || !type) {
            return socket.emit("error", {
              msg: "Please add a message",
            });
          }

          const senderName = chatInfo?.sender_name;
          const senderMobile = chatInfo?.sender_mobile;

          if (!senderMobile || !senderMobile) {
            return socket.emit("error", { msg: "Please refresh the page" });
          }

          const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [
            isAgent ? socket?.userData?.owner_uid : uid,
          ]);

          const userTimezone = getCurrentTimestampInTimeZone(
            user?.timezone || "Asia/Kolkata",
          );

          const msgObj = returnMsgObjAfterAddingKey({
            msgContext: msgCon,
            type,
            timestamp: userTimezone || "NA",
            senderName: senderName || "NA",
            senderMobile: senderMobile || "NA",
          });

          let sendMsg;

          if (chatInfo?.origin === "qr") {
            sendMsg = await sendQrMsg({
              msgObj: msgCon,
              to: senderMobile,
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatInfo,
            });
          } else if (chatInfo?.origin === "instagram") {
            sendMsg = await sendInstaMsg({
              msgObj: msgCon,
              to: senderMobile, // this is the other person's IGSID
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatInfo,
            });
          } else if (chatInfo?.origin === "instagram_comment") {
            // ✅ ADD THIS
            sendMsg = await sendInstaMsg({
              msgObj: msgCon,
              to: senderMobile, // strip suffix → raw IGSID
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatInfo, // has origin_instance_id as JSON object now
            });
          } else if (chatInfo?.origin === "messenger") {
            sendMsg = await sendMessengerMsg({
              msgObj: msgCon,
              to: senderMobile,
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatInfo,
            });
          } else if (chatInfo?.origin === "meta") {
            sendMsg = await sendMetaMsg({
              msgObj: msgCon,
              to: senderMobile,
              uid: isAgent ? socket?.userData?.owner_uid : uid,
            });
          } else if (chatInfo?.origin === "telegram") {
            sendMsg = await sendMessageTelegram({
              msgObj: msgCon,
              to: senderMobile,
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatInfo,
            });
          }

          if (!sendMsg?.success) {
            logger.error("[send_chat_message] Send failed:", sendMsg);
            let errorMsg = sendMsg?.msg || "Failed to send message";
            if (sendMsg?.code) errorMsg += ` (Code: ${sendMsg.code})`;
            if (sendMsg?.isTransient)
              errorMsg += ` — Transient error, please retry`;
            if (sendMsg?.fbtrace_id)
              errorMsg += ` [trace: ${sendMsg.fbtrace_id}]`;

            return socket.emit("error", { msg: errorMsg });
          }

          if (sendMsg?.id) {
            const msgObjNew = { ...msgObj, metaChatId: sendMsg?.id };

            const messageData = {
              type: msgObjNew.type,
              metaChatId: msgObjNew.metaChatId,
              msgContext: msgObjNew.msgContext,
              reaction: msgObjNew.reaction || "",
              timestamp: msgObjNew.timestamp,
              senderName: msgObjNew.senderName,
              senderMobile: msgObjNew.senderMobile,
              star: msgObjNew.star ? 1 : 0,
              route: msgObjNew.route,
              context: msgObjNew.context || null,
              origin: msgObjNew.origin,
            };

            await saveMessageToConversation({
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatId: chatInfo.chat_id,
              messageData,
            });

            await query(
              `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
              [
                JSON.stringify(messageData),
                chatInfo.chat_id,
                isAgent ? socket?.userData?.owner_uid : uid,
              ],
            );

            socket.emit("request_update_chat_list", {
              chatId: chatInfo?.chat_id,
            });
          }

          break;

        case "send_template_to_conversation": {
          const {
            chatInfo: tplChatInfo,
            templateName,
            templateBody,
            templateLanguage,
            messageId,
          } = payload;

          if (!tplChatInfo?.chat_id || !templateBody) {
            return socket.emit("error", { msg: "Invalid template payload" });
          }

          const [tplUser] = await query(`SELECT * FROM user WHERE uid = ?`, [
            isAgent ? socket?.userData?.owner_uid : uid,
          ]);

          const tplTimestamp = getCurrentTimestampInTimeZone(
            tplUser?.timezone || "Asia/Kolkata",
          );

          const templateMsgData = {
            type: "text",
            metaChatId: messageId || "",
            msgContext: {
              type: "text",
              text: {
                preview_url: false,
                body: `📋 *${templateName}*\n\n${templateBody}`,
              },
            },
            reaction: "",
            timestamp: tplTimestamp,
            senderName: tplChatInfo?.sender_name || "NA",
            senderMobile: tplChatInfo?.sender_mobile || "NA",
            status: "sent",
            star: false,
            route: "OUTGOING",
            context: null,
            origin: "meta",
            sentBy: "template",
          };

          await saveMessageToConversation({
            uid: isAgent ? socket?.userData?.owner_uid : uid,
            chatId: tplChatInfo.chat_id,
            messageData: templateMsgData,
          });

          await query(
            `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
            [
              JSON.stringify(templateMsgData),
              tplChatInfo.chat_id,
              isAgent ? socket?.userData?.owner_uid : uid,
            ],
          );

          socket.emit("request_update_chat_list", {
            chatId: tplChatInfo.chat_id,
          });
          // Trigger conversation reload so the message appears immediately
          socket.emit("request_update_opened_chat", {});
          break;
        }

        case "forward_message":
          await handleForwardMessage({
            payload,
            uid,
            socket,
            agent: isAgent,
            ownerUid: isAgent ? socket?.userData?.owner_uid : uid,
          });
          break;

        case "unasign_chat_agent":
          const { cId, aUid } = payload;

          // Get current chat data
          const [chatDataoo] = await query(
            `SELECT assigned_agent FROM beta_chats WHERE chat_id = ? AND uid = ?`,
            [cId, isAgent ? socket?.userData?.owner_uid : uid],
          );

          let currentAgentss = [];
          try {
            // Parse existing agents (handle both string and array cases)
            const parsed = chatDataoo?.assigned_agent
              ? JSON.parse(chatDataoo.assigned_agent)
              : [];
            currentAgentss = Array.isArray(parsed)
              ? parsed
              : [parsed].filter(Boolean);
          } catch (e) {
            logger.error("Error parsing assigned_agent:", e);
          }

          // Remove the agent from the array
          const updatedAgents = currentAgentss.filter(
            (agent) => agent.uid !== aUid,
          );

          logger.dir(
            "[unasign_chat_agent] updatedAgents:",
            JSON.stringify(updatedAgents),
          );

          await query(
            `UPDATE beta_chats
              SET assigned_agent = ?
              WHERE chat_id = ? AND uid = ?`,
            [
              JSON.stringify(updatedAgents),
              cId,
              isAgent ? socket?.userData?.owner_uid : uid,
            ],
          );

          socket.emit("request_update_chat_list", {});
          break;

        case "assign_agent_to_chat":
          const { chatId, agentUid, unAssign } = payload;

          // Get current chat data
          const [chatDatao] = await query(
            `SELECT assigned_agent FROM beta_chats WHERE chat_id = ? AND uid = ?`,
            [chatId, uid],
          );

          let currentAgents = [];
          try {
            // Parse existing agents (handle both string and array cases)
            const parsed = chatDatao?.assigned_agent
              ? JSON.parse(chatDatao.assigned_agent)
              : [];
            currentAgents = Array.isArray(parsed)
              ? parsed
              : [parsed].filter(Boolean);
          } catch (e) {
            logger.error("Error parsing assigned_agent:", e);
          }

          if (unAssign) {
            // Remove the agent from the array
            const updatedAgents = currentAgents.filter(
              (agent) => agent.uid !== agentUid,
            );

            await query(
              `UPDATE beta_chats
                  SET assigned_agent = ?
                  WHERE chat_id = ? AND uid = ?`,
              [JSON.stringify(updatedAgents), chatId, uid],
            );
          } else {
            if (chatId && agentUid) {
              // Check if agent already exists
              const agentExists = currentAgents.some(
                (agent) => agent.uid === agentUid,
              );

              if (!agentExists) {
                // Get agent data
                const [agentData] = await query(
                  `SELECT * FROM agents WHERE uid = ? AND owner_uid = ?`,
                  [agentUid, uid],
                );

                if (agentData) {
                  // Add new agent to the array
                  const updatedAgents = [...currentAgents, agentData];

                  await query(
                    `UPDATE beta_chats SET assigned_agent = ? WHERE chat_id = ? AND uid = ?`,
                    [JSON.stringify(updatedAgents), chatId, uid],
                  );
                }
              }
            }
          }

          socket.emit("request_update_opened_chat", {});
          break;

        case "send_new_message":
          const { instance, number, message, recName } = payload;

          if (!number || !message) {
            return socket.emit("error", {
              msg: "Please add a message",
            });
          }

          const chatid = `${instance?.number}_${number?.replace("+", "")}_${
            isAgent ? socket?.userData?.owner_uid : uid
          }`;

          // checking if chat already existed
          const [checkChat] = await query(
            `SELECT * FROM beta_chats WHERE chat_id = ? AND uid = ?`,
            [chatid, isAgent ? socket?.userData?.owner_uid : uid],
          );
          if (checkChat) {
            return socket.emit("error", {
              msg: "Chat already existed",
            });
          }

          const sendNewMsg = await sendNewMessage({
            sessionId: instance?.uniqueId,
            message,
            number,
          });

          if (!sendNewMsg?.success) {
            return socket.emit("error", {
              msg: sendNewMsg?.msg,
            });
          }

          if (sendNewMsg?.id) {
            const userTimezone = getCurrentTimestampInTimeZone(
              socket?.userData?.timezone || "Asia/Kolkata",
            );

            const msgObj = returnMsgObjAfterAddingKey({
              msgContext: {
                type: "text",
                text: { preview_url: true, body: message },
              },
              type: "text",
              timestamp: userTimezone || "NA",
              senderName: recName || "NA",
              senderMobile: number?.replace("+", "") || "NA",
            });

            const msgObjNew = { ...msgObj, metaChatId: sendNewMsg?.id };

            const messageData = {
              type: msgObjNew.type,
              metaChatId: msgObjNew.metaChatId,
              msgContext: msgObjNew.msgContext,
              reaction: msgObjNew.reaction || "",
              timestamp: msgObjNew.timestamp,
              senderName: msgObjNew.senderName,
              senderMobile: msgObjNew.senderMobile,
              star: msgObjNew.star ? 1 : 0,
              route: msgObjNew.route,
              context: msgObjNew.context || null,
              origin: "qr",
            };

            await saveMessageToConversation({
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatId: chatid,
              messageData,
            });

            const originInstanceId =
              sendNewMsg?.sessionData?.authState?.creds?.me ||
              sendNewMsg?.sessionData.user;

            await query(
              `INSERT INTO beta_chats (uid, origin_instance_id, chat_id, last_message, sender_mobile, origin, assigned_agent) VALUES (?,?,?,?,?,?,?)`,
              [
                isAgent ? socket?.userData?.owner_uid : uid,
                JSON.stringify(originInstanceId),
                chatid,
                JSON.stringify(messageData),
                number?.replace("+", ""),
                "qr",
                isAgent ? JSON.stringify([socket?.userData]) : null,
              ],
            );

            socket.emit("request_update_chat_list", {
              chatId: chatid,
            });
          }

          break;

        case "send_new_meta_chat": {
          const {
            recipient_phone,
            template_name,
            template_language,
            body_variables,
            header_variable,
            button_variables,
            template_type,
            templateBody, // pre-filled body text for bubble display
          } = payload;

          if (!recipient_phone || !template_name) {
            return socket.emit("error", {
              msg: "Recipient phone and template name are required",
            });
          }

          const ownerUid = isAgent ? socket?.userData?.owner_uid : uid;

          // 1. Get meta API keys
          const [metaApi] = await query(
            `SELECT * FROM meta_api WHERE uid = ? LIMIT 1`,
            [ownerUid],
          );

          if (!metaApi?.access_token || !metaApi?.business_phone_number_id) {
            return socket.emit("error", {
              msg: "Please configure your Meta API keys first",
            });
          }

          const formattedPhone = recipient_phone.replace(/\D/g, "");

          // Fetch template definition for flow button support
          let templateDef = null;
          try {
            const tplRes = await fetch(
              `https://graph.facebook.com/v20.0/${metaApi.waba_id}/message_templates?name=${encodeURIComponent(template_name)}&fields=name,components,language,status`,
              {
                headers: { Authorization: `Bearer ${metaApi.access_token}` },
              },
            );
            const tplData = await tplRes.json();
            templateDef = tplData?.data?.[0] || null;
          } catch (e) {
            // non-fatal
          }

          const flowBtn = (button_variables || []).find(
            (bv) => bv.sub_type === "flow",
          );
          const flowButtonToken = flowBtn?.flow_token || null;
          const regularButtonVars = (button_variables || []).filter(
            (bv) => bv.sub_type !== "flow",
          );

          const sendResult = await sendTemplateMessage(
            "v20.0",
            metaApi.business_phone_number_id,
            metaApi.access_token,
            template_name,
            template_language || "en_US",
            formattedPhone,
            body_variables || [],
            header_variable || null,
            regularButtonVars,
            flowButtonToken,
            templateDef,
          );

          if (sendResult?.error) {
            return socket.emit("error", {
              msg:
                sendResult.error?.message || "Failed to send template message",
            });
          }

          const metaMsgId = sendResult?.messages?.[0]?.id || "";

          // 3. Get user timezone
          const [userRow] = await query(`SELECT * FROM user WHERE uid = ?`, [
            ownerUid,
          ]);

          const timestamp = getCurrentTimestampInTimeZone(
            userRow?.timezone || "Asia/Kolkata",
          );

          // 4. Build the chat_id for meta: "meta_<recipientPhone>_<ownerUid>"
          const chatId = `meta_${formattedPhone}`;

          // 5. Build message data
          const messageData = {
            type: "text",
            metaChatId: metaMsgId,
            msgContext: {
              type: "text",
              text: {
                preview_url: false,
                body: `📋 *${template_name}*\n\n${templateBody || ""}`,
              },
            },
            reaction: "",
            timestamp,
            senderName: "",
            senderMobile: formattedPhone,
            status: "sent",
            star: false,
            route: "OUTGOING",
            context: null,
            origin: "meta",
            sentBy: "template",
          };

          // 6. Upsert beta_chats
          const [existingChat] = await query(
            `SELECT id FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
            [chatId, ownerUid],
          );

          if (existingChat) {
            // Chat already exists — just update last_message
            await query(
              `UPDATE beta_chats 
                SET last_message = ?, sender_mobile = ?, origin = ?
                WHERE chat_id = ? AND uid = ?`,
              [
                JSON.stringify(messageData),
                formattedPhone,
                "meta",
                chatId,
                ownerUid,
              ],
            );
          } else {
            // Create new chat row
            await query(
              `INSERT INTO beta_chats 
                (uid, chat_id, last_message, sender_name, sender_mobile, 
                  origin, origin_instance_id, unread_count, assigned_agent) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                ownerUid,
                chatId,
                JSON.stringify(messageData),
                "",
                formattedPhone,
                "meta",
                JSON.stringify({
                  id: metaApi.business_phone_number_id,
                }),
                0,
                isAgent ? JSON.stringify([socket?.userData]) : null,
              ],
            );
          }

          await saveMessageToConversation({
            uid: ownerUid,
            chatId,
            messageData,
          });

          // 8. Notify frontend to refresh chat list
          socket.emit("new_meta_chat_created", {
            success: true,
            chatId,
            phone: formattedPhone,
          });

          socket.emit("request_update_chat_list", { chatId });

          break;
        }

        case "delete_chat":
          const { chatId: delChatId, type: deleteType } = payload;
          if (delChatId && deleteType) {
            await query(
              `DELETE FROM beta_chats WHERE chat_id = ? AND uid = ?`,
              [delChatId, isAgent ? socket?.userData?.owner_uid : uid],
            );
            const metaMediaFolder = `${__dirname}/../../client/public/meta-media`;
            const conversationData = await query(
              `SELECT * FROM beta_conversation WHERE chat_id = ? AND uid = ?`,
              [delChatId, isAgent ? socket?.userData?.owner_uid : uid],
            );
            await deleteMediaFromConversation({
              mediaFolderPath: metaMediaFolder,
              type: deleteType,
              uid: isAgent ? socket?.userData?.owner_uid : uid,
              chatId: delChatId,
              conversationData,
            });

            if (deleteType === "delete") {
              await query(
                `DELETE FROM beta_chats WHERE chat_id = ? AND uid = ?`,
                [delChatId, isAgent ? socket?.userData?.owner_uid : uid],
              );
            }

            socket.emit("request_update_chat_list", {});
          }
          break;

        case "save_as_context":
          const {
            conName,
            conMob,
            var1,
            var2,
            var3,
            var4,
            var5,
            phonebookDataa,
          } = payload;

          if (!conName || !conMob) {
            return socket.emit("error", {
              msg: "Please fill name and mobile number",
            });
          }

          const checkExisted = await query(
            `SELECT * FROM contact WHERE uid = ? AND mobile = ?`,
            [isAgent ? socket?.userData?.owner_uid : uid, Number(conMob)],
          );

          if (checkExisted?.length > 0) {
            return socket.emit("error", {
              msg: "Contact already existed",
            });
          }

          if (!phonebookDataa?.id) {
            return socket.emit("error", { msg: "Please select a phonebook" });
          }

          await query(
            `INSERT INTO contact (uid, phonebook_id, phonebook_name, name, mobile, var1, var2, var3, var4, var5) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              isAgent ? socket?.userData?.owner_uid : uid,
              phonebookDataa?.id,
              phonebookDataa?.name,
              conName,
              conMob,
              var1,
              var2,
              var3,
              var4,
              var5,
            ],
          );

          socket.emit("request_update_chat_list");
          socket.emit("request_update_opened_chat");

          break;

        case "del_contact":
          const { contactId } = payload;
          await query(`DELETE FROM contact WHERE id = ?`, [contactId]);
          socket.emit("request_update_chat_list");
          socket.emit("request_update_opened_chat");

          break;

        case "update_spend_time":
          const { uid: agentUidd, timeSpent } = payload;

          if (!agentUidd || !timeSpent) {
            return socket.emit("error", { msg: "Invalid time update request" });
          }

          // Get current date in server timezone
          const today = moment().format("YYYY-MM-DD");

          // Get existing logs
          const [agentDataa] = await query(
            `SELECT logs FROM agents WHERE uid = ?`,
            [agentUidd],
          );

          let logs = {};
          try {
            logs = agentDataa?.logs ? JSON.parse(agentDataa.logs) : {};
          } catch (e) {
            logger.error("Error parsing logs:", e);
            logs = {};
          }

          // Initialize spendTime if not exists
          if (!logs.spendTime) {
            logs.spendTime = {};
          }

          // Update today's time
          logs.spendTime[today] = (logs.spendTime[today] || 0) + timeSpent;

          // Save updated logs
          await query(`UPDATE agents SET logs = ? WHERE uid = ?`, [
            JSON.stringify(logs),
            agentUidd,
          ]);

          break;

        case "translate_message":
          const { text, targetLanguage, provider, apiKey } = payload;

          if (!text || !targetLanguage || !provider || !apiKey) {
            return socket.emit("error", {
              msg: "Missing required parameters for translation",
            });
          }

          try {
            let translatedText = "";

            // Call the appropriate translation function based on provider
            if (provider === "openai") {
              translatedText = await translateWithOpenAI(
                text,
                targetLanguage,
                apiKey,
              );
            } else if (provider === "gemini") {
              translatedText = await translateWithGemini(
                text,
                targetLanguage,
                apiKey,
              );
            } else if (provider === "deepseek") {
              translatedText = await translateWithDeepseek(
                text,
                targetLanguage,
                apiKey,
              );
            } else {
              return socket.emit("error", {
                msg: "Unsupported AI provider",
              });
            }

            socket.emit("translation_result", {
              success: true,
              translatedText,
            });
          } catch (error) {
            logger.error("Translation error:", error);
            socket.emit("error", {
              msg: error.message || "Translation failed",
            });
          }
          break;

        case "suggest_reply":
          const {
            chatId: chatIddd,
            lastMessage: lastMsg,
            provider: aiProvider,
            apiKey: aiKey,
          } = payload;

          if (!chatIddd || !aiProvider || !aiKey) {
            return socket.emit("error", {
              msg: "Missing required parameters for suggestion",
            });
          }

          try {
            // Get recent messages for context
            const recentMessages = await getRecentMessages(
              chatIddd,
              isAgent ? socket?.userData?.owner_uid : uid,
              5,
            );

            let suggestion = "";

            // Call the appropriate suggestion function based on provider
            if (aiProvider === "openai") {
              suggestion = await suggestReplyWithOpenAI(
                recentMessages,
                lastMsg,
                aiKey,
              );
            } else if (aiProvider === "gemini") {
              suggestion = await suggestReplyWithGemini(
                recentMessages,
                lastMsg,
                aiKey,
              );
            } else if (aiProvider === "deepseek") {
              suggestion = await suggestReplyWithDeepseek(
                recentMessages,
                lastMsg,
                aiKey,
              );
            } else {
              return socket.emit("error", {
                msg: "Unsupported AI provider",
              });
            }

            socket.emit("suggestion_result", {
              success: true,
              suggestion,
            });
          } catch (error) {
            logger.error("Suggestion error:", error);
            socket.emit("error", {
              msg: error.message || "Failed to generate suggestion",
            });
          }
          break;

        default:
          throw new Error(`Unsupported message type: ${payload?.type}`);
      }
    } catch (error) {
      logger.error("Error processing message:", error);
      socket.emit("error", {
        msg: error.message,
      });
    }
  });
}

module.exports = { processSocketEvent };

// calls/broadcastProcessor.js
const { query } = require("../../../database/dbpromise");
const fetch = require("node-fetch");
const wrtc = require("@roamhq/wrtc");
const WebSocket = require("ws");
const logger = require("../../../utils/logger");

// Import shared modules
const {
  saveRecording,
  mixStereoRecording,
  resampleLinear,
  waitForIceConnection,
} = require("./audioUtils");

const {
  connectToOpenAI,
  sendAudioToOpenAI,
  queueAudioChunk,
  handleFunctionCall,
} = require("./openaiHandler");

// Store active broadcast processes
const activeBroadcasts = new Map();

// Store outgoing call states
const outgoingCallStates = new Map();

/**
 * Process permission requests for a broadcast campaign
 */
async function processPermissionRequests(campaignId, uid) {
  try {
    logger.log(`[${campaignId}] Starting permission request process...`);

    const [broadcast] = await query(
      `SELECT * FROM wa_call_broadcasts WHERE campaign_id = ? AND uid = ?`,
      [campaignId, uid],
    );

    if (!broadcast) {
      logger.error(`[${campaignId}] Broadcast not found`);
      return;
    }

    const contacts = JSON.parse(broadcast.contacts || "[]");
    const metaData = await getMetaAPI(uid);

    if (!metaData) {
      logger.error(`[${campaignId}] No Meta API credentials found`);
      await updateBroadcastStatus(
        campaignId,
        "failed",
        "No Meta API credentials",
      );
      return;
    }

    let requestedCount = 0;
    let processedCount = 0;

    for (const contact of contacts) {
      const [currentBroadcast] = await query(
        `SELECT status FROM wa_call_broadcasts WHERE campaign_id = ?`,
        [campaignId],
      );

      if (currentBroadcast.status === "paused") {
        logger.log(
          `⏸️ [${campaignId}] Broadcast paused, stopping permission requests`,
        );
        break;
      }

      if (contact.permission_status !== "pending") {
        processedCount++;
        continue;
      }

      try {
        const permissionStatus = await checkCallPermissionStatus(
          contact.mobile,
          metaData,
        );

        const permission = permissionStatus.permission;

        if (
          permission &&
          (permission.status === "temporary" ||
            permission.status === "permanent")
        ) {
          logger.log(
            `[${campaignId}] ${contact.mobile} - Permission already granted`,
          );

          await updateContactInBroadcast(campaignId, contact.mobile, {
            permission_status: "granted",
            permission_granted_at: new Date().toISOString(),
            permission_type: permission.status,
            permission_expires_at: permission.expiration_time
              ? new Date(permission.expiration_time * 1000).toISOString()
              : null,
          });

          processedCount++;
        } else {
          const result = await sendCallPermissionRequest(
            contact.mobile,
            contact.name,
            metaData,
          );

          if (result.success) {
            logger.log(
              `[${campaignId}] ${contact.mobile} - Permission request sent`,
            );

            await updateContactInBroadcast(campaignId, contact.mobile, {
              permission_status: "requested",
              permission_requested_at: new Date().toISOString(),
            });

            requestedCount++;
            processedCount++;
          } else {
            logger.error(
              `[${campaignId}] ${contact.mobile} - Failed to send request: ${result.error}`,
            );

            await updateContactInBroadcast(campaignId, contact.mobile, {
              permission_status: "failed",
              error_message: result.error,
            });

            processedCount++;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (err) {
        logger.error(
          `[${campaignId}] Error processing ${contact.mobile}:`,
          err,
        );

        await updateContactInBroadcast(campaignId, contact.mobile, {
          permission_status: "failed",
          error_message: err.message,
        });

        processedCount++;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const [updatedBroadcast] = await query(
      `SELECT * FROM wa_call_broadcasts WHERE campaign_id = ?`,
      [campaignId],
    );

    const updatedContacts = JSON.parse(updatedBroadcast.contacts || "[]");

    const pendingCount = updatedContacts.filter(
      (c) => c.permission_status === "pending",
    ).length;
    const requestedCount2 = updatedContacts.filter(
      (c) => c.permission_status === "requested",
    ).length;

    logger.log(`[${campaignId}] Permission phase status:`, {
      total: updatedContacts.length,
      pending: pendingCount,
      requested: requestedCount2,
      granted: updatedContacts.filter((c) => c.permission_status === "granted")
        .length,
      denied: updatedContacts.filter((c) => c.permission_status === "denied")
        .length,
      failed: updatedContacts.filter((c) => c.permission_status === "failed")
        .length,
    });

    if (pendingCount === 0 && updatedBroadcast.status !== "paused") {
      await updateBroadcastStatus(
        campaignId,
        "ready",
        "Ready to start calling",
      );
      logger.log(
        `[${campaignId}] Permission phase completed - ${requestedCount2} contacts waiting for response`,
      );
    }
  } catch (err) {
    logger.error(`[${campaignId}] Permission request process error:`, err);
    await updateBroadcastStatus(campaignId, "failed", err.message);
  }
}

/**
 * Process broadcast calls
 */
async function processBroadcastCalls(campaignId, uid) {
  try {
    logger.log(`📞 [${campaignId}] Starting calling process...`);

    const [broadcast] = await query(
      `SELECT * FROM wa_call_broadcasts WHERE campaign_id = ? AND uid = ?`,
      [campaignId, uid],
    );

    if (!broadcast) {
      logger.error(`[${campaignId}] Broadcast not found`);
      return;
    }

    const contacts = JSON.parse(broadcast.contacts || "[]");
    const metaData = await getMetaAPI(uid);
    const flowData = await getFlowData(broadcast.flow_id, uid);

    if (!metaData || !flowData) {
      logger.error(`[${campaignId}] Missing Meta API or Flow data`);
      await updateBroadcastStatus(
        campaignId,
        "failed",
        "Missing configuration",
      );
      return;
    }

    activeBroadcasts.set(campaignId, {
      uid,
      broadcast,
      metaData,
      flowData,
      currentCallCount: 0,
    });

    const contactsToCall = contacts.filter(
      (c) => c.permission_status === "granted" && c.call_status === "pending",
    );

    logger.log(`[${campaignId}] ${contactsToCall.length} contacts to call`);

    if (contactsToCall.length === 0) {
      logger.log(
        `[${campaignId}] No contacts with granted permissions to call`,
      );
      await updateBroadcastStatus(
        campaignId,
        "completed",
        "No contacts to call",
      );
      activeBroadcasts.delete(campaignId);
      return;
    }

    for (const contact of contactsToCall) {
      const [currentBroadcast] = await query(
        `SELECT status FROM wa_call_broadcasts WHERE campaign_id = ?`,
        [campaignId],
      );

      if (currentBroadcast.status === "paused") {
        logger.log(`⏸️ [${campaignId}] Broadcast paused, stopping calls`);
        break;
      }

      const broadcastState = activeBroadcasts.get(campaignId);
      while (
        broadcastState &&
        broadcastState.currentCallCount >= broadcast.max_concurrent_calls
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      try {
        logger.log(`📞 [${campaignId}] Calling ${contact.mobile}...`);

        const callResult = await initiateBroadcastCall(
          campaignId,
          contact,
          metaData,
          flowData,
          uid,
        );

        if (callResult.success) {
          await updateContactInBroadcast(campaignId, contact.mobile, {
            call_status: "ringing",
            call_id: callResult.callId,
            call_initiated_at: new Date().toISOString(),
          });

          if (broadcastState) {
            broadcastState.currentCallCount++;
          }
        } else {
          await updateContactInBroadcast(campaignId, contact.mobile, {
            call_status: "failed",
            error_message: callResult.error,
          });
        }

        await new Promise((resolve) =>
          setTimeout(resolve, broadcast.call_delay),
        );
      } catch (err) {
        logger.error(`[${campaignId}] Error calling ${contact.mobile}:`, err);

        await updateContactInBroadcast(campaignId, contact.mobile, {
          call_status: "failed",
          error_message: err.message,
        });

        await new Promise((resolve) =>
          setTimeout(resolve, broadcast.call_delay),
        );
      }
    }

    logger.log(`[${campaignId}] All calls initiated`);
  } catch (err) {
    logger.error(`[${campaignId}] Calling process error:`, err);
    await updateBroadcastStatus(campaignId, "failed", err.message);
  }
}

/**
 * Initiate a broadcast call
 */
async function initiateBroadcastCall(
  campaignId,
  contact,
  metaData,
  flowData,
  uid,
) {
  try {
    logger.log(`🔧 [${campaignId}] Setting up call for ${contact.mobile}...`);

    const pc = new wrtc.RTCPeerConnection({
      sdpSemantics: "unified-plan",
    });

    const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;
    const audioSource = new RTCAudioSource();
    const outgoingTrack = audioSource.createTrack();
    pc.addTrack(outgoingTrack);

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
    });

    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
      } else {
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            resolve();
          }
        });
      }
    });

    const localSdp = pc.localDescription.sdp;

    logger.log(`[${campaignId}] Sending call request to ${contact.mobile}...`);

    const response = await fetch(
      `https://graph.facebook.com/v21.0/${metaData.business_phone_number_id}/calls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${metaData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: contact.mobile,
          action: "connect",
          session: {
            sdp_type: "offer",
            sdp: localSdp,
          },
          biz_opaque_callback_data: JSON.stringify({
            campaign_id: campaignId,
            contact_id: contact.id,
            contact_mobile: contact.mobile,
          }),
        }),
      },
    );

    const data = await response.json();

    if (data.error) {
      logger.error(
        `[${campaignId}] Call API error for ${contact.mobile}:`,
        data.error,
      );
      throw new Error(data.error.message);
    }

    let callId;
    if (data.calls && data.calls.length > 0 && data.calls[0].id) {
      callId = data.calls[0].id;
    } else {
      throw new Error("No call ID in response");
    }

    const parsedFlow = JSON.parse(flowData.data);
    const aiStartNode = parsedFlow.nodes.find((n) => n.id === "1");
    const flowConfig = aiStartNode.data;

    const callState = {
      callId,
      campaignId,
      contact,
      uid: uid,
      flowId: flowData.flow_id,
      pc,
      audioSource,
      audioSink: null,
      openaiWs: null,
      outputQueue: [],
      playbackInterval: null,
      sessionReady: false,
      latestTimestamp: 0,
      responseStartTime: null,
      lastAssistantItem: null,
      flowData: parsedFlow,
      flowConfig: {
        ...flowConfig,
        flow_id: flowData.flow_id,
      },
      metaData,
      hasPlayedOpening: false,
      isResponseInProgress: false,
      transcriptions: [],
      currentAssistantText: "",
      audioStartTime: Date.now(),
      recordingUserAudio: [],
      recordingAssistantAudio: [],
      cleanupCallback: cleanupBroadcastCall,
    };

    outgoingCallStates.set(callId, callState);

    pc.ontrack = (event) => {
      logger.log(`🎧 [${callId}] Received audio track`);
      const incomingTrack = event.track;
      const audioSink = new RTCAudioSink(incomingTrack);
      callState.audioSink = audioSink;

      audioSink.ondata = (data) => {
        callState.latestTimestamp += 10;
        if (callState.sessionReady) {
          sendAudioToOpenAI(callId, data.samples, data.sampleRate, callState);
        }
      };
    };

    pc.oniceconnectionstatechange = () => {
      logger.log(`🔌 [${callId}] ICE state:`, pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      logger.log(`🔌 [${callId}] Connection state:`, pc.connectionState);
    };

    const playbackInterval = setInterval(() => {
      playAudioFrame(callId);
    }, 10);
    callState.playbackInterval = playbackInterval;

    logger.log(`[${callId}] Broadcast call initiated for ${contact.mobile}`);

    return { success: true, callId };
  } catch (err) {
    logger.error(`Broadcast call error for ${contact.mobile}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Handle broadcast call connect event
 */
async function handleBroadcastCallConnect(callId, session, callbackData) {
  logger.log(`🔍 [${callId}] handleBroadcastCallConnect called`);

  const callState = outgoingCallStates.get(callId);
  if (!callState) {
    logger.error(`[${callId}] Call state not found in outgoingCallStates`);
    return;
  }

  try {
    let parsedData;

    if (!callbackData) {
      parsedData = {
        campaign_id: callState.campaignId,
        contact_mobile: callState.contact.mobile,
        contact_id: callState.contact.id,
      };
    } else {
      try {
        parsedData = JSON.parse(callbackData);
      } catch (e) {
        parsedData = {
          campaign_id: callState.campaignId,
          contact_mobile: callState.contact.mobile,
          contact_id: callState.contact.id,
        };
      }
    }

    const { campaign_id: campaignId, contact_mobile } = parsedData;

    if (!campaignId) {
      logger.error(`[${callId}] No campaignId in parsed data`);
      return;
    }

    logger.log(
      `[${callId}] Call connected for ${contact_mobile} in campaign ${campaignId}`,
    );

    await callState.pc.setRemoteDescription({
      type: "answer",
      sdp: session.sdp,
    });

    await waitForIceConnection(callState.pc);

    await updateContactInBroadcast(campaignId, contact_mobile, {
      call_status: "answered",
    });

    logger.log(`🤖 [${callId}] Connecting to OpenAI...`);

    await connectToOpenAI(callId, callState);

    logger.log(`[${callId}] Broadcast call fully connected and ready`);
  } catch (err) {
    logger.error(`[${callId}] Connect error:`, err);
    cleanupBroadcastCall(callId);
  }
}

/**
 * Handle broadcast call termination
 */
async function handleBroadcastCallTerminate(
  callId,
  status,
  duration,
  callbackData,
) {
  logger.log(`🔍 [${callId}] handleBroadcastCallTerminate called`);

  const callState = outgoingCallStates.get(callId);

  try {
    let parsedData;

    if (!callbackData) {
      if (callState) {
        parsedData = {
          campaign_id: callState.campaignId,
          contact_mobile: callState.contact.mobile,
          contact_id: callState.contact.id,
        };
      } else {
        logger.error(`[${callId}] No callState available`);
        return;
      }
    } else {
      try {
        parsedData = JSON.parse(callbackData);
      } catch (e) {
        if (callState) {
          parsedData = {
            campaign_id: callState.campaignId,
            contact_mobile: callState.contact.mobile,
            contact_id: callState.contact.id,
          };
        } else {
          logger.error(`[${callId}] No callState available for fallback`);
          return;
        }
      }
    }

    const { campaign_id: campaignId, contact_mobile } = parsedData;

    if (!campaignId) {
      logger.error(`[${callId}] No campaignId in parsed data`);
      cleanupBroadcastCall(callId, false);
      return;
    }

    logger.log(
      `📞 [${callId}] Call terminated for ${contact_mobile} - Status: ${status}, Duration: ${duration}s`,
    );

    await updateContactInBroadcast(campaignId, contact_mobile, {
      call_status: "completed",
      call_completed_at: new Date().toISOString(),
      call_duration: duration || 0,
    });

    const broadcastState = activeBroadcasts.get(campaignId);
    if (broadcastState) {
      broadcastState.currentCallCount--;
    }

    const [broadcast] = await query(
      `SELECT * FROM wa_call_broadcasts WHERE campaign_id = ?`,
      [campaignId],
    );

    if (broadcast) {
      const contacts = JSON.parse(broadcast.contacts || "[]");
      const allCompleted = contacts.every(
        (c) =>
          c.permission_status !== "granted" ||
          ["completed", "failed", "rejected"].includes(c.call_status),
      );

      if (allCompleted) {
        await updateBroadcastStatus(
          campaignId,
          "completed",
          "All calls completed",
        );
        activeBroadcasts.delete(campaignId);
      }
    }

    cleanupBroadcastCall(callId, false);
  } catch (err) {
    logger.error(`[${callId}] Termination handling error:`, err);
    cleanupBroadcastCall(callId, false);
  }
}

/**
 * Cleanup broadcast call
 */
async function cleanupBroadcastCall(callId, shouldTerminate = true) {
  const callState = outgoingCallStates.get(callId);
  if (!callState) {
    logger.log(`[${callId}] Call state not found for cleanup`);
    return;
  }

  logger.log(
    `🧹 [${callId}] Starting cleanup (terminate: ${shouldTerminate})...`,
  );

  const {
    pc,
    openaiWs,
    audioSink,
    playbackInterval,
    metaData,
    campaignId,
    contact,
    flowConfig,
    recordingUserAudio,
    recordingAssistantAudio,
    audioStartTime,
    transcriptions,
    uid,
    flowId,
  } = callState;

  const callEndTime = Date.now();
  const callDuration = Math.floor((callEndTime - audioStartTime) / 1000);

  logger.log(`[${callId}] Call stats:`, {
    duration: `${callDuration}s`,
    userAudioChunks: recordingUserAudio?.length || 0,
    assistantAudioChunks: recordingAssistantAudio?.length || 0,
    transcriptions: transcriptions?.length || 0,
  });

  if (shouldTerminate && metaData) {
    try {
      logger.log(`📞 [${callId}] Sending WhatsApp termination signal...`);
      await sendWhatsAppTerminate(callId, metaData);
    } catch (err) {
      logger.error(`[${callId}] Error terminating WhatsApp call:`, err);
    }
  }

  if (playbackInterval) {
    clearInterval(playbackInterval);
  }

  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
    openaiWs.close();
  }

  if (audioSink) {
    audioSink.stop();
  }

  if (pc) {
    pc.close();
  }

  let userRecordingFile = null;
  let assistantRecordingFile = null;
  let stereoRecordingFile = null;

  if (flowConfig.enableRecording) {
    logger.log(`💾 [${callId}] Saving recordings...`);

    userRecordingFile = await saveRecording(
      recordingUserAudio,
      callId,
      "user",
      flowConfig,
    );

    assistantRecordingFile = await saveRecording(
      recordingAssistantAudio,
      callId,
      "assistant",
      flowConfig,
    );

    stereoRecordingFile = mixStereoRecording(
      recordingUserAudio,
      recordingAssistantAudio,
      callId,
      flowConfig,
    );

    logger.log(`[${callId}] Recordings saved:`, {
      user: userRecordingFile || "not saved",
      assistant: assistantRecordingFile || "not saved",
      stereo: stereoRecordingFile || "not saved",
    });
  }

  const transcriptionJson =
    flowConfig.enableTranscription !== false &&
    transcriptions &&
    transcriptions.length > 0
      ? JSON.stringify(transcriptions)
      : null;

  const callMetadata = {
    callId: callId,
    campaignId: campaignId,
    contactMobile: contact.mobile,
    contactName: contact.name,
    callStartTime: new Date(audioStartTime).toISOString(),
    callEndTime: new Date(callEndTime).toISOString(),
    duration: callDuration,
    recordings: {
      user: userRecordingFile,
      assistant: assistantRecordingFile,
      stereo: stereoRecordingFile,
    },
  };

  try {
    await query(
      `INSERT INTO wa_call_logs (uid, call_id, flow_id, status, meta_data, transcription_json, recording_user, recording_assistant, recording_stereo, created_at, ended_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
       status = VALUES(status),
       meta_data = VALUES(meta_data),
       transcription_json = VALUES(transcription_json),
       recording_user = VALUES(recording_user),
       recording_assistant = VALUES(recording_assistant),
       recording_stereo = VALUES(recording_stereo),
       ended_at = VALUES(ended_at)`,
      [
        uid,
        callId,
        flowId,
        "ended",
        JSON.stringify(callMetadata),
        transcriptionJson,
        userRecordingFile,
        assistantRecordingFile,
        stereoRecordingFile,
        new Date(audioStartTime),
        new Date(callEndTime),
      ],
    );

    logger.log(`[${callId}] Call log saved to database`);
  } catch (err) {
    logger.error(`[${callId}] Error saving call log:`, err);
  }

  outgoingCallStates.delete(callId);
  logger.log(`[${callId}] Broadcast call cleaned up`);
}

/**
 * Send WhatsApp call termination
 */
async function sendWhatsAppTerminate(callId, metaData) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${metaData.business_phone_number_id}/calls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${metaData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          call_id: callId,
          action: "reject",
        }),
      },
    );

    const data = await response.json();
    return data;
  } catch (err) {
    logger.error(`[${callId}] Terminate error:`, err.message);
    throw err;
  }
}

/**
 * Play audio frame
 */
function playAudioFrame(callId) {
  const callState = outgoingCallStates.get(callId);
  if (!callState) return;

  const { audioSource, outputQueue } = callState;

  if (outputQueue.length === 0) {
    const silence = new Int16Array(80).fill(0);
    try {
      audioSource.onData({
        samples: silence,
        sampleRate: 8000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 80,
      });
    } catch (e) {
      logger.warn(`[playAudioFrame] Silence frame error: ${e.message}`);
    }
    return;
  }

  const frame = outputQueue.shift();
  try {
    audioSource.onData({
      samples: frame,
      sampleRate: 8000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: 80,
    });
  } catch (e) {
    logger.warn(`[playAudioFrame] Audio frame error: ${e.message}`);
  }
}

// Utility functions
async function checkCallPermissionStatus(toPhoneNumber, metaData) {
  const response = await fetch(
    `https://graph.facebook.com/v21.0/${metaData.business_phone_number_id}/call_permissions?user_wa_id=${toPhoneNumber}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${metaData.access_token}`,
      },
    },
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data;
}

async function sendCallPermissionRequest(toPhoneNumber, name, metaData) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${metaData.business_phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${metaData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toPhoneNumber,
          type: "interactive",
          interactive: {
            type: "call_permission_request",
            action: {
              name: "call_permission_request",
            },
            body: {
              text: `Hi${name ? " " + name : ""}, we would like to call you. May we call you on WhatsApp?`,
            },
          },
        }),
      },
    );

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error.message };
    }

    if (data.messages && data.messages[0] && data.messages[0].id) {
      return { success: true, messageId: data.messages[0].id };
    }

    return { success: false, error: "No message ID in response" };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function updateContactInBroadcast(campaignId, mobile, updates) {
  try {
    const [broadcast] = await query(
      `SELECT * FROM wa_call_broadcasts WHERE campaign_id = ?`,
      [campaignId],
    );

    if (!broadcast) return;

    const contacts = JSON.parse(broadcast.contacts || "[]");
    const contactIndex = contacts.findIndex((c) => c.mobile === mobile);

    if (contactIndex === -1) return;

    const oldStatus = contacts[contactIndex];
    contacts[contactIndex] = {
      ...contacts[contactIndex],
      ...updates,
    };

    let statsUpdate = {};

    if (
      updates.permission_status === "requested" &&
      oldStatus.permission_status !== "requested"
    ) {
      statsUpdate.permission_requested =
        (broadcast.permission_requested || 0) + 1;
    }
    if (
      updates.permission_status === "granted" &&
      oldStatus.permission_status !== "granted"
    ) {
      statsUpdate.permission_granted = (broadcast.permission_granted || 0) + 1;
    }
    if (
      updates.permission_status === "denied" &&
      oldStatus.permission_status !== "denied"
    ) {
      statsUpdate.permission_denied = (broadcast.permission_denied || 0) + 1;
    }
    if (
      updates.call_status === "ringing" &&
      oldStatus.call_status !== "ringing"
    ) {
      statsUpdate.calls_initiated = (broadcast.calls_initiated || 0) + 1;
    }
    if (
      updates.call_status === "completed" &&
      oldStatus.call_status !== "completed"
    ) {
      statsUpdate.calls_completed = (broadcast.calls_completed || 0) + 1;
    }
    if (
      updates.call_status === "failed" &&
      oldStatus.call_status !== "failed"
    ) {
      statsUpdate.calls_failed = (broadcast.calls_failed || 0) + 1;
    }

    let updateQuery = `UPDATE wa_call_broadcasts SET contacts = ?`;
    let updateParams = [JSON.stringify(contacts)];

    Object.keys(statsUpdate).forEach((key) => {
      updateQuery += `, ${key} = ?`;
      updateParams.push(statsUpdate[key]);
    });

    updateQuery += ` WHERE campaign_id = ?`;
    updateParams.push(campaignId);

    await query(updateQuery, updateParams);
  } catch (err) {
    logger.error(`Error updating contact ${mobile}:`, err);
  }
}

async function updateBroadcastStatus(campaignId, status, message) {
  try {
    const [broadcast] = await query(
      `SELECT * FROM wa_call_broadcasts WHERE campaign_id = ?`,
      [campaignId],
    );

    if (!broadcast) return;

    const logs = JSON.parse(broadcast.logs || "[]");
    logs.push({
      timestamp: new Date().toISOString(),
      type: "status_change",
      status: status,
      message: message,
    });

    await query(
      `UPDATE wa_call_broadcasts SET status = ?, logs = ? WHERE campaign_id = ?`,
      [status, JSON.stringify(logs), campaignId],
    );
  } catch (err) {
    logger.error(`Error updating broadcast status:`, err);
  }
}

async function getMetaAPI(uid) {
  const [res] = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
  return res;
}

async function getFlowData(flowId, uid) {
  const [flow] = await query(
    `SELECT * FROM wa_call_flows WHERE flow_id = ? AND uid = ?`,
    [flowId, uid],
  );
  return flow;
}

module.exports = {
  processPermissionRequests,
  processBroadcastCalls,
  handleBroadcastCallConnect,
  handleBroadcastCallTerminate,
  outgoingCallStates,
};

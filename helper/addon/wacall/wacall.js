// calls/wacall.js
const wrtc = require("@roamhq/wrtc");
const WebSocket = require("ws");
const { query } = require("../../../database/dbpromise");
const logger = require("../../../utils/logger");

// Import shared modules
const {
  saveRecording,
  mixStereoRecording,
  resampleLinear,
  waitForIceConnection,
} = require("./audioUtils");

const { connectToOpenAI, sendAudioToOpenAI } = require("./openaiHandler");

// Store active calls
const activeCalls = new Map();

async function handleCalls(change, uid, body) {
  try {
    const callEvents = change.value.calls || [];

    for (const callEvent of callEvents) {
      if (
        callEvent.event === "connect" &&
        callEvent.session?.sdp_type === "offer"
      ) {
        const callerInfo = {
          from: callEvent.from || null,
          name: callEvent.profile?.name || null,
        };

        await handleIncomingWhatsAppCall(
          callEvent.id,
          callEvent.session.sdp,
          uid,
          callerInfo,
        );
      }

      if (callEvent.event === "terminate") {
        cleanupWhatsAppCall(callEvent.id);
      }
    }
  } catch (err) {
    logger.error(`Error handling WhatsApp call webhook: ${err.message}`);
  }
}

async function handleIncomingWhatsAppCall(
  callId,
  whatsappSdp,
  uid,
  callerInfo = {},
) {
  let errorMessage = null;

  try {
    const flowData = await returnFlow(uid);
    const metaData = await getMetaAPI(uid);

    if (!flowData || !flowData.data) {
      errorMessage = "No flow data found for UID";
      logger.error(`[${callId}] ${errorMessage}`);

      await query(
        `INSERT INTO wa_call_logs (uid, call_id, status, error_message, created_at, ended_at) VALUES (?,?,?,?,NOW(),NOW())`,
        [uid, callId, "failed", errorMessage],
      ).catch(logger.error);

      return;
    }

    if (!metaData || !metaData.access_token) {
      errorMessage = "No Meta API credentials found";
      logger.error(`[${callId}] ${errorMessage}`);

      await query(
        `INSERT INTO wa_call_logs (uid, call_id, status, error_message, created_at, ended_at) VALUES (?,?,?,?,NOW(),NOW())`,
        [uid, callId, "failed", errorMessage],
      ).catch(logger.error);

      return;
    }

    const parsedFlow = JSON.parse(flowData.data);
    const nodes = parsedFlow.nodes || [];

    const aiStartNode = nodes.find((node) => node.id === "1");
    if (!aiStartNode) {
      errorMessage = "No AI Start node found in flow";
      logger.error(`[${callId}] ${errorMessage}`);

      await query(
        `INSERT INTO wa_call_logs (uid, call_id, flow_id, status, error_message, created_at, ended_at) VALUES (?,?,?,?,?,NOW(),NOW())`,
        [uid, callId, flowData.flow_id, "failed", errorMessage],
      ).catch(logger.error);

      return;
    }

    const flowConfig = aiStartNode.data;

    if (!flowConfig.apiKeys) {
      errorMessage = "No OpenAI API key configured";
      logger.error(`[${callId}] ${errorMessage}`);

      await query(
        `INSERT INTO wa_call_logs (uid, call_id, flow_id, status, error_message, created_at, ended_at) VALUES (?,?,?,?,?,NOW(),NOW())`,
        [uid, callId, flowData.flow_id, "failed", errorMessage],
      ).catch(logger.error);

      return;
    }

    logger.log(`🎙️ [${callId}] Recording settings:`, {
      enableRecording: flowConfig.enableRecording,
      recordingTypes: flowConfig.recordingTypes,
      enableTranscription: flowConfig.enableTranscription,
    });

    const callMetadata = {
      callId: callId,
      businessPhoneNumberId: metaData.business_phone_number_id,
      callerNumber: callerInfo.from || null,
      callerName: callerInfo.name || null,
      callStartTime: new Date().toISOString(),
      callEndTime: null,
      duration: null,
      voiceSource: flowConfig.voice_source || "openai",
      openaiModel: flowConfig.openai_model || "gpt-4o-realtime-preview",
      recordingEnabled: flowConfig.enableRecording || false,
      transcriptionEnabled: flowConfig.enableTranscription !== false,
      flowId: flowData.flow_id,
      flowName: flowData.name,
    };

    const callState = {
      callId,
      uid,
      whatsappSdp,
      whatsappPc: null,
      openaiWs: null,
      audioSource: null,
      audioSink: null,
      outputQueue: [],
      playbackInterval: null,
      sessionReady: false,
      latestTimestamp: 0,
      responseStartTime: null,
      lastAssistantItem: null,
      hasPlayedOpening: false,
      flowConfig,
      flowData: parsedFlow,
      metaData,
      isResponseInProgress: false,
      transcriptions: [],
      currentAssistantText: "",
      audioStartTime: Date.now(),
      recordingUserAudio: [],
      recordingAssistantAudio: [],
      errorLog: [],
      callMetadata: callMetadata,
      cleanupCallback: cleanupWhatsAppCall,
    };

    activeCalls.set(callId, callState);

    const whatsappPc = new wrtc.RTCPeerConnection({
      sdpSemantics: "unified-plan",
    });

    callState.whatsappPc = whatsappPc;

    const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;
    const audioSource = new RTCAudioSource();
    const outgoingTrack = audioSource.createTrack();
    whatsappPc.addTrack(outgoingTrack);

    callState.audioSource = audioSource;

    const playbackInterval = setInterval(() => {
      playAudioFrame(callId);
    }, 10);
    callState.playbackInterval = playbackInterval;

    whatsappPc.ontrack = (event) => {
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

    whatsappPc.oniceconnectionstatechange = () => {
      if (whatsappPc.iceConnectionState === "failed") {
        logError(callId, "ICE connection failed");
      }
    };

    await whatsappPc.setRemoteDescription({
      type: "offer",
      sdp: whatsappSdp,
    });

    const answer = await whatsappPc.createAnswer();
    let modifiedSdp = answer.sdp.replace(/a=setup:actpass/g, "a=setup:active");

    await whatsappPc.setLocalDescription({
      type: "answer",
      sdp: modifiedSdp,
    });

    await sendWhatsAppAction(callId, "pre_accept", modifiedSdp, metaData);
    await waitForIceConnection(whatsappPc);
    await sendWhatsAppAction(callId, "accept", modifiedSdp, metaData);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    logger.log(`[${callId}] Call setup successful, connecting to OpenAI...`);
    await connectToOpenAI(callId, callState);

    await query(
      `INSERT INTO wa_call_logs (uid, call_id, flow_id, status, meta_data, created_at) VALUES (?,?,?,?,?,NOW())`,
      [
        uid,
        callId,
        flowData.flow_id,
        "connected",
        JSON.stringify(callMetadata),
      ],
    );
  } catch (err) {
    errorMessage = errorMessage || err.message;
    logger.error(`[${callId}] Setup failed: ${errorMessage}`);

    await query(
      `INSERT INTO wa_call_logs (uid, call_id, status, error_message, created_at, ended_at) VALUES (?,?,?,?,NOW(),NOW())`,
      [uid, callId, "failed", errorMessage],
    ).catch((dbErr) => {
      logger.error(`[${callId}] Database error: ${dbErr.message}`);
    });

    const callState = activeCalls.get(callId);
    if (callState) {
      cleanupWhatsAppCall(callId);
    }
  }
}

function logError(callId, error) {
  const callState = activeCalls.get(callId);
  if (callState) {
    const errorMsg = typeof error === "string" ? error : error.message;
    callState.errorLog.push({
      timestamp: new Date().toISOString(),
      error: errorMsg,
    });

    logger.error(`[${callId}] ${errorMsg}`);
  }
}

async function sendWhatsAppAction(callId, action, sdp, metaData) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${metaData.business_phone_number_id}/calls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${metaData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          call_id: callId,
          action: action,
          session: { sdp_type: "answer", sdp: sdp },
        }),
      },
    );

    const data = await response.json();

    if (!data.success) {
      const errorMsg = `WhatsApp ${action} failed: ${JSON.stringify(data)}`;
      logger.error(`[${callId}] ${errorMsg}`);
      logError(callId, errorMsg);
      throw new Error(errorMsg);
    }

    return data;
  } catch (err) {
    logger.error(`[${callId}] ${action} error: ${err.message}`);
    logError(callId, `WhatsApp ${action} failed: ${err.message}`);
    throw err;
  }
}

function playAudioFrame(callId) {
  const callState = activeCalls.get(callId);
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
    } catch (e) {}
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
  } catch (e) {}
}

async function sendWhatsAppTerminate(callId, metaData) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${metaData.business_phone_number_id}/calls`,
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
    logger.error(`[${callId}] Terminate error:`, err);
    throw err;
  }
}

async function cleanupWhatsAppCall(callId) {
  const callState = activeCalls.get(callId);
  if (!callState) {
    logger.log(`⚠️ [${callId}] Call state not found for cleanup`);
    return;
  }

  logger.log(`🧹 [${callId}] Starting cleanup...`);

  const {
    whatsappPc,
    openaiWs,
    audioSink,
    playbackInterval,
    transcriptions,
    recordingUserAudio,
    recordingAssistantAudio,
    flowConfig,
    errorLog,
    metaData,
    callMetadata,
  } = callState;

  const callEndTime = new Date();
  const callDuration = Math.floor(
    (callEndTime - new Date(callMetadata.callStartTime)) / 1000,
  );

  callMetadata.callEndTime = callEndTime.toISOString();
  callMetadata.duration = callDuration;
  callMetadata.totalTranscriptions = transcriptions?.length || 0;
  callMetadata.userMessages =
    transcriptions?.filter((t) => t.speaker === "user").length || 0;
  callMetadata.assistantMessages =
    transcriptions?.filter((t) => t.speaker === "assistant").length || 0;
  callMetadata.errorCount = errorLog?.length || 0;

  logger.log(`📊 [${callId}] Call stats:`, {
    duration: `${callDuration}s`,
    userAudioChunks: recordingUserAudio?.length || 0,
    assistantAudioChunks: recordingAssistantAudio?.length || 0,
    transcriptions: transcriptions?.length || 0,
    errors: errorLog?.length || 0,
  });

  try {
    await sendWhatsAppTerminate(callId, metaData);
  } catch (err) {
    logger.error(`[${callId}] Error terminating WhatsApp call:`, err);
  }

  if (playbackInterval) {
    clearInterval(playbackInterval);
  }

  if (whatsappPc) {
    whatsappPc.close();
  }

  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
    openaiWs.close();
  }

  if (audioSink) {
    audioSink.stop();
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

    callMetadata.recordings = {
      user: userRecordingFile,
      assistant: assistantRecordingFile,
      stereo: stereoRecordingFile,
    };

    logger.log(`[${callId}] Recordings saved:`, {
      user: userRecordingFile || "not saved",
      assistant: assistantRecordingFile || "not saved",
      stereo: stereoRecordingFile || "not saved",
    });
  }

  activeCalls.delete(callId);

  const transcriptionJson =
    flowConfig.enableTranscription !== false &&
    transcriptions &&
    transcriptions.length > 0
      ? JSON.stringify(transcriptions)
      : null;

  const errorMessage = errorLog.length > 0 ? JSON.stringify(errorLog) : null;

  await query(
    `UPDATE wa_call_logs 
     SET status = 'ended', 
         ended_at = NOW(), 
         transcription_json = ?,
         recording_user = ?,
         recording_assistant = ?,
         recording_stereo = ?,
         error_message = ?,
         meta_data = ?
     WHERE call_id = ?`,
    [
      transcriptionJson,
      userRecordingFile,
      assistantRecordingFile,
      stereoRecordingFile,
      errorMessage,
      JSON.stringify(callMetadata),
      callId,
    ],
  ).catch((err) => logger.error(`[${callId}] Error updating call log:`, err));

  logger.log(`[${callId}] Cleanup completed successfully`);
}

async function returnFlow(uid) {
  const [checkBot] = await query(
    `SELECT * FROM wa_call_bot WHERE uid = ? AND active = ?`,
    [uid, 1],
  );
  if (!checkBot) return null;

  const [flow] = await query(
    `SELECT * FROM wa_call_flows WHERE uid = ? AND flow_id = ?`,
    [uid, checkBot?.flow_id],
  );
  if (!flow) return null;
  return flow;
}

async function getMetaAPI(uid) {
  const [res] = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
  return res;
}

function checkWaCall() {
  return true;
}

module.exports = { handleCalls, checkWaCall };

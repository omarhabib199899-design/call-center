// calls/openaiHandler.js
const WebSocket = require("ws");
const {
  buildToolsFromFlow,
  executeFlowForFunction,
} = require("./flowExecutor");
const { resampleLinear } = require("./audioUtils");
const logger = require("../../../utils/logger");

/**
 * Connect to OpenAI Realtime API
 */
async function connectToOpenAI(callId, callState) {
  const { flowConfig } = callState;

  const url = `wss://api.openai.com/v1/realtime?model=${
    flowConfig.openai_model || "gpt-4o-realtime-preview-2024-12-17"
  }`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${flowConfig.apiKeys}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  callState.openaiWs = ws;

  ws.on("open", () => {
    logger.log(` [${callId}] OpenAI connected`);
  });

  ws.on("message", (data) => {
    handleOpenAIMessage(callId, data, callState);
  });

  ws.on("error", (error) => {
    logger.error(` [${callId}] OpenAI error:`, error.message);
  });

  ws.on("close", () => {
    logger.log(`🔌 [${callId}] OpenAI disconnected`);
  });

  return ws;
}

/**
 * Handle OpenAI messages
 */
function handleOpenAIMessage(callId, data, callState) {
  try {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case "session.created":
        handleSessionCreated(callId, callState);
        break;

      case "session.updated":
        callState.sessionReady = true;
        setTimeout(() => {
          if (callState.openaiWs?.readyState === WebSocket.OPEN) {
            callState.openaiWs.send(
              JSON.stringify({ type: "response.create" }),
            );
          }
        }, 500);
        break;

      case "response.audio.delta":
        if (msg.delta) {
          queueAudioChunk(callId, msg.delta, callState);
        }
        if (msg.item_id) {
          callState.lastAssistantItem = msg.item_id;
        }
        if (!callState.responseStartTime) {
          callState.responseStartTime = callState.latestTimestamp;
        }
        break;

      case "response.audio_transcript.delta":
        if (msg.delta && callState.flowConfig.enableTranscription !== false) {
          if (!callState.currentAssistantText) {
            callState.currentAssistantText = "";
          }
          callState.currentAssistantText += msg.delta;
        }
        break;

      case "response.audio_transcript.done":
        if (
          msg.transcript &&
          callState.flowConfig.enableTranscription !== false
        ) {
          if (!callState.transcriptions) {
            callState.transcriptions = [];
          }
          callState.transcriptions.push({
            speaker: "assistant",
            text: msg.transcript,
            timestamp: new Date().toISOString(),
          });
          callState.currentAssistantText = "";
          logger.log(`📝 [${callId}] Assistant transcript: ${msg.transcript}`);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (
          msg.transcript &&
          callState.flowConfig.enableTranscription !== false
        ) {
          if (!callState.transcriptions) {
            callState.transcriptions = [];
          }
          callState.transcriptions.push({
            speaker: "user",
            text: msg.transcript,
            timestamp: new Date().toISOString(),
          });
          logger.log(`📝 [${callId}] User transcript: ${msg.transcript}`);
        }
        break;

      case "response.function_call_arguments.done":
        //  FIX: Handle hangup result
        handleFunctionCall(callId, msg, callState)
          .then((result) => {
            if (result && result.shouldHangup) {
              logger.log(
                `🔚 [${callId}] Hangup signal received, cleaning up...`,
              );
              // Call the cleanup function from the parent module
              if (callState.cleanupCallback) {
                setTimeout(() => {
                  callState.cleanupCallback(callId);
                }, 1000);
              }
            }
          })
          .catch((err) => {
            logger.error(` [${callId}] Function call handler error:`, err);
          });
        break;

      case "input_audio_buffer.speech_started":
        handleUserSpeaking(callId, callState);
        break;

      case "response.created":
        callState.isResponseInProgress = true;
        if (msg.response?.id) {
          callState.lastAssistantItem = msg.response.id;
        }
        break;

      case "response.done":
        callState.responseStartTime = null;
        callState.isResponseInProgress = false;
        break;

      case "response.cancelled":
        callState.responseStartTime = null;
        callState.lastAssistantItem = null;
        callState.isResponseInProgress = false;
        callState.currentAssistantText = "";
        break;

      case "error":
        logger.error(` [${callId}] OpenAI error:`, msg.error);
        break;
    }
  } catch (err) {
    logger.error(` [${callId}] Message parse error:`, err.message);
  }
}

/**
 * Handle session created
 */
function handleSessionCreated(callId, callState) {
  const tools = buildToolsFromFlow(callState.flowConfig);

  let instructions =
    callState.flowConfig.system_message || "You are a helpful AI assistant.";

  if (callState.flowConfig.welcome_message) {
    instructions += `\n\nStart the conversation by saying: "${callState.flowConfig.welcome_message}"`;
  }

  callState.openaiWs.send(
    JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: {
          type: "server_vad",
          threshold: callState.flowConfig.vad_threshold || 0.5,
          prefix_padding_ms: callState.flowConfig.vad_prefix_padding || 300,
          silence_duration_ms:
            callState.flowConfig.vad_silence_duration || 1200,
        },
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription:
          callState.flowConfig.enableTranscription !== false
            ? { model: "whisper-1" }
            : undefined,
        voice: callState.flowConfig.openai_voice || "alloy",
        instructions: instructions,
        modalities: ["text", "audio"],
        temperature: callState.flowConfig.temperature || 0.8,
        tools: tools,
      },
    }),
  );
}

/**
 * Send audio to OpenAI
 */
function sendAudioToOpenAI(callId, samples, sampleRate, callState) {
  const { openaiWs, flowConfig } = callState;
  if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

  try {
    const amplified = new Int16Array(samples.length);
    const GAIN = 3.0;

    for (let i = 0; i < samples.length; i++) {
      let sample = samples[i] * GAIN;
      sample = Math.max(-32768, Math.min(32767, sample));
      amplified[i] = Math.round(sample);
    }

    const resampled24k = resampleLinear(amplified, sampleRate, 24000);

    if (flowConfig.enableRecording) {
      const resampled8k = resampleLinear(amplified, sampleRate, 8000);
      const timestamp = Date.now() - callState.audioStartTime;

      callState.recordingUserAudio.push({
        timestamp: timestamp,
        samples: new Int16Array(resampled8k),
      });
    }

    const buffer = Buffer.alloc(resampled24k.length * 2);
    for (let i = 0; i < resampled24k.length; i++) {
      buffer.writeInt16LE(resampled24k[i], i * 2);
    }

    const base64Audio = buffer.toString("base64");

    openaiWs.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Audio,
      }),
    );
  } catch (err) {
    logger.error(` [${callId}] Send audio error:`, err.message);
  }
}

/**
 * Queue audio chunk for playback
 */
function queueAudioChunk(callId, base64Audio, callState) {
  try {
    const audioData = Buffer.from(base64Audio, "base64");
    const samples24k = new Int16Array(
      audioData.buffer,
      audioData.byteOffset,
      audioData.length / 2,
    );

    const samples8k = resampleLinear(samples24k, 24000, 8000);

    if (callState.flowConfig.enableRecording) {
      const timestamp = Date.now() - callState.audioStartTime;

      callState.recordingAssistantAudio.push({
        timestamp: timestamp,
        samples: new Int16Array(samples8k),
      });
    }

    const FRAME_SIZE = 80;
    for (let i = 0; i < samples8k.length; i += FRAME_SIZE) {
      const frame = new Int16Array(FRAME_SIZE);
      const remaining = Math.min(FRAME_SIZE, samples8k.length - i);

      for (let j = 0; j < remaining; j++) {
        frame[j] = samples8k[i + j];
      }

      callState.outputQueue.push(frame);
    }
  } catch (err) {
    logger.error(` [${callId}] Queue error:`, err.message);
  }
}

/**
 * Handle function call -  FIXED: Proper hangup with farewell message
 */
async function handleFunctionCall(callId, msg, callState) {
  try {
    const functionName = msg.name;
    const args = JSON.parse(msg.arguments || "{}");
    const callIdFunc = msg.call_id;

    logger.log(`🔧 [${callId}] Function called: ${functionName}`, args);

    const matchedFunction = callState.flowConfig.available_functions?.find(
      (func) => func.name.replace(/\s+/g, "_").toLowerCase() === functionName,
    );

    if (!matchedFunction) {
      logger.log(`⚠️ [${callId}] Function not found: ${functionName}`);

      const functionResponse = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callIdFunc,
          output: "Function not found in configuration",
        },
      };

      callState.openaiWs.send(JSON.stringify(functionResponse));
      await waitForResponseToFinish(callState);
      callState.openaiWs.send(JSON.stringify({ type: "response.create" }));
      return;
    }

    const startingEdge = callState.flowData.edges.find(
      (edge) =>
        edge.source === "1" &&
        edge.sourceHandle === `function-${matchedFunction.id}`,
    );

    let functionResult;

    if (startingEdge) {
      logger.log(`🔄 [${callId}] Executing flow for function: ${functionName}`);
      functionResult = await executeFlowForFunction(
        callId,
        functionName,
        args,
        callState,
      );
      logger.log(` [${callId}] Flow execution result:`, functionResult);
    } else {
      functionResult = "Function executed successfully";
    }

    //  FIX: Check for hangup signal
    let shouldHangup = false;
    let hangupMessage = "";

    if (functionResult) {
      if (Array.isArray(functionResult)) {
        const hangupItem = functionResult.find((item) => item?.hangup === true);
        if (hangupItem) {
          shouldHangup = true;
          hangupMessage = hangupItem.finalMessage || hangupItem.message || "";
        }
      } else if (typeof functionResult === "object") {
        if (functionResult?.hangup === true) {
          shouldHangup = true;
          hangupMessage =
            functionResult.finalMessage || functionResult.message || "";
        }
      }
    }

    logger.log(`🔍 [${callId}] Hangup check:`, {
      shouldHangup,
      hangupMessage,
    });

    // Send function result to OpenAI
    const functionResponse = {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callIdFunc,
        output:
          typeof functionResult === "string"
            ? functionResult
            : JSON.stringify(functionResult),
      },
    };

    callState.openaiWs.send(JSON.stringify(functionResponse));
    await waitForResponseToFinish(callState);

    //  FIX: Handle hangup with farewell message
    if (shouldHangup) {
      logger.log(`📞 [${callId}] Hangup requested`);

      if (hangupMessage) {
        logger.log(
          `💬 [${callId}] Sending farewell message: "${hangupMessage}"`,
        );

        // Send instruction to say goodbye
        callState.openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Say this exact message: "${hangupMessage}"`,
                },
              ],
            },
          }),
        );

        await waitForResponseToFinish(callState);
        callState.openaiWs.send(JSON.stringify({ type: "response.create" }));

        // Wait for AI to finish speaking
        const estimatedDuration = Math.max(3000, hangupMessage.length * 100);
        logger.log(
          `⏳ [${callId}] Waiting ${estimatedDuration}ms for farewell message...`,
        );
        await new Promise((resolve) => setTimeout(resolve, estimatedDuration));
      }

      logger.log(`🔚 [${callId}] Hanging up call now...`);

      // Return hangup signal
      return { shouldHangup: true };
    } else {
      // Continue conversation
      callState.openaiWs.send(JSON.stringify({ type: "response.create" }));
      return { shouldHangup: false };
    }
  } catch (err) {
    logger.error(` [${callId}] Function call error:`, err);
    logger.error(` [${callId}] Error stack:`, err.stack);

    try {
      const errorResponse = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: msg.call_id,
          output: `Error: ${err.message}`,
        },
      };

      callState.openaiWs.send(JSON.stringify(errorResponse));
      await waitForResponseToFinish(callState);
      callState.openaiWs.send(JSON.stringify({ type: "response.create" }));
    } catch (sendErr) {
      logger.error(` [${callId}] Error sending error response:`, sendErr);
    }

    return { shouldHangup: false };
  }
}

/**
 * Handle user speaking (interrupt assistant)
 */
function handleUserSpeaking(callId, callState) {
  callState.outputQueue.length = 0;
  callState.responseStartTime = null;
  callState.lastAssistantItem = null;

  const { latestTimestamp, lastAssistantItem, openaiWs, responseStartTime } =
    callState;

  if (responseStartTime !== null && lastAssistantItem) {
    const elapsedMs = latestTimestamp - responseStartTime;

    try {
      openaiWs.send(
        JSON.stringify({
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedMs,
        }),
      );
    } catch (err) {
      logger.error(` [${callId}] Error truncating:`, err.message);
    }
  }
}

/**
 * Wait for response to finish
 */
async function waitForResponseToFinish(callState, maxWait = 5000) {
  const startTime = Date.now();

  while (callState.isResponseInProgress && Date.now() - startTime < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = {
  connectToOpenAI,
  handleOpenAIMessage,
  sendAudioToOpenAI,
  queueAudioChunk,
  handleFunctionCall,
  handleUserSpeaking,
  waitForResponseToFinish,
};

// calls/audioUtils.js
const fs = require("fs");
const path = require("path");
const logger = require("../../../utils/logger");

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, "../../../client/public/recordings");
try {
  fs.mkdirSync(recordingsDir, { recursive: true });
} catch (err) {
  logger.error(`[audioUtils] Failed to create recordings directory:`, err);
}

/**
 * Write WAV file header
 */
function writeWavHeader(buffer, sampleRate, numChannels, bitsPerSample) {
  const dataSize = buffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((numChannels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/**
 * Save mono recording (user or assistant)
 */
async function saveRecording(audioBuffers, callId, type, flowConfig) {
  if (!flowConfig.enableRecording) {
    logger.log(`[${callId}] Recording disabled in flow config`);
    return null;
  }

  const recordingTypes = flowConfig.recordingTypes || {};
  const shouldRecord = recordingTypes[type] !== false;

  if (!shouldRecord) {
    logger.log(`[${callId}] ${type} recording disabled in settings`);
    return null;
  }

  if (!audioBuffers || audioBuffers.length === 0) {
    logger.log(`[${callId}] No ${type} audio data to save (buffer empty)`);
    return null;
  }

  try {
    logger.log(
      `🎙️ [${callId}] Saving ${type} recording (${audioBuffers.length} chunks)...`,
    );

    const totalLength = audioBuffers.reduce(
      (sum, chunk) => sum + chunk.samples.length,
      0,
    );

    if (totalLength === 0) {
      logger.log(`[${callId}] No ${type} audio samples to save`);
      return null;
    }

    const combinedSamples = new Int16Array(totalLength);
    let offset = 0;

    for (const chunk of audioBuffers) {
      combinedSamples.set(chunk.samples, offset);
      offset += chunk.samples.length;
    }

    const combinedBuffer = Buffer.alloc(totalLength * 2);
    for (let i = 0; i < totalLength; i++) {
      combinedBuffer.writeInt16LE(combinedSamples[i], i * 2);
    }

    const sampleRate = 8000;
    const numChannels = 1;
    const bitsPerSample = 16;

    const wavHeader = writeWavHeader(
      combinedBuffer,
      sampleRate,
      numChannels,
      bitsPerSample,
    );
    const wavFile = Buffer.concat([wavHeader, combinedBuffer]);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${callId.substring(0, 20)}_${type}_${timestamp}.wav`;
    const filepath = path.join(recordingsDir, filename);

    await fs.promises.writeFile(filepath, wavFile);

    const durationSec = (totalLength / sampleRate).toFixed(2);
    const fileSizeKB = (wavFile.length / 1024).toFixed(2);

    logger.log(
      `[${callId}] Saved ${type} recording: ${filename} (${fileSizeKB} KB, ${durationSec}s)`,
    );

    return filename;
  } catch (err) {
    logger.error(`[${callId}] Error saving ${type} recording:`, err);
    return null;
  }
}

/**
 * Mix stereo recording (user on left, assistant on right)
 */
async function mixStereoRecording(
  userBuffers,
  assistantBuffers,
  callId,
  flowConfig,
) {
  if (!flowConfig.enableRecording) {
    logger.log(`[${callId}] Stereo recording disabled (main recording off)`);
    return null;
  }

  const recordingTypes = flowConfig.recordingTypes || {};
  const shouldRecord = recordingTypes.stereo !== false;

  if (!shouldRecord) {
    logger.log(`[${callId}] Stereo recording disabled in settings`);
    return null;
  }

  if (
    (!userBuffers || userBuffers.length === 0) &&
    (!assistantBuffers || assistantBuffers.length === 0)
  ) {
    logger.log(`[${callId}] No audio data for stereo mix (both buffers empty)`);
    return null;
  }

  try {
    logger.log(
      `[${callId}] Mixing stereo: User chunks=${userBuffers?.length || 0}, Assistant chunks=${assistantBuffers?.length || 0}`,
    );

    const sampleRate = 8000;
    let maxTimestamp = 0;

    for (const chunk of userBuffers || []) {
      const endTime =
        chunk.timestamp + (chunk.samples.length / sampleRate) * 1000;
      if (endTime > maxTimestamp) maxTimestamp = endTime;
    }

    for (const chunk of assistantBuffers || []) {
      const endTime =
        chunk.timestamp + (chunk.samples.length / sampleRate) * 1000;
      if (endTime > maxTimestamp) maxTimestamp = endTime;
    }

    if (maxTimestamp === 0) {
      logger.log(`[${callId}] No valid timestamps in audio data`);
      return null;
    }

    const totalSamples = Math.ceil((maxTimestamp / 1000) * sampleRate);

    logger.log(
      `[${callId}] Stereo mix: Duration=${(maxTimestamp / 1000).toFixed(2)}s, Samples=${totalSamples}`,
    );

    const userTrack = new Int16Array(totalSamples);
    const assistantTrack = new Int16Array(totalSamples);

    for (const chunk of userBuffers || []) {
      const startSample = Math.floor((chunk.timestamp / 1000) * sampleRate);
      for (
        let i = 0;
        i < chunk.samples.length && startSample + i < totalSamples;
        i++
      ) {
        userTrack[startSample + i] = chunk.samples[i];
      }
    }

    for (const chunk of assistantBuffers || []) {
      const startSample = Math.floor((chunk.timestamp / 1000) * sampleRate);
      for (
        let i = 0;
        i < chunk.samples.length && startSample + i < totalSamples;
        i++
      ) {
        assistantTrack[startSample + i] = chunk.samples[i];
      }
    }

    const stereoBuffer = Buffer.alloc(totalSamples * 4);
    let bufferOffset = 0;

    for (let i = 0; i < totalSamples; i++) {
      stereoBuffer.writeInt16LE(userTrack[i], bufferOffset);
      stereoBuffer.writeInt16LE(assistantTrack[i], bufferOffset + 2);
      bufferOffset += 4;
    }

    const numChannels = 2;
    const bitsPerSample = 16;

    const wavHeader = writeWavHeader(
      stereoBuffer,
      sampleRate,
      numChannels,
      bitsPerSample,
    );
    const wavFile = Buffer.concat([wavHeader, stereoBuffer]);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${callId.substring(0, 20)}_stereo_${timestamp}.wav`;
    const filepath = path.join(recordingsDir, filename);

    await fs.promises.writeFile(filepath, wavFile);

    const fileSizeKB = (wavFile.length / 1024).toFixed(2);
    const durationSec = (totalSamples / sampleRate).toFixed(2);

    logger.log(
      `[${callId}] Saved stereo recording: ${filename} (${fileSizeKB} KB, ${durationSec}s)`,
    );

    return filename;
  } catch (err) {
    logger.error(`[${callId}] Error mixing stereo recording:`, err);
    return null;
  }
}

/**
 * Resample audio linearly
 */
function resampleLinear(input, inputRate, outputRate) {
  const ratio = outputRate / inputRate;
  const outputLength = Math.floor(input.length * ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i / ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, input.length - 1);
    const t = srcIndex - srcFloor;

    output[i] = Math.round(input[srcFloor] * (1 - t) + input[srcCeil] * t);
  }

  return output;
}

/**
 * Wait for ICE connection to establish
 */
function waitForIceConnection(pc) {
  return new Promise((resolve, reject) => {
    if (
      pc.iceConnectionState === "connected" ||
      pc.iceConnectionState === "completed"
    ) {
      return resolve();
    }

    const timeout = setTimeout(() => {
      reject(new Error("ICE connection timeout"));
    }, 30000);

    const checkState = () => {
      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        clearTimeout(timeout);
        pc.removeEventListener("iceconnectionstatechange", checkState);
        resolve();
      } else if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed"
      ) {
        clearTimeout(timeout);
        pc.removeEventListener("iceconnectionstatechange", checkState);
        reject(new Error(`ICE ${pc.iceConnectionState}`));
      }
    };

    pc.addEventListener("iceconnectionstatechange", checkState);
  });
}

module.exports = {
  writeWavHeader,
  saveRecording,
  mixStereoRecording,
  resampleLinear,
  waitForIceConnection,
};

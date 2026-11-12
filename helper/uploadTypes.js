// [CUSTOM] One list of file types the inbox may upload, used by both the
// owner (/api/user/return_media_url) and agent (/api/agent/return_media_url)
// uploads. Uploaded files are served from our own domain, so web pages and
// scripts (html, svg, js) must never be allowed.
const path = require("path");

function getFileExtension(name) {
  return path.extname(String(name || "")).replace(".", "");
}

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/webm;codecs=opus",
  "application/pdf",
  "application/json",
  "text/json",
  // [CUSTOM] office files, text, archives and more phone media formats
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/csv",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/octet-stream",
  "video/quicktime",
  "video/3gpp",
  "audio/aac",
  "audio/x-m4a",
  "audio/mp4",
  "audio/amr",
];

const allowedExtensions = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "mp4",
  "mp3",
  "ogg",
  "wav",
  "pdf",
  "json",
  "webm",
  // [CUSTOM]
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip", "rar",
  "mov", "3gp", "aac", "m4a", "amr",
];

const validateUploadFile = (file) => {
  if (!file) return false;

  const ext = getFileExtension(file.name)?.toLowerCase();

  if (!allowedExtensions.includes(ext)) return false;
  if (!allowedMimeTypes.includes(file.mimetype)) return false;

  return true;
};

module.exports = { validateUploadFile, allowedMimeTypes, allowedExtensions };

// automation/googleServices.js
const { google } = require("googleapis");
const fetch = require("node-fetch");
const logger = require("../utils/logger");

// ── SSRF protection ───────────────────────────────────────────────────────────
const ALLOWED_HOSTS = (() => {
  try {
    return [new URL(process.env.BACKURI).hostname];
  } catch {
    return [];
  }
})();

function isAllowedUrl(urlString) {
  try {
    const { hostname } = new URL(urlString);
    return ALLOWED_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthClient(credentialsUrl, scopes) {
  if (!isAllowedUrl(credentialsUrl)) {
    throw new Error("SSRF blocked: credentials URL not allowed");
  }

  const res = await fetch(credentialsUrl);
  if (!res.ok)
    throw new Error(`Failed to fetch service account JSON: ${res.status}`);

  // ── Get raw text first, then parse ───────────────────────────────────────
  const rawText = await res.text();

  let credentials;
  try {
    credentials = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Invalid service account JSON: ${e.message}`);
  }

  // ── Validate required fields ──────────────────────────────────────────────
  if (!credentials.client_email) {
    throw new Error("Service account JSON missing client_email");
  }
  if (!credentials.private_key) {
    throw new Error("Service account JSON missing private_key");
  }

  // ── Fix private_key newline escaping ──────────────────────────────────────
  // When stored/retrieved, \n can become \\n — this restores proper line breaks
  const privateKey = credentials.private_key.replace(/\\n/g, "\n");

  // ── Validate key format ───────────────────────────────────────────────────
  if (!privateKey.includes("-----BEGIN")) {
    throw new Error(
      "private_key does not look like a valid PEM key. " +
        "Make sure you uploaded the raw service account JSON file.",
    );
  }

  logger.log(`Google Auth: using service account ${credentials.client_email}`);

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes,
  });

  try {
    await auth.authorize();
  } catch (authErr) {
    // Give a more helpful error message
    const hint = authErr.message?.includes("invalid_grant")
      ? " — Make sure the service account has access to this resource (share it with the service account email)."
      : authErr.message?.includes("unauthorized_client")
        ? " — Domain-wide delegation may be required for this scope."
        : "";

    throw new Error(`Google auth failed: ${authErr.message}${hint}`);
  }

  return { auth, credentials };
}

// ════════════════════════════════════════════════════════════════════════════
// SHEETS
// ════════════════════════════════════════════════════════════════════════════
async function sheetsAppend({
  credentialsUrl,
  spreadsheetId,
  sheetName,
  rowData,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);

  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === sheetName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
  }

  const values = Array.isArray(rowData) ? [rowData] : [Object.values(rowData)];

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values },
  });

  return { success: true, updatedRange: result.data.updates?.updatedRange };
}

async function sheetsRead({ credentialsUrl, spreadsheetId, sheetName, range }) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ]);

  const sheets = google.sheets({ version: "v4", auth });
  const fullRange = range ? `${sheetName}!${range}` : `${sheetName}!A:Z`;

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: fullRange,
  });

  return { success: true, data: result.data.values || [] };
}

async function sheetsUpdate({
  credentialsUrl,
  spreadsheetId,
  sheetName,
  range,
  values,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${range}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: Array.isArray(values[0]) ? values : [values] },
  });

  return { success: true };
}

// ════════════════════════════════════════════════════════════════════════════
// CALENDAR
// ════════════════════════════════════════════════════════════════════════════
async function calendarCreateEvent({
  credentialsUrl,
  calendarId = "primary",
  summary,
  description,
  startDateTime,
  endDateTime,
  timeZone = "UTC",
  attendees = [],
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/calendar",
  ]);

  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary,
    description,
    start: { dateTime: startDateTime, timeZone },
    end: { dateTime: endDateTime, timeZone },
    attendees: attendees.map((email) => ({ email })),
  };

  const result = await calendar.events.insert({
    calendarId,
    resource: event,
    sendUpdates: attendees.length > 0 ? "all" : "none",
  });

  return {
    success: true,
    eventId: result.data.id,
    eventLink: result.data.htmlLink,
    eventData: result.data,
  };
}

async function calendarListEvents({
  credentialsUrl,
  calendarId = "primary",
  timeMin,
  timeMax,
  maxResults = 10,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);

  const calendar = google.calendar({ version: "v3", auth });

  const result = await calendar.events.list({
    calendarId,
    timeMin: timeMin || new Date().toISOString(),
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return {
    success: true,
    events: result.data.items || [],
    count: result.data.items?.length || 0,
  };
}

async function calendarDeleteEvent({
  credentialsUrl,
  calendarId = "primary",
  eventId,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/calendar",
  ]);

  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId, eventId });

  return { success: true };
}

async function calendarGetEvent({
  credentialsUrl,
  calendarId = "primary",
  eventId,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);

  const calendar = google.calendar({ version: "v3", auth });
  const result = await calendar.events.get({ calendarId, eventId });

  return { success: true, event: result.data };
}

// ════════════════════════════════════════════════════════════════════════════
// DRIVE
// ════════════════════════════════════════════════════════════════════════════
async function driveListFiles({
  credentialsUrl,
  folderId,
  mimeType,
  maxResults = 20,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/drive.readonly",
  ]);

  const drive = google.drive({ version: "v3", auth });

  let q = `trashed = false`;
  if (folderId) q += ` AND '${folderId}' in parents`;
  if (mimeType) q += ` AND mimeType = '${mimeType}'`;

  const result = await drive.files.list({
    q,
    pageSize: maxResults,
    fields: "files(id, name, mimeType, webViewLink, createdTime, size)",
  });

  return { success: true, files: result.data.files || [] };
}

async function driveCreateFolder({
  credentialsUrl,
  folderName,
  parentFolderId,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/drive",
  ]);

  const drive = google.drive({ version: "v3", auth });

  const fileMetadata = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
    ...(parentFolderId ? { parents: [parentFolderId] } : {}),
  };

  const result = await drive.files.create({
    resource: fileMetadata,
    fields: "id, name, webViewLink",
  });

  return { success: true, folder: result.data };
}

async function driveUploadFile({
  credentialsUrl,
  fileName,
  fileUrl,
  mimeType,
  folderId,
}) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/drive",
  ]);

  if (!isAllowedUrl(fileUrl)) {
    throw new Error("SSRF blocked: file URL not allowed");
  }

  const drive = google.drive({ version: "v3", auth });

  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error("Failed to fetch file for upload");

  const fileMetadata = {
    name: fileName,
    ...(folderId ? { parents: [folderId] } : {}),
  };

  const media = {
    mimeType:
      mimeType ||
      fileRes.headers.get("content-type") ||
      "application/octet-stream",
    body: fileRes.body,
  };

  const result = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id, name, webViewLink",
  });

  return { success: true, file: result.data };
}

// ════════════════════════════════════════════════════════════════════════════
// DOCS
// ════════════════════════════════════════════════════════════════════════════
async function docsCreateDocument({ credentialsUrl, title, content }) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
  ]);

  const docs = google.docs({ version: "v1", auth });

  const doc = await docs.documents.create({ resource: { title } });
  const documentId = doc.data.documentId;

  if (content) {
    await docs.documents.batchUpdate({
      documentId,
      resource: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: content,
            },
          },
        ],
      },
    });
  }

  return {
    success: true,
    documentId,
    documentUrl: `https://docs.google.com/document/d/${documentId}`,
  };
}

async function docsAppendText({ credentialsUrl, documentId, text }) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/documents",
  ]);

  const docs = google.docs({ version: "v1", auth });

  const doc = await docs.documents.get({ documentId });
  const endIndex = doc.data.body.content.at(-1)?.endIndex - 1 || 1;

  await docs.documents.batchUpdate({
    documentId,
    resource: {
      requests: [
        {
          insertText: {
            location: { index: endIndex },
            text: `\n${text}`,
          },
        },
      ],
    },
  });

  return { success: true };
}

async function docsReadDocument({ credentialsUrl, documentId }) {
  const { auth } = await getAuthClient(credentialsUrl, [
    "https://www.googleapis.com/auth/documents.readonly",
  ]);

  const docs = google.docs({ version: "v1", auth });
  const doc = await docs.documents.get({ documentId });

  let text = "";
  for (const element of doc.data.body?.content || []) {
    if (element.paragraph) {
      for (const pe of element.paragraph.elements || []) {
        if (pe.textRun?.content) text += pe.textRun.content;
      }
    }
  }

  return { success: true, title: doc.data.title, text, raw: doc.data };
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORTS  ← single place, clean CJS style
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  sheetsAppend,
  sheetsRead,
  sheetsUpdate,
  calendarCreateEvent,
  calendarListEvents,
  calendarDeleteEvent,
  calendarGetEvent,
  driveListFiles,
  driveCreateFolder,
  driveUploadFile,
  docsCreateDocument,
  docsAppendText,
  docsReadDocument,
};

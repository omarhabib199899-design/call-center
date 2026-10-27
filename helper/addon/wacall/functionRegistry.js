const axios = require("axios");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise");
const { query } = require("../../../database/dbpromise");
const { substituteVariables } = require("./utils");
const logger = require("../../../utils/logger");

const ALLOWED_API_PROTOCOLS = ["https:", "http:"];

function assertSafeUrl(urlString, label = "URL") {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`${label} is not a valid URL: ${urlString}`);
  }

  if (!ALLOWED_API_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`${label} uses a disallowed protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::1$/,
    /^fc00:/,
    /^0\./,
    /^metadata\.google\.internal$/,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(hostname)) {
      throw new Error(
        `${label} targets a disallowed internal address: ${hostname}`,
      );
    }
  }

  return parsed;
}

async function sendMessageFunc(params) {
  logger.log(" sendMessageFunc called");
  try {
    const mobile =
      params.mobile || params.openAiArgs?.mobile || "default_mobile";
    logger.log(`📱 Sending message to mobile: ${mobile}`);

    return new Promise((resolve) => {
      setTimeout(() => {
        const result = {
          success: false,
          msg: "The number should be start from 44",
        };
        logger.log(" sendMessageFunc result:", result);
        resolve(result);
      }, 2000);
    });
  } catch (error) {
    logger.error(" ERROR in sendMessageFunc:", {
      message: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
}

async function sendEmailFunc(params) {
  logger.log(" sendEmailFunc called");
  try {
    return new Promise((resolve) => {
      setTimeout(() => {
        const result = { success: true, msg: "Email was sent to the number" };
        logger.log(" sendEmailFunc result:", result);
        resolve(result);
      }, 2000);
    });
  } catch (error) {
    logger.error(" ERROR in sendEmailFunc:", {
      message: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
}

async function makeApiCallFunc(params) {
  logger.log("🌐 makeApiCallFunc called");
  try {
    const nodeData = params.currentNode.data || params.currentNode;
    const method = (nodeData.method || "GET").toUpperCase();
    const rawUrl = nodeData.url || "";
    const timeout = nodeData.timeout || 10000;

    logger.log(`🔗 API Call - Method: ${method}, Raw URL: ${rawUrl}`);
    const url = substituteVariables(rawUrl, params);
    logger.log(`🔗 API Call - Substituted URL: ${url}`);

    if (!url || url.trim() === "") {
      throw new Error("URL is required and cannot be empty");
    }

    // SSRF protection — validates protocol and blocks internal addresses
    assertSafeUrl(url, "API Call URL");

    const headers = {};
    if (nodeData.headers && Array.isArray(nodeData.headers)) {
      nodeData.headers.forEach((header) => {
        if (header.key && header.value) {
          const key = substituteVariables(header.key, params);
          const value = substituteVariables(header.value, params);
          headers[key] = value;
        }
      });
    }

    const queryParams = {};
    if (nodeData.queryParams && Array.isArray(nodeData.queryParams)) {
      nodeData.queryParams.forEach((param) => {
        if (param.key && param.value) {
          const key = substituteVariables(param.key, params);
          const value = substituteVariables(param.value, params);
          queryParams[key] = value;
        }
      });
    }

    let requestBody = null;
    if (["POST", "PUT", "PATCH"].includes(method) && nodeData.body) {
      const bodyString = substituteVariables(nodeData.body, params);
      try {
        requestBody = JSON.parse(bodyString);
      } catch (e) {
        requestBody = bodyString;
      }
    }

    const axiosConfig = {
      method: method.toLowerCase(),
      url: url,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      params: queryParams,
      timeout: timeout,
      validateStatus: function (status) {
        return status >= 200 && status < 600;
      },
    };

    if (requestBody !== null) {
      axiosConfig.data = requestBody;
    }

    logger.log(`📡 Making API request:`, {
      method: axiosConfig.method,
      url: axiosConfig.url,
      hasHeaders: Object.keys(axiosConfig.headers).length > 0,
      hasParams: Object.keys(axiosConfig.params).length > 0,
      hasBody: !!axiosConfig.data,
    });

    const response = await axios(axiosConfig);

    logger.log(` API Call successful - Status: ${response.status}`);

    let responseData;
    try {
      if (typeof response.data === "object" && response.data !== null) {
        responseData = response.data;
      } else {
        responseData = JSON.parse(response.data);
      }
    } catch (e) {
      responseData = {};
    }

    return {
      success: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      data: responseData,
      headers: response.headers,
      url: response.config.url,
      method: response.config.method?.toUpperCase(),
    };
  } catch (error) {
    logger.error(" ERROR in makeApiCallFunc:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });

    if (error.code === "ECONNABORTED") {
      return {
        success: false,
        error: "Request timeout",
        data: {},
        status: 0,
      };
    } else if (error.response) {
      logger.error(` API Error Response - Status: ${error.response.status}`, {
        statusText: error.response.statusText,
        data: error.response.data,
      });

      let errorData;
      try {
        errorData =
          typeof error.response.data === "object"
            ? error.response.data
            : JSON.parse(error.response.data);
      } catch (e) {
        errorData = {};
      }

      return {
        success: false,
        status: error.response.status,
        statusText: error.response.statusText,
        error: error.message,
        data: errorData,
      };
    } else {
      return {
        success: false,
        error: error.message || "Unknown error",
        data: {},
        status: 0,
      };
    }
  }
}

async function googleServicesFunc(params) {
  logger.log("🔧 googleServicesFunc called");
  try {
    const nodeData = params.currentNode || params.currentNode?.data;
    const serviceType = nodeData.serviceType || "sheets";
    const credentialId = nodeData.credentialId;

    logger.log(
      ` Google Service - Type: ${serviceType}, Credential ID: ${credentialId}`,
    );

    if (!credentialId) {
      throw new Error("Google credential ID is required");
    }

    // Get credentials from database
    const credQuery = `SELECT service_account_json FROM google_credentials 
                      WHERE credential_id = ? AND is_active = 1`;
    const credResult = await query(credQuery, [credentialId]);

    if (credResult.length === 0) {
      throw new Error("Google credentials not found or inactive");
    }

    const serviceAccountJson = JSON.parse(credResult[0].service_account_json);

    // Create JWT client
    const jwtClient = new google.auth.JWT(
      serviceAccountJson.client_email,
      null,
      serviceAccountJson.private_key,
      serviceType === "sheets"
        ? ["https://www.googleapis.com/auth/spreadsheets"]
        : [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/admin.directory.resource.calendar",
          ],
      null,
    );

    await jwtClient.authorize();
    logger.log(" Google JWT client authorized");

    if (serviceType === "sheets") {
      return await handleSheetsOperation(jwtClient, nodeData, params);
    } else if (serviceType === "calendar") {
      return await handleCalendarOperation(jwtClient, nodeData, params);
    }

    throw new Error(`Unsupported service type: ${serviceType}`);
  } catch (error) {
    logger.error(" ERROR in googleServicesFunc:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message || "Unknown error",
      data: {},
    };
  }
}

async function handleSheetsOperation(jwtClient, nodeData, params) {
  logger.log(" handleSheetsOperation called");
  try {
    const sheets = google.sheets({ version: "v4", auth: jwtClient });

    const spreadsheetId = substituteVariables(nodeData.spreadsheetId, params);
    const range = substituteVariables(nodeData.range, params);
    const action = nodeData.action || "writeSheet";

    logger.log(` Sheets Operation - Action: ${action}, Range: ${range}`);

    if (action === "writeSheet") {
      let values;
      try {
        const valuesString = substituteVariables(nodeData.values, params);
        values = JSON.parse(valuesString);
      } catch (e) {
        throw new Error("Invalid values format. Must be valid JSON array.");
      }

      const response = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        resource: { values },
      });

      logger.log(
        ` Sheets write successful - Updated ${response.data.updatedCells} cells`,
      );

      return {
        success: true,
        action: "writeSheet",
        updatedCells: response.data.updatedCells,
        updatedRows: response.data.updatedRows,
        spreadsheetId,
        range,
      };
    } else if (action === "readSheet") {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      logger.log(
        ` Sheets read successful - Retrieved ${
          response.data.values?.length || 0
        } rows`,
      );

      return {
        success: true,
        action: "readSheet",
        values: response.data.values || [],
        range: response.data.range,
        spreadsheetId,
      };
    }

    throw new Error(`Unsupported sheets action: ${action}`);
  } catch (error) {
    logger.error(" ERROR in handleSheetsOperation:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    throw error;
  }
}

async function handleCalendarOperation(jwtClient, nodeData, params) {
  logger.log("📅 handleCalendarOperation called");
  try {
    const calendar = google.calendar({ version: "v3", auth: jwtClient });

    const calendarId = substituteVariables(
      nodeData.calendarId || "primary",
      params,
    );
    const eventTitle = substituteVariables(nodeData.eventTitle, params);
    const eventDate = substituteVariables(nodeData.eventDate, params);
    const eventDescription = substituteVariables(
      nodeData.eventDescription || "",
      params,
    );

    logger.log(`Calendar Event - Title: ${eventTitle}, Date: ${eventDate}`);

    if (!eventTitle || !eventDate) {
      throw new Error("Event title and date are required");
    }

    // Parse the date - assuming ISO format or simple date
    let startDateTime, endDateTime;
    try {
      const date = new Date(eventDate);
      startDateTime = date.toISOString();
      // Default to 1 hour duration
      endDateTime = new Date(date.getTime() + 60 * 60 * 1000).toISOString();
    } catch (e) {
      throw new Error(
        "Invalid date format. Use ISO format like: 2024-12-25T10:00:00",
      );
    }

    const event = {
      summary: eventTitle,
      description: eventDescription,
      start: {
        dateTime: startDateTime,
        timeZone: "UTC",
      },
      end: {
        dateTime: endDateTime,
        timeZone: "UTC",
      },
    };

    const response = await calendar.events.insert({
      calendarId,
      resource: event,
    });

    logger.log(` Calendar event created - ID: ${response.data.id}`);

    return {
      success: true,
      action: "createEvent",
      eventId: response.data.id,
      eventLink: response.data.htmlLink,
      calendarId,
      eventTitle,
      eventDate: startDateTime,
    };
  } catch (error) {
    logger.error(" ERROR in handleCalendarOperation:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    throw error;
  }
}

async function sendWhatsappFunc(params) {
  logger.log("sendWhatsappFunc called");
  try {
    const nodeData = params.currentNode.data || params.currentNode;

    const baseUrl = substituteVariables(
      nodeData.baseUrl || "https://crm.oneoftheprojects.com",
      params,
    );
    const fullUrl = `${baseUrl}/api/qr/rest/send_message`;

    // SSRF protection — validates protocol and blocks internal addresses
    assertSafeUrl(fullUrl, "WhatsApp baseUrl");

    const token = substituteVariables(nodeData.token || "", params);
    const from = substituteVariables(nodeData.from || "", params);
    const to = substituteVariables(nodeData.to || "", params);
    const messageType = nodeData.messageType || "text";

    logger.log(`📱 WhatsApp - Type: ${messageType}, To: ${to}`);

    const normalizeNumber = (num) => (num ? num.replace(/\D/g, "") : "");

    const body = {
      messageType,
      requestType: "POST",
      token,
      from: normalizeNumber(from),
      to: normalizeNumber(to),
    };

    switch (messageType) {
      case "text":
        body.text = substituteVariables(nodeData.text || "", params);
        break;
      case "image":
        body.imageUrl = substituteVariables(nodeData.imageUrl || "", params);
        body.caption = substituteVariables(nodeData.imageCaption || "", params);
        break;
      case "video":
        body.videoUrl = substituteVariables(nodeData.videoUrl || "", params);
        body.caption = substituteVariables(nodeData.videoCaption || "", params);
        break;
      case "audio":
        body.aacUrl = substituteVariables(nodeData.aacUrl || "", params);
        break;
      case "document":
        body.docUrl = substituteVariables(nodeData.docUrl || "", params);
        body.caption = substituteVariables(nodeData.docCaption || "", params);
        break;
      case "location":
        body.lat = substituteVariables(nodeData.lat || "", params);
        body.long = substituteVariables(nodeData.long || "", params);
        body.title = substituteVariables(nodeData.locationTitle || "", params);
        break;
      default:
        throw new Error(`Unsupported message type: ${messageType}`);
    }

    const response = await axios.post(fullUrl, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    logger.log(` WhatsApp message sent successfully`);

    return {
      success: response.data.success,
      message: response.data.message,
      data: response.data.data || {},
    };
  } catch (error) {
    logger.error(" ERROR in sendWhatsappFunc:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message || "Unknown error",
      data: {},
    };
  }
}

async function hangupCallFunc(params) {
  logger.log("📞 hangupCallFunc called");
  try {
    const farewell = params.currentNode?.farewellMessage || "Goodbye!";
    logger.log(`👋 Hangup with farewell: ${farewell}`);

    return {
      instruct: "Hang up the call after saying the farewell message",
      data: {
        hangup: true,
        farewell: farewell,
      },
    };
  } catch (error) {
    logger.error(" ERROR in hangupCallFunc:", {
      message: error.message,
      stack: error.stack,
    });
    return {
      instruct: "Hangup failed",
      data: { error: error.message },
    };
  }
}

async function sendSmtpEmailFunc(params) {
  logger.log(" sendSmtpEmailFunc called");
  try {
    const nodeData = params.currentNode.data || params.currentNode;

    const smtpHost = substituteVariables(nodeData.smtpHost, params);
    const smtpPort =
      parseInt(substituteVariables(nodeData.smtpPort, params)) || 587;
    const smtpSecure = nodeData.smtpSecure;
    const smtpUser = substituteVariables(nodeData.smtpUser, params);
    const smtpPass = substituteVariables(nodeData.smtpPass, params);
    const fromEmail = substituteVariables(nodeData.fromEmail, params);
    const toEmail = substituteVariables(nodeData.toEmail, params);
    const emailSubject = substituteVariables(nodeData.emailSubject, params);
    const emailBody = substituteVariables(nodeData.emailBody, params);

    logger.log(
      `📮 SMTP Email - From: ${fromEmail}, To: ${toEmail}, Host: ${smtpHost}`,
    );

    if (
      !smtpHost ||
      !smtpUser ||
      !smtpPass ||
      !fromEmail ||
      !toEmail ||
      !emailSubject ||
      !emailBody
    ) {
      throw new Error("Missing required SMTP or email fields");
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const mailOptions = {
      from: fromEmail,
      to: toEmail,
      subject: emailSubject,
      text: emailBody,
    };

    const info = await transporter.sendMail(mailOptions);
    logger.log(` SMTP Email sent - Message ID: ${info.messageId}`);

    return {
      success: true,
      message: "Email sent successfully",
      messageId: info.messageId,
      response: info.response,
    };
  } catch (error) {
    logger.error(" ERROR in sendSmtpEmailFunc:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message || "Failed to send email",
    };
  }
}

async function mysqlQueryFunc(params) {
  logger.log("🗄️ mysqlQueryFunc called");
  try {
    const nodeData = params.currentNode.data || params.currentNode;
    const {
      host,
      port,
      user,
      password,
      database,
      query: rawQuery,
      params: rawParams,
    } = nodeData;

    logger.log(`🔌 MySQL Connection - Host: ${host}, Database: ${database}`);

    // Substitute variables in query and params
    const substitutedQuery = substituteVariables(rawQuery, params);
    const substitutedParams = rawParams.map((param) =>
      substituteVariables(param, params),
    );

    logger.log(` MySQL Query: ${substitutedQuery}`);

    // Create connection
    const connection = await mysql.createConnection({
      host: host || "localhost",
      port: port || 3306,
      user: user || "root",
      password: password || "",
      database: database || "",
    });

    logger.log(" MySQL connection established");

    try {
      // Execute query with prepared statements
      const [rows, fields] = await connection.execute(
        substitutedQuery,
        substitutedParams,
      );

      logger.log(
        ` MySQL query executed - Rows affected: ${
          rows.affectedRows || rows.length || 0
        }`,
      );

      return {
        success: true,
        rowsAffected: rows.affectedRows || 0,
        data: rows,
      };
    } finally {
      await connection.end();
      logger.log("🔌 MySQL connection closed");
    }
  } catch (error) {
    logger.error(" ERROR in mysqlQueryFunc:", {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message || "Unknown error",
      data: [],
    };
  }
}

const functionRegistry = {
  mysql_query: async (params) => {
    logger.log("🗄️ mysql_query registry function called");
    try {
      const result = await mysqlQueryFunc(params);
      return {
        instruct:
          "MySQL query completed. Check the response data for results or errors.",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in mysql_query registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct: "MySQL query failed. Check the error details.",
        data: {
          success: false,
          error: error.message || "Unknown error",
          data: [],
        },
      };
    }
  },

  play_audio: async (params, ws, streamSid) => {
    logger.log("🎵 play_audio registry function called");
    try {
      const result = await playAudioFunc(params, ws, streamSid);
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in play_audio registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: { error: error.message || "Unknown error" },
      };
    }
  },

  send_smtp_email: async (params) => {
    logger.log(" send_smtp_email registry function called");
    try {
      const result = await sendSmtpEmailFunc(params);
      return {
        instruct:
          "Check the response if success or failed and act as per the response",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in send_smtp_email registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct:
          "Check the response if success or failed and act as per the response",
        data: { error: error.message || "Unknown error" },
      };
    }
  },

  send_sms: async (params) => {
    logger.log("📱 send_sms registry function called");
    try {
      const result = await sendSmsFunc(params);
      return {
        instruct:
          "SMS sending completed. Check the response data for success/failure status.",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in send_sms registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct: "SMS sending failed. Check the error details.",
        data: {
          success: false,
          error: error.message || "Unknown error",
        },
      };
    }
  },

  send_whatsapp: async (params) => {
    logger.log("send_whatsapp registry function called");
    try {
      const result = await sendWhatsappFunc(params);
      return {
        instruct:
          "WhatsApp message sent. Check the response for success/failure.",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in send_whatsapp registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct: "WhatsApp message failed. Check the error details.",
        data: {
          success: false,
          error: error.message || "Unknown error",
          data: {},
        },
      };
    }
  },

  hangup_call: async (params) => {
    logger.log("📞 hangup_call registry function called");
    try {
      const result = await hangupCallFunc(params);
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: result.data,
      };
    } catch (error) {
      logger.error(" ERROR in hangup_call registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: { error: error.message || "Unknown error" },
      };
    }
  },

  google_services: async (params) => {
    logger.log("🔧 google_services registry function called");
    try {
      const result = await googleServicesFunc(params);
      return {
        instruct:
          "Google Services operation completed. Check the response data and status for success/failure.",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in google_services registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct: "Google Services operation failed. Check the error details.",
        data: {
          success: false,
          error: error.message || "Unknown error",
          data: {},
        },
      };
    }
  },

  api_call: async (params) => {
    logger.log("🌐 api_call registry function called");
    try {
      const result = await makeApiCallFunc(params);
      return {
        instruct:
          "API call completed. Check the response data and status for success/failure.",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in api_call registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct: "API call failed. Check the error details.",
        data: {
          success: false,
          error: error.message || "Unknown error",
          data: {},
        },
      };
    }
  },

  send_message: async (params) => {
    logger.log(" send_message registry function called");
    try {
      const result = await sendMessageFunc(params);
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in send_message registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: { error: error.message || "Unknown error" },
      };
    }
  },

  send_email: async (params) => {
    logger.log(" send_email registry function called");
    try {
      const result = await sendEmailFunc(params);
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: result,
      };
    } catch (error) {
      logger.error(" ERROR in send_email registry:", {
        message: error.message,
        stack: error.stack,
      });
      return {
        instruct:
          "check the response if success or failed and act as per the response",
        data: { error: error.message || "Unknown error" },
      };
    }
  },
};

module.exports = {
  functionRegistry,
  makeApiCallFunc,
  sendMessageFunc,
  sendEmailFunc,
  sendWhatsappFunc,
  sendSmtpEmailFunc,
  mysqlQueryFunc,
};

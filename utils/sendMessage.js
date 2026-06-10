// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const axios = require("axios");

const BASE_LISTENER_URL = process.env.BASE_LISTENER_URL;
const REPLY_MESSAGE_URL = `${BASE_LISTENER_URL}/reply-message`;
const SEND_WHATSAPP_MESSAGE_URL = `${BASE_LISTENER_URL}/send-message`;
const SEND_WHATSAPP_WITH_MENTIONS_URL = `${BASE_LISTENER_URL}/send-message-with-mentions`;
const SEND_TYPING_URL = `${BASE_LISTENER_URL}/send-typing-state`;

/**
 * Sends a WhatsApp reply message via the /reply-message endpoint.
 *
 * @param {string} chatId - The destination chat identifier (phone number).
 * @param {string} message - The message to send.
 * @param {string} [clientId=process.env.WHATSAPP_CLIENT_ID || '6587842038'] - Optional client ID.
 * @param {number} [timeout=30000] - Request timeout in milliseconds.
 * @param {string} [quotedMessageId] - Optional message ID to quote/reply to.
 * @returns {Promise<any>} - The axios response data.
 */
async function sendWhatsAppReply(
  chatId,
  message,
  clientId = process.env.WHATSAPP_CLIENT_ID || "6587842038",
  timeout = 30000,
  quotedMessageId = null,
) {
  try {
    console.log(`Sending WhatsApp reply to ${chatId}`);

    // Build payload with optional quotedMessageId
    const payload = { chatId, message, clientId };
    if (quotedMessageId) {
      payload.quotedMessageId = quotedMessageId;
      console.log(`Including quotedMessageId: ${quotedMessageId}`);
    }

    const response = await axios.post(REPLY_MESSAGE_URL, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout,
    });
    console.log("Message sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp reply:", error);
    throw error;
  }
}

/**
 * Sends a WhatsApp message without quoting (for standalone messages like reminders).
 * Uses SEND_WHATSAPP_MESSAGE_URL endpoint.
 *
 * @param {string} chatId - The destination chat identifier (group ID or phone number).
 * @param {string} message - The message to send.
 * @param {string} [clientId=process.env.WHATSAPP_CLIENT_ID || '6587842038'] - Optional client ID.
 * @param {number} [timeout=30000] - Request timeout in milliseconds.
 * @returns {Promise<any>} - The axios response data.
 */
async function sendWhatsAppMessage(
  chatId,
  message,
  clientId = process.env.WHATSAPP_CLIENT_ID || "6587842038",
  timeout = 30000,
) {
  try {
    console.log(`Sending WhatsApp message to ${chatId}`);

    const payload = {
      chatId,
      message,
      clientId,
    };

    const response = await axios.post(SEND_WHATSAPP_MESSAGE_URL, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout,
    });
    console.log("Message sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    throw error;
  }
}

/**
 * Sends a WhatsApp message with @mentions via /send-message-with-mentions.
 * Embed mentions as @<phoneNumber> in the message text (e.g., "@6591234567").
 * The listener auto-extracts them.
 *
 * @param {string} chatId - The destination chat identifier (group ID or phone number).
 * @param {string} message - The message to send (with @<phone> patterns for mentions).
 * @param {string} [clientId] - Optional client ID.
 * @param {number} [timeout=30000] - Request timeout in milliseconds.
 * @returns {Promise<any>} - The axios response data.
 */
async function sendWhatsAppMessageWithMentions(
  chatId,
  message,
  clientId = process.env.WHATSAPP_CLIENT_ID || "6587842038",
  timeout = 30000,
) {
  try {
    console.log(`Sending WhatsApp message with mentions to ${chatId}`);

    const payload = {
      chatId,
      message,
      clientId,
    };

    const response = await axios.post(SEND_WHATSAPP_WITH_MENTIONS_URL, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout,
    });
    console.log("Message with mentions sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp message with mentions:", error);
    throw error;
  }
}

/**
 * Sends a typing indicator to a WhatsApp chat.
 *
 * @param {string} chatId - The destination chat identifier.
 * @param {string} [clientId=process.env.WHATSAPP_CLIENT_ID || '6587842038'] - Optional client ID.
 * @returns {Promise<void>}
 */
async function sendTypingIndicator(chatId, clientId = process.env.WHATSAPP_CLIENT_ID || "6587842038") {
  if (!chatId) return;

  try {
    await axios.post(
      SEND_TYPING_URL,
      { chatId, clientId },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 5000,
      },
    );
    console.log(`Typing indicator sent for chat ${chatId}`);
  } catch (error) {
    console.warn("Failed to send typing indicator:", error?.message || error);
  }
}

const SEND_DOCUMENT_URL = `${BASE_LISTENER_URL}/send-document`;

/**
 * Sends a WhatsApp image message via the /send-document endpoint.
 * Uses sendAsDocument=false so the image renders inline (not as a file attachment).
 *
 * @param {string} chatId - The destination chat identifier (group ID or phone number).
 * @param {string} imageUrl - Public URL of the image to send.
 * @param {string} [caption] - Optional caption text below the image.
 * @param {string} [clientId] - Optional client ID.
 * @param {number} [timeout=60000] - Request timeout in milliseconds.
 * @returns {Promise<any>} - The axios response data.
 */
async function sendWhatsAppImage(
  chatId,
  imageUrl,
  caption = "",
  clientId = process.env.WHATSAPP_CLIENT_ID || "6587842038",
  timeout = 60000,
) {
  try {
    console.log(`Sending WhatsApp image to ${chatId}`);

    const payload = {
      chatId,
      fileUrl: imageUrl,
      mimeType: "image/png",
      fileName: "manpower-data.png",
      caption,
      clientId,
      sendAsDocument: false,
    };

    const response = await axios.post(SEND_DOCUMENT_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout,
    });
    console.log("Image sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp image:", error?.message || error);
    throw error;
  }
}

/**
 * Send a PDF (or any non-image file) as a WhatsApp DOCUMENT attachment.
 * Uses sendAsDocument=true so recipients see a downloadable file (not inline image).
 *
 * @param {string} chatId
 * @param {string} fileUrl   public/signed URL the listener can fetch
 * @param {string} fileName  display name in WhatsApp (e.g. "Document Log Outgoing.pdf")
 * @param {string} [caption] optional text caption shown beside the document
 * @param {string} [mimeType] defaults to "application/pdf"
 * @param {string} [clientId]
 * @param {number} [timeout=60000]
 * @returns {Promise<any>}
 */
async function sendWhatsAppDocument(
  chatId,
  fileUrl,
  fileName,
  caption = "",
  mimeType = "application/pdf",
  clientId = process.env.WHATSAPP_CLIENT_ID || "6587842038",
  timeout = 60000,
) {
  try {
    console.log(`Sending WhatsApp document "${fileName}" to ${chatId}`);
    const payload = {
      chatId,
      fileUrl,
      mimeType,
      fileName,
      caption,
      clientId,
      sendAsDocument: true,
    };
    const response = await axios.post(SEND_DOCUMENT_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout,
    });
    console.log("Document sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp document:", error?.message || error);
    throw error;
  }
}

module.exports = {
  sendWhatsAppReply,
  sendWhatsAppMessage,
  sendWhatsAppMessageWithMentions,
  sendWhatsAppDocument,
  sendTypingIndicator,
  sendWhatsAppImage,
};

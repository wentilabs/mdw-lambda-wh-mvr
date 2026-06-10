/**
 * Manpower Report Reminder API endpoint
 *
 * Checks which companies have NOT submitted their manpower report for today
 * and sends a WhatsApp reminder listing all missing companies.
 *
 * POST /manpower-reminder
 * {
 *   "date": "08-Apr-2026",           // Optional, DD-MMM-YYYY. Defaults to today (SG timezone)
 *   "groupIds": ["120363xxx@g.us"],   // Required — WhatsApp group(s) to send the reminder to
 *   "groupId": "120363xxx@g.us",      // Fallback — single group ID
 *   "dryRun": false                   // Optional — if true, returns message without sending
 * }
 */

const { loadData } = require("../utils/action");
const { sendWhatsAppMessage, sendWhatsAppMessageWithMentions } = require("../utils/sendMessage");
const { getSpreadsheetConfig } = require("../config/group-config");
const { getSupabaseClient } = require("../utils/common");

// 3-letter month constants
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// =============================================================================
// Expected companies that must submit daily manpower reports
// =============================================================================
const EXPECTED_COMPANIES = [
  "LT SAMBO",
  "LT SAMBO ( KKL)",
  "LT SAMBO (KTC)",
  "LT SAMBO(ATEC)",
  "LT_SAMBO *(ESK)*",
  "LT_SAMBO (TAEHWA )",
  "LT Sambo (ARSU)",
  "Woh Hup",
  "EGT",
];

const SIMILARITY_THRESHOLD = 0.9;

// If a company missed the last N WORKING days (days where at least one company
// submitted), treat them as "finished" and skip today's reminder. Override per
// request via body.inactiveLookbackDays.
const DEFAULT_INACTIVE_LOOKBACK_DAYS = 2;

// =============================================================================
// Date helpers (same pattern as daily-manpower-summary.js)
// =============================================================================

/**
 * Get today's date in DD-MMM-YYYY format using Singapore timezone
 * @returns {string} e.g. "08-Apr-2026"
 */
function getTodaySGT() {
  const now = new Date();
  const sg = { timeZone: "Asia/Singapore" };
  const day = now.toLocaleDateString("en-GB", { ...sg, day: "2-digit" });
  const month = now.toLocaleDateString("en-GB", { ...sg, month: "short" });
  const year = now.toLocaleDateString("en-GB", { ...sg, year: "numeric" });
  return `${day}-${month}-${year}`;
}

/**
 * Parse and validate date parameter in DD-MMM-YYYY format
 * @param {string} dateParam - Date string like "08-Apr-2026"
 * @returns {string} Validated DD-MMM-YYYY string
 */
function parseDate(dateParam) {
  if (!dateParam) return getTodaySGT();

  const match = dateParam.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: "${dateParam}". Expected DD-MMM-YYYY (e.g., "08-Apr-2026")`);

  const [, day, monthStr, year] = match;
  const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();
  if (!MONTHS.includes(monthCap)) {
    throw new Error(`Invalid month: "${monthStr}". Use 3-letter abbreviation (Jan, Feb, Mar, ...)`);
  }

  return `${day.padStart(2, "0")}-${monthCap}-${year}`;
}

/**
 * Convert DD-MMM-YYYY to YYYY-MM-DD (ISO) for matching against the Date column.
 * @param {string} ddMmmYyyy - Date in DD-MMM-YYYY format
 * @returns {string} ISO date string (e.g., "2026-04-08")
 */
function toIsoDate(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return ddMmmYyyy;
  const [, day, monthStr, year] = match;
  const monthIndex = MONTHS.indexOf(monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase());
  if (monthIndex === -1) return ddMmmYyyy;
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// =============================================================================
// Company name matching
// =============================================================================

/**
 * Normalize a company name by stripping all non-alphanumeric characters and lowercasing.
 * This produces a canonical form for comparison.
 *
 * Examples:
 *   "LT SAMBO"          → "ltsambo"
 *   "LT SAMBO ( KKL)"   → "ltsambokkl"
 *   "LT SAMBO (KTC)"    → "ltsamboktc"
 *   "LT_SAMBO *(ESK)*"  → "ltsamboesk"
 *   "Woh Hup"           → "wohhup"
 *
 * @param {string} name - Raw company name
 * @returns {string} Normalized form
 */
function normalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Compute Levenshtein similarity ratio between two strings (0 to 1).
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity ratio (1 = identical)
 */
function similarity(a, b) {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1;
  const lenA = al.length;
  const lenB = bl.length;
  if (lenA === 0 || lenB === 0) return 0;

  let prev = Array.from({ length: lenB + 1 }, (_, i) => i);
  let curr = new Array(lenB + 1);
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const dist = prev[lenB];
  return 1 - dist / Math.max(lenA, lenB);
}

/**
 * Resolve a sheet company name to the best-matching expected company.
 * Uses two-stage matching: exact normalized match, then Levenshtein on normalized forms.
 *
 * @param {string} sheetName - Company name from the sheet
 * @param {string[]} expectedList - List of expected company names
 * @returns {string|null} Matched expected company name, or null if no match
 */
function resolveSheetCompanyToExpected(sheetName, expectedList) {
  const normSheet = normalize(sheetName);
  if (!normSheet) return null;

  // Stage 1: Exact normalized match
  for (const expected of expectedList) {
    if (normSheet === normalize(expected)) {
      return expected;
    }
  }

  // Stage 2: Levenshtein similarity on normalized forms
  let bestMatch = null;
  let bestScore = 0;

  for (const expected of expectedList) {
    const score = similarity(normSheet, normalize(expected));
    if (score > bestScore) {
      bestScore = score;
      bestMatch = expected;
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD) {
    return bestMatch;
  }

  return null;
}

// Add `days` to an ISO YYYY-MM-DD date and return the new ISO date.
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Return the set of expected companies that submitted on a given ISO date.
function getSubmittersForDate(headers, rows, dateIso) {
  const dateIdx = headers.findIndex((h) => h === "Date");
  const companyIdx = headers.findIndex((h) => h === "Company");
  if (dateIdx === -1 || companyIdx === -1) return new Set();
  const set = new Set();
  for (const row of rows) {
    if (!row || !row[dateIdx]) continue;
    if (String(row[dateIdx]).trim() !== dateIso) continue;
    const matched = resolveSheetCompanyToExpected(String(row[companyIdx] || "").trim(), EXPECTED_COMPANIES);
    if (matched) set.add(matched);
  }
  return set;
}

/**
 * Companies considered "inactive / finished" — they have submitted at some
 * point in history, but missed the last `lookbackDays` WORKING days
 * (calendar days where at least one company submitted). Non-working days
 * (weekend / PH where nobody submits) don't count toward the streak, so a
 * Monday reminder isn't falsely silenced by Sat/Sun gaps.
 *
 * Returns a Set of expected-company names to SKIP from today's reminder.
 */
function findInactiveCompanies(manpowerData, todayIso, lookbackDays = DEFAULT_INACTIVE_LOOKBACK_DAYS) {
  if (!manpowerData || manpowerData.length <= 1) return new Set();
  const headers = manpowerData[0];
  const rows = manpowerData.slice(1);
  const companyIdx = headers.findIndex((h) => h === "Company");
  if (companyIdx === -1) return new Set();

  // Walk back day-by-day; only count days that had ANY submission as "working".
  const activeRecent = new Set();
  let workingDaysSeen = 0;
  let offset = 1;
  const maxOffset = lookbackDays * 14; // safety cap (covers long holidays)
  while (workingDaysSeen < lookbackDays && offset <= maxOffset) {
    const dayIso = addDaysIso(todayIso, -offset);
    const submitters = getSubmittersForDate(headers, rows, dayIso);
    if (submitters.size > 0) {
      workingDaysSeen++;
      for (const c of submitters) activeRecent.add(c);
    }
    offset++;
  }

  // Only mark inactive if they have ANY submission history.
  // Companies with zero history are handled separately as "no_history".
  const everSubmitted = new Set();
  for (const row of rows) {
    if (!row || !row[companyIdx]) continue;
    const matched = resolveSheetCompanyToExpected(String(row[companyIdx]).trim(), EXPECTED_COMPANIES);
    if (matched) everSubmitted.add(matched);
  }

  return new Set(EXPECTED_COMPANIES.filter((c) => everSubmitted.has(c) && !activeRecent.has(c)));
}

/**
 * Find which expected companies have NOT submitted a manpower report for the given date.
 *
 * @param {Array} manpowerData - Raw sheet data (first row is headers, rest is data rows)
 * @param {string} searchDateIso - Date in YYYY-MM-DD format
 * @returns {{ missing: string[], submitted: string[], unknown: string[] }}
 */
function findMissingCompanies(manpowerData, searchDateIso) {
  const submittedCompanies = new Set();
  const unknownCompanies = [];

  if (!manpowerData || manpowerData.length <= 1) {
    // No data at all — all companies are missing
    return {
      missing: [...EXPECTED_COMPANIES],
      submitted: [],
      unknown: [],
    };
  }

  const headers = manpowerData[0];
  const rows = manpowerData.slice(1);

  // Find column indices
  const dateIdx = headers.findIndex((h) => h === "Date");
  const companyIdx = headers.findIndex((h) => h === "Company");

  if (dateIdx === -1 || companyIdx === -1) {
    console.error("[MANPOWER REMINDER] Required columns (Date, Company) not found in sheet");
    return {
      missing: [...EXPECTED_COMPANIES],
      submitted: [],
      unknown: [],
    };
  }

  // Filter rows for the target date and resolve company names
  for (const row of rows) {
    if (!row || !row[dateIdx]) continue;

    const rowDate = String(row[dateIdx]).trim();
    if (rowDate !== searchDateIso) continue;

    const rawCompany = row[companyIdx];
    if (!rawCompany) continue;

    const matched = resolveSheetCompanyToExpected(String(rawCompany).trim(), EXPECTED_COMPANIES);
    if (matched) {
      submittedCompanies.add(matched);
    } else {
      unknownCompanies.push(String(rawCompany).trim());
    }
  }

  const missing = EXPECTED_COMPANIES.filter((c) => !submittedCompanies.has(c));

  return {
    missing,
    submitted: [...submittedCompanies],
    unknown: [...new Set(unknownCompanies)],
  };
}

/**
 * Build the reminder message for WhatsApp.
 * @param {string} searchDate - DD-MMM-YYYY
 * @param {string[]} missingCompanies - Companies that haven't submitted
 * @returns {string} Formatted WhatsApp message
 */
function buildReminderMessage(searchDate, missingCompanies) {
  if (missingCompanies.length === 0) {
    return [`*All companies have submitted their manpower report for ${searchDate}.*`].join("\n");
  }

  const lines = [];
  lines.push(`*Manpower Report Reminder*`);
  lines.push(`${searchDate}`);
  lines.push(``);
  lines.push(`The following companies have not submitted their manpower report today:`);
  lines.push(``);

  missingCompanies.forEach((company, idx) => {
    lines.push(`${idx + 1}. ${company}`);
  });

  lines.push(``);
  lines.push(`Please submit your report as soon as possible.`);

  return lines.join("\n");
}

// =============================================================================
// Targeted reminder helpers
// =============================================================================

/**
 * Build a lookup index from sheet history: expectedCompanyName → { groupChatName, senderJson }
 * Uses the most recent submission per company (later rows overwrite earlier ones).
 */
function buildCompanyContactIndex(manpowerData) {
  const index = new Map();

  if (!manpowerData || manpowerData.length <= 1) return index;

  const headers = manpowerData[0];
  const rows = manpowerData.slice(1);

  const companyIdx = headers.findIndex((h) => h === "Company");
  const groupIdx = headers.findIndex((h) => h === "Group");
  const senderIdx = headers.findIndex((h) => h === "Sender");

  if (companyIdx === -1 || groupIdx === -1 || senderIdx === -1) {
    console.error("[MANPOWER REMINDER] Required columns (Company, Group, Sender) not found for contact index");
    return index;
  }

  for (const row of rows) {
    if (!row || !row[companyIdx]) continue;

    const rawCompany = String(row[companyIdx]).trim();
    const matched = resolveSheetCompanyToExpected(rawCompany, EXPECTED_COMPANIES);
    if (!matched) continue;

    const groupChatName = row[groupIdx] ? String(row[groupIdx]).trim() : null;
    const senderJson = row[senderIdx] ? String(row[senderIdx]).trim() : null;

    if (groupChatName) {
      index.set(matched, { groupChatName, senderJson });
    }
  }

  return index;
}

/**
 * Extract phone number from Sender JSON string.
 * @param {string} senderJsonString - JSON string from Sender column
 * @returns {string|null} Phone number digits (e.g., "6591234567") or null
 */
function extractPhoneNumber(senderJsonString) {
  if (!senderJsonString) return null;
  try {
    const parsed = JSON.parse(senderJsonString);
    if (parsed.phoneNumber && /^\d+$/.test(parsed.phoneNumber)) return parsed.phoneNumber;
    if (parsed.from) return parsed.from.replace(/@.*$/, "");
    return null;
  } catch {
    return null;
  }
}

/**
 * Query Supabase whatsapp_listener to resolve a chatName → WhatsApp group ID (from).
 * @param {string} groupChatName - The WhatsApp group name
 * @returns {Promise<string|null>} The group's "from" value (e.g., "120363xxx@g.us") or null
 */
async function resolveGroupChatId(groupChatName) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("whatsapp_listener")
    .select("from")
    .eq("chatName", groupChatName)
    .eq("isGroup", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[MANPOWER REMINDER] Supabase lookup failed for chatName "${groupChatName}":`, error.message);
    return null;
  }
  return data?.from || null;
}

/**
 * Build a grouped reminder message for multiple companies going to the same group chat.
 * Tags all relevant people and lists all missing companies in one message.
 * @param {string} searchDate - DD-MMM-YYYY
 * @param {Array<{company: string, phoneNumber: string|null}>} entries - Companies + their contacts
 * @returns {string} Formatted WhatsApp message
 */
function buildGroupedReminderMessage(searchDate, entries) {
  const mentions = entries
    .filter((e) => e.phoneNumber)
    .map((e) => `@${e.phoneNumber}`)
    .join(" ");

  const lines = [];
  lines.push(`*Manpower Report Reminder*`);
  lines.push(`${searchDate}`);
  lines.push(``);

  if (entries.length === 1) {
    // Single company — direct message
    const mention = entries[0].phoneNumber ? `@${entries[0].phoneNumber} ` : "";
    lines.push(`${mention}Kindly submit the manpower report for *${entries[0].company}* as soon as possible.`);
  } else {
    // Multiple companies — list them
    if (mentions) lines.push(mentions);
    lines.push(`Kindly submit the manpower report for the following as soon as possible:`);
    lines.push(``);
    entries.forEach((e, idx) => {
      lines.push(`${idx + 1}. *${e.company}*`);
    });
  }

  lines.push(``);
  lines.push(`Thank you.`);

  return lines.join("\n");
}

/**
 * Process manpower reminder request
 * @param {object} event - Lambda event
 * @param {object} res - Response helper { status(code).json(body) }
 */
async function processManpowerReminderRequest(event, res) {
  try {
    let body = {};
    try {
      if (event.body) body = JSON.parse(event.body);
    } catch (e) {
      console.warn("[MANPOWER REMINDER] Failed to parse request body:", e.message);
    }

    const {
      date: dateParam,
      groupIds,
      groupId,
      dryRun = false,
      inactiveLookbackDays = DEFAULT_INACTIVE_LOOKBACK_DAYS,
    } = body;
    console.log("[MANPOWER REMINDER] Request:", { date: dateParam, groupIds, groupId, dryRun, inactiveLookbackDays });

    // Resolve recipient list (now optional — empty means targeted mode)
    const recipientIds =
      groupIds && Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : groupId ? [groupId] : [];

    const isTargetedMode = recipientIds.length === 0;
    console.log(`[MANPOWER REMINDER] Mode: ${isTargetedMode ? "targeted" : "legacy"}`);

    // Parse + validate date
    const searchDate = parseDate(dateParam);
    const searchDateIso = toIsoDate(searchDate);
    console.log(`[MANPOWER REMINDER] Search date: ${searchDate} (ISO: ${searchDateIso})`);

    // Load manpower data from sheet
    const manpowerConfig = getSpreadsheetConfig("manpower");
    if (!manpowerConfig?.spreadsheetId) {
      return res.status(400).json({
        success: false,
        error: "No manpower spreadsheet configured",
      });
    }

    console.log(`[MANPOWER REMINDER] Loading Manpower sheet from ${manpowerConfig.spreadsheetId}`);
    const manpowerData = await loadData(manpowerConfig.sheetName || "Manpower", {
      spreadsheetId: manpowerConfig.spreadsheetId,
    });

    // Find missing companies
    const { missing: rawMissing, submitted, unknown } = findMissingCompanies(manpowerData, searchDateIso);

    // Filter out companies considered "finished" — silent for the last
    // `inactiveLookbackDays` working days. They keep their history but no
    // longer get pestered.
    const inactiveSet = findInactiveCompanies(manpowerData, searchDateIso, inactiveLookbackDays);
    const inactiveSkipped = rawMissing.filter((c) => inactiveSet.has(c));
    const missing = rawMissing.filter((c) => !inactiveSet.has(c));

    console.log(
      `[MANPOWER REMINDER] Submitted: ${submitted.length}, Missing: ${missing.length}, Inactive-skipped: ${inactiveSkipped.length}, Unknown: ${unknown.length}`,
    );
    if (inactiveSkipped.length > 0) {
      console.log(
        `[MANPOWER REMINDER] Skipping inactive (no submission in last ${inactiveLookbackDays} working days): ${inactiveSkipped.join(", ")}`,
      );
    }
    if (unknown.length > 0) {
      console.warn(`[MANPOWER REMINDER] Unknown companies in sheet: ${unknown.join(", ")}`);
    }

    const sendResults = [];

    if (missing.length === 0) {
      console.log(`[MANPOWER REMINDER] All companies submitted — no reminder needed`);
    } else if (isTargetedMode) {
      // ── Targeted mode: group missing companies by chat, send one message per group ──
      const contactIndex = buildCompanyContactIndex(manpowerData);
      console.log(`[MANPOWER REMINDER] Contact index built with ${contactIndex.size} companies`);

      // Group missing companies by chatName
      const groupedByChat = new Map(); // chatName → { companies: [{company, phoneNumber}] }

      for (const company of missing) {
        const contact = contactIndex.get(company);

        if (!contact) {
          console.warn(`[MANPOWER REMINDER] No submission history for "${company}" — skipping`);
          sendResults.push({ company, sent: false, reason: "no_history" });
          continue;
        }

        const phoneNumber = extractPhoneNumber(contact.senderJson);
        const chatName = contact.groupChatName;

        if (!groupedByChat.has(chatName)) {
          groupedByChat.set(chatName, { entries: [] });
        }
        groupedByChat.get(chatName).entries.push({ company, phoneNumber });
      }

      console.log(`[MANPOWER REMINDER] ${groupedByChat.size} unique group(s) to notify`);

      // Resolve each group's chatId and send one message per group
      for (const [chatName, group] of groupedByChat) {
        let groupChatId;
        try {
          groupChatId = await resolveGroupChatId(chatName);
        } catch (err) {
          console.error(`[MANPOWER REMINDER] Supabase error for chatName "${chatName}":`, err.message);
          for (const entry of group.entries) {
            sendResults.push({
              company: entry.company,
              sent: false,
              reason: "supabase_error",
              chatName,
              error: err.message,
            });
          }
          continue;
        }

        if (!groupChatId) {
          console.warn(`[MANPOWER REMINDER] Group not found in Supabase for chatName "${chatName}" — skipping`);
          for (const entry of group.entries) {
            sendResults.push({ company: entry.company, sent: false, reason: "group_not_found", chatName });
          }
          continue;
        }

        const message = buildGroupedReminderMessage(searchDate, group.entries);
        const companyNames = group.entries.map((e) => e.company);
        const phoneNumbers = group.entries.filter((e) => e.phoneNumber).map((e) => e.phoneNumber);

        if (!dryRun) {
          try {
            console.log(
              `[MANPOWER REMINDER] Sending grouped reminder to ${groupChatId} for [${companyNames.join(", ")}] (mentions: ${phoneNumbers.join(", ") || "none"})`,
            );
            await sendWhatsAppMessageWithMentions(groupChatId, message);
            for (const entry of group.entries) {
              sendResults.push({
                company: entry.company,
                sent: true,
                chatId: groupChatId,
                chatName,
                phoneNumber: entry.phoneNumber,
              });
            }
            console.log(`[MANPOWER REMINDER] Sent to ${groupChatId}`);
          } catch (sendErr) {
            console.error(`[MANPOWER REMINDER] Failed to send to ${groupChatId}:`, sendErr.message);
            for (const entry of group.entries) {
              sendResults.push({
                company: entry.company,
                sent: false,
                chatId: groupChatId,
                chatName,
                error: sendErr.message,
              });
            }
          }
        } else {
          for (const entry of group.entries) {
            sendResults.push({
              company: entry.company,
              sent: false,
              dryRun: true,
              chatId: groupChatId,
              chatName,
              phoneNumber: entry.phoneNumber,
              message,
            });
          }
        }
      }
    } else {
      // ── Legacy mode: send bulk message to specified group(s) ──
      const message = buildReminderMessage(searchDate, missing);

      if (!dryRun) {
        for (const gid of recipientIds) {
          try {
            console.log(`[MANPOWER REMINDER] Sending message to ${gid}`);
            await sendWhatsAppMessage(gid, message);
            sendResults.push({ groupId: gid, sent: true });
            console.log(`[MANPOWER REMINDER] Sent to ${gid}`);
          } catch (sendErr) {
            console.error(`[MANPOWER REMINDER] Failed to send to ${gid}:`, sendErr.message);
            sendResults.push({ groupId: gid, sent: false, error: sendErr.message });
          }
        }
      } else {
        console.log(`[MANPOWER REMINDER] Dry run — message not sent`);
        sendResults.push({ dryRun: true, message });
      }
    }

    return res.status(200).json({
      success: true,
      date: searchDate,
      mode: isTargetedMode ? "targeted" : "legacy",
      totalRecords: submitted.length + unknown.length,
      submittedCompanies: submitted,
      missingCompanies: missing,
      inactiveSkipped,
      inactiveLookbackDays,
      unknownCompanies: unknown,
      sent: sendResults.some((r) => r.sent),
      sendResults,
    });
  } catch (error) {
    console.error("[MANPOWER REMINDER] Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process manpower reminder request",
    });
  }
}

module.exports = processManpowerReminderRequest;

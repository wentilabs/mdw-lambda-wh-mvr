const { getOpenAI } = require("./openai");

// Function to convert Google Sheets date serial number to JavaScript Date
const convertSerialToDate = (serial) => {
  const baseDate = new Date(Date.UTC(1899, 11, 30)); // December 30, 1899
  const output = new Date(baseDate.getTime() + serial * 24 * 60 * 60 * 1000);
  return output.toISOString().split("T")[0];
};

const formatDate = (date) => {
  return date.toISOString().split("T")[0];
};

const convertSerialToTime = (serial) => {
  const totalMinutes = serial * 24 * 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  const seconds = Math.round((totalMinutes % 1) * 60);

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
};

const convertSerialToDateTime = (serial) => {
  const baseDate = new Date(Date.UTC(1899, 11, 30));
  const output = new Date(baseDate.getTime() + serial * 24 * 60 * 60 * 1000);
  // Format: YYYY-MM-DD HH:mm:ss
  const pad = (n) => n.toString().padStart(2, "0");
  return `${output.getFullYear()}-${pad(output.getMonth() + 1)}-${pad(output.getDate())} ${pad(
    output.getHours(),
  )}:${pad(output.getMinutes())}:${pad(output.getSeconds())}`;
};

const formatDateTimeForSheet = (date) => {
  // Format date in Singapore time zone
  const options = {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  // Example: "29 May 25, 5:45 PM"
  const sgString = date.toLocaleString("en-SG", options);

  // Split and reformat
  const [datePart, timePart] = sgString.split(", ");
  const [day, month, year] = datePart.split(" ");
  let [time, ampm] = timePart.split(" ");
  time = time.replace(":", "."); // "5.45"
  return `${day}-${month}-${year}, ${time}${ampm}`;
};

/**
 * Format a timestamp into a consistent human-readable format using Singapore timezone (dd-mmm-yyyy HH:MM)
 * This function ensures that all timestamps across the application have a consistent
 * format and handles error cases gracefully.
 *
 * @param {string} timestamp - An ISO timestamp string or any parseable date string
 * @param {object} options - Optional formatting options
 * @param {boolean} options.includeSeconds - Whether to include seconds in the output (default: false)
 * @param {boolean} options.useUTC - Whether to use UTC time instead of Singapore timezone (default: false)
 * @returns {string} Formatted timestamp or empty string if invalid
 */
const formatHumanReadableTimestamp = (timestamp, options = {}) => {
  if (!timestamp) return "";

  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      console.log(`Invalid timestamp format: ${timestamp}`);
      return "";
    }

    // Don't use timezone conversion for human-readable timestamps when displaying SGT times
    // These times have already been adjusted during initial processing
    const dateFormatOptions = {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: "Asia/Singapore",
    };

    const timeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Singapore",
    };

    if (options.includeSeconds) {
      timeFormatOptions.second = "2-digit";
    }

    // Use British English locale for dd-mmm-yyyy format with Singapore timezone
    const dateStr = date.toLocaleDateString("en-GB", dateFormatOptions).replace(/\s/g, "-");

    const timeStr = date.toLocaleTimeString("en-GB", timeFormatOptions);
    return `${dateStr} ${timeStr}`;
  } catch (error) {
    console.error("Error formatting timestamp:", error.message);
    return "";
  }
};

/**
 * Convert a timestamp to Singapore timezone formatted string
 * @param {string|number|Date} timestamp - Timestamp to convert
 * @param {Object} options - Format options
 * @param {string} options.format - Format type ('iso', 'human', 'locale' [default])
 * @returns {string} Singapore timezone formatted datetime
 */
const convertToSingaporeTime = (timestamp, options = {}) => {
  try {
    // First create a date object from the input timestamp
    let date;

    // Handle unix timestamps (number or numeric string)
    if (typeof timestamp === "number" || (typeof timestamp === "string" && /^\d{10,13}$/.test(timestamp))) {
      const unixTimestamp = typeof timestamp === "number" ? timestamp : parseInt(timestamp, 10);

      // Unix timestamps are typically 10 digits for seconds
      const milliseconds = unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
      date = new Date(milliseconds);
    } else if (timestamp instanceof Date) {
      date = timestamp;
    } else {
      date = new Date(timestamp);
    }

    if (isNaN(date.getTime())) {
      console.error(`Invalid timestamp format for Singapore conversion: ${timestamp}`);
      return new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" });
    }

    // Determine output format
    const format = options.format || "locale";

    if (format === "iso") {
      // For ISO format with Singapore timezone adjustment
      const sgOptions = { timeZone: "Asia/Singapore" };
      const sgYear = date.toLocaleString("en-US", { ...sgOptions, year: "numeric" });
      const sgMonth = date.toLocaleString("en-US", { ...sgOptions, month: "2-digit" });
      const sgDay = date.toLocaleString("en-US", { ...sgOptions, day: "2-digit" });
      const sgHour = date.toLocaleString("en-US", { ...sgOptions, hour: "2-digit", hour12: false });
      const sgMinute = date.toLocaleString("en-US", { ...sgOptions, minute: "2-digit" });
      const sgSecond = date.toLocaleString("en-US", { ...sgOptions, second: "2-digit" });

      return `${sgYear}-${sgMonth}-${sgDay}T${sgHour}:${sgMinute}:${sgSecond}+08:00`;
    } else if (format === "human") {
      // Use our human readable timestamp function with Singapore timezone
      return formatHumanReadableTimestamp(date);
    } else {
      // Default locale format (M/D/YYYY, h:mm:ss AM/PM)
      return date.toLocaleString("en-US", { timeZone: "Asia/Singapore" });
    }
  } catch (error) {
    console.error("Error converting to Singapore timezone:", error.message);
    return new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" });
  }
};

/**
 * Check if two dates are in different months
 * @param {string|Date} lastItemDate - Date from last sheet item (YYYY-MM-DD format or Date object)
 * @param {string|Date} currentDate - Current date to compare (YYYY-MM-DD format or Date object)
 * @returns {boolean} - true if dates are in different months
 */
const checkIfNewMonth = (lastItemDate, currentDate) => {
  try {
    // Parse dates
    const lastDate = typeof lastItemDate === "string" ? new Date(lastItemDate) : lastItemDate;
    const currDate = typeof currentDate === "string" ? new Date(currentDate) : currentDate;

    // Check if parsing was successful
    if (isNaN(lastDate.getTime()) || isNaN(currDate.getTime())) {
      console.error("Invalid date provided to checkIfNewMonth:", { lastItemDate, currentDate });
      return false;
    }

    // Compare year and month
    const lastMonth = lastDate.getMonth();
    const lastYear = lastDate.getFullYear();
    const currMonth = currDate.getMonth();
    const currYear = currDate.getFullYear();

    return lastYear !== currYear || lastMonth !== currMonth;
  } catch (error) {
    console.error("Error in checkIfNewMonth:", error.message);
    return false;
  }
};

/**
 * Format sheet archive name from date
 * @param {string|Date} date - Date to format (YYYY-MM-DD format or Date object)
 * @returns {string} - Formatted as "Safety-Jan 2026" or "Safety-Dec 2025"
 */
const formatSheetArchiveName = (date) => {
  try {
    const dateObj = typeof date === "string" ? new Date(date) : date;

    if (isNaN(dateObj.getTime())) {
      console.error("Invalid date provided to formatSheetArchiveName:", date);
      return "Safety-Unknown";
    }

    // Get month name (short form: Jan, Feb, Mar, etc.)
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = monthNames[dateObj.getMonth()];
    const year = dateObj.getFullYear();

    return `Safety-${month} ${year}`;
  } catch (error) {
    console.error("Error in formatSheetArchiveName:", error.message);
    return "Safety-Unknown";
  }
};

/**
 * Format monthly WBGT monitoring sheet name from date
 * @param {string|Date} date - Date to format
 * @returns {string} - Formatted as "Nov-2025" or "Dec-2025"
 */
const formatMonthlySheetName = (date) => {
  try {
    const dateObj = typeof date === "string" ? new Date(date) : date;
    if (isNaN(dateObj.getTime())) {
      console.error("Invalid date provided to formatMonthlySheetName:", date);
      return "Unknown-2025";
    }
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = monthNames[dateObj.getMonth()];
    const year = dateObj.getFullYear();
    return `${month}-${year}`; // Hyphen, not space
  } catch (error) {
    console.error("Error in formatMonthlySheetName:", error.message);
    return "Unknown-2025";
  }
};

/**
 * Round timestamp to nearest hour in Singapore timezone
 * @param {string|Date} timestamp - Timestamp to round
 * @returns {number} - Hour (0-23) or -1 if invalid
 */
const roundToNearestHour = (timestamp) => {
  try {
    // Create date object
    let date;
    if (typeof timestamp === "number") {
      const milliseconds = timestamp < 10000000000 ? timestamp * 1000 : timestamp;
      date = new Date(milliseconds);
    } else if (timestamp instanceof Date) {
      date = timestamp;
    } else {
      date = new Date(timestamp);
    }

    if (isNaN(date.getTime())) {
      console.error("Invalid timestamp for roundToNearestHour:", timestamp);
      return -1;
    }

    // Get hour and minute in Singapore timezone
    const sgOptions = { timeZone: "Asia/Singapore", hour12: false };
    const hourStr = date.toLocaleString("en-US", { ...sgOptions, hour: "2-digit" });
    const minuteStr = date.toLocaleString("en-US", { ...sgOptions, minute: "2-digit" });

    const hour = parseInt(hourStr, 10);
    const minutes = parseInt(minuteStr, 10);

    if (isNaN(hour) || isNaN(minutes)) {
      console.error("Failed to parse hour/minute from Singapore timezone");
      return -1;
    }

    // Round to nearest: 0-29 minutes stays, 30-59 minutes rounds up
    return minutes >= 30 ? (hour + 1) % 24 : hour;
  } catch (error) {
    console.error("Error in roundToNearestHour:", error.message);
    return -1;
  }
};

/**
 * Check if timestamp is within WBGT tracking hours (08:00-17:59, skip 12:00)
 * @param {string|Date} timestamp - Timestamp to check
 * @returns {boolean} - True if within tracking hours
 */
const isWithinTrackingHours = (timestamp) => {
  try {
    const hour = roundToNearestHour(timestamp);
    if (hour === -1) return false;
    // Valid: 8-17, skip 12
    return hour >= 8 && hour <= 17 && hour !== 12;
  } catch (error) {
    console.error("Error in isWithinTrackingHours:", error.message);
    return false;
  }
};

/**
 * Month-name → 0-indexed month number lookup. Covers full names, common
 * abbreviations ("Sept"), and the standard 3-letter prefix.
 */
const _MONTH_NAMES = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const _DOW_RE =
  /\b(?:Mon(?:day)?|Tue(?:s|sday)?|Wed(?:nesday)?|Thu(?:rs|rsday|r)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b\.?/gi;
const _WEATHER_RE = /\b(?:Sunny|Cloudy|Rainy|Hazy|Clear|Stormy|Foggy|Snowy|Windy|Hot|Cold)\b|\d+\s*°[CF]?|°[CF]/gi;
const _TZ_OFFSET_RE = /\b(?:GMT|UTC|SGT)\s*[+\-]\d{1,2}:?\d{0,2}\b/gi;
const _TZ_BARE_RE = /\b(?:GMT|UTC|SGT)\b/gi;
const _CONNECTOR_RE = /\b(?:at|on)\b/gi;
const _ORDINAL_RE = /(\d+)(?:st|nd|rd|th)\b/gi;
const _NON_DATE_PUNCT_RE = /[,;]+/g;
const _ADDRESS_NOISE_RE =
  /\b(?:Singapore|Avenue|Ave|Road|Rd|Street|St|Drive|Dr|Crescent|Cres|Way|Lane|Ln|Boulevard|Blvd|Park)\b/gi;

const _isValidDateParts = (year, monthZero, day) => {
  if (year < 2000 || year > 2100) return false;
  if (monthZero < 0 || monthZero > 11) return false;
  if (day < 1 || day > 31) return false;
  return true;
};

const _normalizeYear = (yRaw) => {
  const n = parseInt(yRaw, 10);
  return yRaw.length === 2 ? 2000 + n : n;
};

/**
 * Pull (year, monthZero, day) out of a chunk of text. Tries every common
 * date shape — ISO, DD MonthName YYYY, MonthName DD YYYY, DD/MonthAbbr/YYYY,
 * DD/MM/YYYY (Singapore), YYYYMMDD compact — and returns the first match.
 */
const _extractDateParts = (text) => {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD  (year first, with separators)
  let m = t.match(/(\d{4})[\-\/.](\d{1,2})[\-\/.](\d{1,2})/);
  if (m) {
    const year = parseInt(m[1], 10);
    const monthZero = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    if (_isValidDateParts(year, monthZero, day)) return { year, monthZero, day };
  }

  // DD MonthName YYYY  (e.g. "27 Apr 2026", "5 May 2026", "27 April 2026", "27 Apr 26")
  m = t.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})/);
  if (m) {
    const monthZero = _MONTH_NAMES[m[2].toLowerCase()];
    if (monthZero !== undefined) {
      const day = parseInt(m[1], 10);
      const year = _normalizeYear(m[3]);
      if (_isValidDateParts(year, monthZero, day)) return { year, monthZero, day };
    }
  }

  // MonthName DD YYYY  (US: "Apr 4 2026", "May 5 2026")
  m = t.match(/([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{2,4})/);
  if (m) {
    const monthZero = _MONTH_NAMES[m[1].toLowerCase()];
    if (monthZero !== undefined) {
      const day = parseInt(m[2], 10);
      const year = _normalizeYear(m[3]);
      if (_isValidDateParts(year, monthZero, day)) return { year, monthZero, day };
    }
  }

  // DD/MonthAbbr/YYYY  (e.g. "27/Apr/2026", "27-Apr-2026")
  m = t.match(/(\d{1,2})[\/\-]([A-Za-z]{3,9})[\/\-](\d{2,4})/);
  if (m) {
    const monthZero = _MONTH_NAMES[m[2].toLowerCase()];
    if (monthZero !== undefined) {
      const day = parseInt(m[1], 10);
      const year = _normalizeYear(m[3]);
      if (_isValidDateParts(year, monthZero, day)) return { year, monthZero, day };
    }
  }

  // DD/MM/YYYY (Singapore convention) — also DD-MM-YYYY, DD.MM.YYYY, DD/MM/YY
  m = t.match(/(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthZero = parseInt(m[2], 10) - 1;
    const year = _normalizeYear(m[3]);
    if (_isValidDateParts(year, monthZero, day)) return { year, monthZero, day };
  }

  // YYYYMMDD compact (no separators)
  m = t.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (m) {
    const year = parseInt(m[1], 10);
    const monthZero = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    if (_isValidDateParts(year, monthZero, day)) return { year, monthZero, day };
  }

  return null;
};

/**
 * Parse a free-form camera-overlay timestamp string into a JS Date.
 *
 * Accepts ANY shape that contains a recognizable TIME (HH:MM[:SS][AM/PM]) and
 * a recognizable DATE component. Day-of-week names ("Mon"/"Monday"/...),
 * weather words ("Sunny"/"28°C"), GMT/UTC/SGT offset markers, address
 * suffixes ("Singapore"/"Bayfront Ave"/...) and decorative ordinals ("5th")
 * are all stripped before extraction. The returned Date represents the
 * wall-clock as Singapore time (UTC+8) — the input is ALWAYS treated as SGT
 * and never shifted away from it.
 *
 * Returns null if either the time OR the date component is missing.
 *
 * @param {string} timestampText
 * @returns {Date|null}
 */
const parseTimestampFromText = (timestampText) => {
  if (!timestampText || typeof timestampText !== "string") return null;
  const trimmed = timestampText.trim();
  if (!trimmed) return null;

  try {
    // ── Fast path: already-ISO 8601 (with or without TZ) ──────────────
    const isoMatch = trimmed.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?(Z|[+\-]\d{2}:?\d{2})?$/i,
    );
    if (isoMatch) {
      const [, y, mo, d, h, mi, se, tzRaw] = isoMatch;
      let tz = "+08:00";
      if (tzRaw) {
        if (/^z$/i.test(tzRaw)) tz = "Z";
        else if (/^[+\-]\d{4}$/.test(tzRaw)) tz = tzRaw.slice(0, 3) + ":" + tzRaw.slice(3);
        else tz = tzRaw;
      }
      const iso =
        `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` +
        `T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${se ? String(se).padStart(2, "0") : "00"}${tz}`;
      const date = new Date(iso);
      if (!isNaN(date.getTime())) return date;
    }

    // ── Strip noise that confuses pattern matching ────────────────────
    const cleaned = trimmed
      .replace(_DOW_RE, " ")
      .replace(_WEATHER_RE, " ")
      .replace(_TZ_OFFSET_RE, " ")
      .replace(_TZ_BARE_RE, " ")
      .replace(_ADDRESS_NOISE_RE, " ")
      .replace(_CONNECTOR_RE, " ")
      .replace(_ORDINAL_RE, "$1")
      .replace(_NON_DATE_PUNCT_RE, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) {
      console.log(`Unable to parse timestamp from text: ${timestampText}`);
      return null;
    }

    // ── Extract TIME (HH:MM[:SS][ AM/PM]) ──────────────────────────────
    const tm = cleaned.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/);
    if (!tm) {
      console.log(`Unable to parse timestamp from text: ${timestampText}`);
      return null;
    }
    let hour = parseInt(tm[1], 10);
    const minute = parseInt(tm[2], 10);
    const second = tm[3] ? parseInt(tm[3], 10) : 0;
    const ampm = tm[4]?.toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      console.log(`Unable to parse timestamp from text: ${timestampText}`);
      return null;
    }

    // ── Extract DATE from the remainder ────────────────────────────────
    const rest = (cleaned.slice(0, tm.index) + " " + cleaned.slice(tm.index + tm[0].length))
      .replace(/\s+/g, " ")
      .trim();
    const dp = _extractDateParts(rest);
    if (!dp) {
      console.log(`Unable to parse timestamp from text: ${timestampText}`);
      return null;
    }

    // ── Combine into SGT-anchored ISO and return ───────────────────────
    const iso =
      `${dp.year}-${String(dp.monthZero + 1).padStart(2, "0")}-${String(dp.day).padStart(2, "0")}` +
      `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`;
    const date = new Date(iso);
    if (!isNaN(date.getTime())) return date;

    console.log(`Unable to parse timestamp from text: ${timestampText}`);
    return null;
  } catch (error) {
    console.error("Error parsing timestamp from text:", error.message);
    return null;
  }
};

/**
 * Extract timestamp from image using OpenAI Vision
 * Looks for visible timestamps/dates in the image (e.g., from camera metadata overlay)
 *
 * @param {string} imageUrl - URL of the image to analyze
 * @returns {Promise<Date|null>} Date object if timestamp found, null otherwise
 */
const extractTimestampFromImage = async (imageUrl) => {
  if (!imageUrl) return null;

  try {
    console.log(`Attempting to extract timestamp from image: ${imageUrl}`);

    // Inline retry for OpenAI calls
    let lastError;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const response = await getOpenAI().chat.completions.create({
          model: "gpt-4.1",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `You are a timestamp extraction specialist. Your task is to find and extract date/time information embedded in construction site images.

## WHERE TO LOOK FOR TIMESTAMPS

Timestamps are typically found in these locations:
1. **Camera Overlays (Most Common)** - Text burned into the image by the camera, usually at the top or bottom
2. **Screenshot Metadata** - Date/time shown when someone takes a screenshot
3. **Photo App Overlays** - Timestamps added by photo editing or gallery apps

## TIMESTAMP FORMATS TO RECOGNIZE

**Common Formats:**
- "3 Nov 2025 at 10:41:37 AM"
- "03 Nov 2025 10:41:37"
- "2025-11-03 10:41:37" (ISO format)
- "03/11/2025 10:41 AM"
- "3-Nov-2025 10:41"
- "2025/11/03 10:41:37"

**Camera Brand Examples:**
- Hikvision: "2025-11-03 10:41:37"
- Dahua: "03/11/2025 10:41:37 AM"
- Generic cameras: "3 Nov 2025 at 10:41:37 AM"
- Timemark/SitePics: "08:00 Sat 04 Apr 2026" or "08:00 04 Apr 2026"
- US camera overlay: "Apr 4, 2026 4:50:16 PM"

## WHAT TO EXTRACT

1. **PRIORITY**: Look for the MOST COMPLETE timestamp (with date AND time)
2. If multiple timestamps exist, choose the camera overlay timestamp
3. Extract the EXACT text as it appears - don't reformat or translate
4. Include all components: day, month, year, hour, minute, second (if present), AM/PM (if present)

## WHAT TO IGNORE

- Pure time without date: "10:41 AM" (no date component)
- Partial dates: "Nov 2025" (no specific day or time)
- Duration counters: "00:30:15" (video duration, not timestamp)

## CRITICAL: CAMERA OVERLAY TIMESTAMPS ONLY

You MUST extract ONLY camera overlay timestamps - timestamps burned into the photo by the camera device.

**VALID camera overlay timestamps:**
- White/yellow/orange text at top or bottom edge of image
- Semi-transparent text overlaid on photo
- Positioned in corners or edges (typical camera placement)
- **Timemark / SitePics / construction site photo apps** — these stamp verified date+time+location on the photo. They typically show a branded overlay with time, date, address, and weather. These are TRUSTED timestamps — extract them. Look for formats like "08:00 Sat 04 Apr 2026" or similar with the app branding visible.

**REJECT these sources (return "NO_TIMESTAMP"):**
1. **WhatsApp UI timestamps** - Time shown in chat bubbles
2. **Screenshot text** - Text that someone typed in a message
3. **Status bar time** - Mobile device time at top of screenshot
4. **Message content** - Dates mentioned in WhatsApp conversation text

**CRITICAL DETECTION RULES:**
- If image shows WhatsApp UI elements (green chat bubbles, conversation threads) -> Return "NO_TIMESTAMP"
- If image shows mobile UI (battery icon, signal bars, notification bar) -> Return "NO_TIMESTAMP"
- If timestamp appears inside a chat bubble or message area -> Return "NO_TIMESTAMP"
- Construction photo app stamps (Timemark, SitePics, etc.) with date+time+location ARE VALID — extract them
- If unsure whether timestamp is camera overlay or screenshot text -> Return "NO_TIMESTAMP"

**It is BETTER to return "NO_TIMESTAMP" than extract a timestamp from screenshot text or message content.**

## CRITICAL FORMATTING RULES

1. **NO DOTS/PERIODS IN MONTH NAMES** - Extract "Nov" NOT "Nov."
2. **NO EXTRA PUNCTUATION** - Extract "3 Nov 2025" NOT "3 Nov. 2025"
3. **CLEAN TEXT ONLY** - Remove any decorative punctuation

Return ONLY one of these:
- The exact timestamp text (e.g., "3 Nov 2025 at 10:41:37 AM")
- "NO_TIMESTAMP" (if no timestamp with both date and time is found)

Now examine this construction site image and extract any timestamp:`,
                },
                {
                  type: "image_url",
                  image_url: { url: imageUrl },
                },
              ],
            },
          ],
          max_tokens: 150,
          temperature: 0,
        });

        const extractedText = response.choices[0]?.message?.content?.trim();

        if (!extractedText || extractedText === "NO_TIMESTAMP" || extractedText.includes("NO_TIMESTAMP")) {
          console.log("No timestamp found in image");
          return null;
        }

        console.log(`Extracted timestamp text from image (raw): ${extractedText}`);

        // Clean up: remove dots and commas after month names
        const cleanedText = extractedText
          .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.+\s/gi, "$1 ")
          .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec),+\s/gi, "$1 ");

        if (cleanedText !== extractedText) {
          console.log(`Cleaned timestamp text: ${cleanedText}`);
        }

        const parsedDate = parseTimestampFromText(cleanedText);

        if (parsedDate) {
          console.log(`Successfully parsed image timestamp: ${formatHumanReadableTimestamp(parsedDate)}`);
          return parsedDate;
        }

        console.log("Failed to parse extracted timestamp text");
        return null;
      } catch (error) {
        lastError = error;
        const status = error?.status || error?.response?.status;
        const isRetryable =
          status === 429 ||
          (status >= 500 && status < 600) ||
          error.code === "ECONNRESET" ||
          error.code === "ETIMEDOUT" ||
          (status === 400 && error.message?.includes("Timeout while downloading"));

        if (isRetryable && attempt < 2) {
          const delay = 2000 * Math.pow(2, attempt) + Math.random() * 1000;
          console.log(
            `[extractTimestampFromImage] Retry ${attempt + 1}/2 after ${Math.round(delay)}ms: ${error.message}`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  } catch (error) {
    console.error("Error extracting timestamp from image:", error.message);
    return null;
  }
};

module.exports = {
  convertSerialToDate,
  convertSerialToTime,
  convertSerialToDateTime,
  formatDate,
  formatDateTimeForSheet,
  formatHumanReadableTimestamp,
  convertToSingaporeTime,
  checkIfNewMonth,
  formatSheetArchiveName,
  formatMonthlySheetName,
  roundToNearestHour,
  isWithinTrackingHours,
  parseTimestampFromText,
  extractTimestampFromImage,
};

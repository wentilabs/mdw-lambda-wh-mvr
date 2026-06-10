const util = require('util');

const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

function createLogCollector({ includeTimestamp = true } = {}) {
  const originalConsoleFns = {};
  const entries = [];
  let isActive = false;

  const recordEntry = (level, args) => {
    const entry = {
      level,
      message: util.format(...args),
    };

    if (includeTimestamp) {
      entry.timestamp = new Date().toISOString();
    }

    entries.push(entry);
  };

  const wrapConsole = (level) => {
    return (...args) => {
      recordEntry(level, args);

      const original = originalConsoleFns[level];
      if (typeof original === 'function') {
        original.apply(console, args);
      }
    };
  };

  const start = () => {
    if (isActive) {
      return;
    }

    isActive = true;
    CONSOLE_LEVELS.forEach((level) => {
      originalConsoleFns[level] = console[level];
      console[level] = wrapConsole(level);
    });
  };

  const stop = () => {
    if (!isActive) {
      return;
    }

    CONSOLE_LEVELS.forEach((level) => {
      if (typeof originalConsoleFns[level] === 'function') {
        console[level] = originalConsoleFns[level];
      }
    });

    isActive = false;
  };

  const getLogs = () => entries.map((entry) => ({ ...entry }));

  const clear = () => {
    entries.length = 0;
  };

  return {
    start,
    stop,
    getLogs,
    clear,
  };
}

function formatLogEntries(entries = [], { timeZone = 'Asia/Singapore', includeLevel = true } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-SG', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (error) {
    console.warn('[log-collector] Failed to create Intl formatter, falling back to ISO timestamps.', error?.message);
    formatter = null;
  }

  return entries
    .map((entry) => {
      const timestamp = entry?.timestamp
        ? formatter
          ? formatter.format(new Date(entry.timestamp))
          : new Date(entry.timestamp).toISOString()
        : '';
      const level = includeLevel && entry?.level ? entry.level.toUpperCase() : '';
      const prefixParts = [];
      if (timestamp) {
        prefixParts.push(timestamp);
      }
      if (level) {
        prefixParts.push(level);
      }
      const prefix = prefixParts.length ? `[${prefixParts.join(' ')}] ` : '';
      return `${prefix}${entry?.message ?? ''}`;
    })
    .join('\n');
}

module.exports = {
  createLogCollector,
  formatLogEntries,
};

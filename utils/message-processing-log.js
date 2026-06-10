const { getSupabaseClient } = require('./common');

const TABLE_NAME = 'whatsapp_processing_runs';

const ProcessingStatus = Object.freeze({
  PROCESSING: 'processing',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

function normalizeListenerRowId(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }

  return null;
}

function nowUtcIso() {
  return new Date().toISOString();
}

function safeClone(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn('[message-processing-log] Failed to safely clone value, storing fallback string.', error?.message);
    return {
      __serializationError: true,
      description: String(error?.message || error || 'unknown'),
      fallback: String(value),
    };
  }
}

function serializeErrorPayload(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    const serialized = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    for (const key of Object.getOwnPropertyNames(error)) {
      if (!(key in serialized)) {
        serialized[key] = error[key];
      }
    }

    return safeClone(serialized);
  }

  if (typeof error === 'object') {
    return safeClone(error);
  }

  return safeClone({ message: String(error) });
}

async function fetchLatestAttemptNumber(messageId) {
  try {
    const { data, error } = await getSupabaseClient()
      .from(TABLE_NAME)
      .select('attempt_number')
      .eq('message_id', messageId)
      .order('attempt_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[message-processing-log] Unable to fetch latest attempt number', error);
      return null;
    }

    return data?.attempt_number ?? null;
  } catch (error) {
    console.error('[message-processing-log] Unexpected failure fetching attempt number', error);
    return null;
  }
}

async function createProcessingRun({
  messageId,
  listenerRowId = null,
  chatId = null,
  usecaseKey,
  handlerKey,
  messagePayload = null,
  handlerInput = null,
}) {
  if (!messageId) {
    console.warn('[message-processing-log] Missing messageId, skip logging run.');
    return null;
  }

  const basePayload = {
    message_id: messageId,
    listener_row_id: normalizeListenerRowId(listenerRowId),
    chat_id: chatId || null,
    usecase_key: usecaseKey || 'unknown',
    handler_key: handlerKey || 'unknown',
    status: ProcessingStatus.PROCESSING,
    message_payload: safeClone(messagePayload),
    handler_input: safeClone(handlerInput),
  };

  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;
  const startedAtMs = Date.now();

  while (attempt < maxAttempts) {
    try {
      const latestAttempt = await fetchLatestAttemptNumber(messageId);
      const nextAttemptNumber = typeof latestAttempt === 'number' ? latestAttempt + 1 : 1;

      const insertPayload = {
        ...basePayload,
        attempt_number: nextAttemptNumber,
        is_retry: nextAttemptNumber > 1,
      };

      const { data, error } = await getSupabaseClient().from(TABLE_NAME).insert(insertPayload).select().single();

      if (!error) {
        return {
          runId: data.id,
          attemptNumber: nextAttemptNumber,
          startedAtMs,
        };
      }

      lastError = error;

      if (error.code === '23505' || (error.message && error.message.includes('duplicate key value'))) {
        console.warn('[message-processing-log] Duplicate attempt number detected, retrying with next number.');
        attempt += 1;
        continue;
      }

      console.error('[message-processing-log] Failed to create processing run', error);
      break;
    } catch (error) {
      lastError = error;
      console.error('[message-processing-log] Unexpected error creating processing run', error);
      break;
    }
  }

  if (lastError) {
    console.error('[message-processing-log] Exhausted retries creating processing run', lastError);
  }
  return null;
}

async function completeProcessingRun({
  runId,
  status,
  startedAtMs,
  handlerOutput,
  handlerInput,
  errorPayload,
  remarks,
}) {
  if (!runId) {
    return;
  }

  const updatePayload = {
    status,
    completed_at: nowUtcIso(),
  };

  if (typeof startedAtMs === 'number') {
    const duration = Date.now() - startedAtMs;
    updatePayload.duration_ms = duration >= 0 ? duration : null;
  }

  if (handlerOutput !== undefined) {
    updatePayload.handler_output = safeClone(handlerOutput);
  }

  if (handlerInput !== undefined) {
    updatePayload.handler_input = safeClone(handlerInput);
  }

  if (errorPayload !== undefined) {
    updatePayload.error_payload = serializeErrorPayload(errorPayload);
  }

  if (remarks) {
    updatePayload.remarks = remarks;
  }

  try {
    const { error } = await getSupabaseClient().from(TABLE_NAME).update(updatePayload).eq('id', runId);
    if (error) {
      console.error('[message-processing-log] Failed to complete processing run', error);
    }
  } catch (error) {
    console.error('[message-processing-log] Unexpected failure updating processing run', error);
  }
}

async function markProcessingSuccess({ runId, startedAtMs, handlerOutput, handlerInput, remarks }) {
  try {
    await completeProcessingRun({
      runId,
      status: ProcessingStatus.SUCCESS,
      startedAtMs,
      handlerOutput,
      handlerInput,
      remarks,
    });
  } catch (error) {
    console.error('[message-processing-log] Unable to mark success', error);
  }
}

async function markProcessingFailure({ runId, startedAtMs, error, handlerOutput, handlerInput, remarks }) {
  try {
    await completeProcessingRun({
      runId,
      status: ProcessingStatus.FAILED,
      startedAtMs,
      handlerOutput,
      handlerInput,
      errorPayload: error,
      remarks,
    });
  } catch (completeError) {
    console.error('[message-processing-log] Unable to mark failure', completeError);
  }
}

async function markProcessingSkipped({ runId, startedAtMs, handlerOutput, handlerInput, remarks }) {
  try {
    await completeProcessingRun({
      runId,
      status: ProcessingStatus.SKIPPED,
      startedAtMs,
      handlerOutput,
      handlerInput,
      remarks,
    });
  } catch (error) {
    console.error('[message-processing-log] Unable to mark skipped', error);
  }
}

module.exports = {
  createProcessingRun,
  markProcessingSuccess,
  markProcessingFailure,
  markProcessingSkipped,
  ProcessingStatus,
};

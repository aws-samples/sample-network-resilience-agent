// Chat error classification + marker (de)serialization.
//
// Failed chat turns are stored in the assistant message's `content` string as
// `__CHAT_ERROR__<json>`, so the renderer (ChatMessage) can show a styled error
// box with a Retry button and a note about whether retrying is likely to help.
//
// classifyChatError() is the single source of truth for turning an AWS SDK
// error into user-facing copy — used by both chat-service.ts (the normal path)
// and ChatPanel.tsx (the unexpected-throw backstop).

export const CHAT_ERROR_PREFIX = '__CHAT_ERROR__';

export type ChatErrorKind =
  | 'transient' // 5xx / server fault — retrying usually works
  | 'throttle' // 429 — retrying after a short wait works
  | 'network' // no HTTP response — connection problem
  | 'access' // 403 — IAM / model-access change needed
  | 'config' // 404 / 400 — model ID or region is wrong
  | 'unknown'; // anything else

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  /** Short headline shown at the top of the error box. */
  title: string;
  /** Markdown body explaining what went wrong. */
  detail: string;
  /** One line on whether retrying is likely to help. */
  retryHint: string;
  /** Drives the retry-hint tone; transient/throttle/network are recoverable. */
  likelyTransient: boolean;
}

interface ErrorSignals {
  name?: string;
  status?: number;
  fault?: string;
  message: string;
}

function readSignals(err: unknown): ErrorSignals {
  const e = err as
    | { name?: string; $metadata?: { httpStatusCode?: number }; $fault?: string; message?: string }
    | undefined;
  return {
    name: e?.name,
    status: e?.$metadata?.httpStatusCode,
    fault: e?.$fault,
    message: err instanceof Error ? err.message : String(err ?? 'Unknown error'),
  };
}

const TRANSIENT_NAMES = new Set([
  'InternalServerException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'ModelNotReadyException',
  'ModelStreamErrorException',
]);

const NETWORK_NAMES = new Set(['TypeError', 'NetworkError', 'FetchError']);

export function classifyChatError(err: unknown): ChatErrorInfo {
  const { name, status, fault, message } = readSignals(err);
  const raw = message ? `\n\n_Details: ${message}_` : '';

  // Rate limiting — recoverable after a short wait.
  if (name === 'ThrottlingException' || status === 429) {
    return {
      kind: 'throttle',
      title: 'Bedrock is rate-limiting requests',
      detail: `Too many requests reached Bedrock at once.${raw}`,
      retryHint: 'Wait a few seconds, then retry — this usually clears on its own.',
      likelyTransient: true,
    };
  }

  // Server-side fault — the most common transient case (e.g. HTTP 500 on
  // converse-stream). Retrying often succeeds.
  if ((status !== undefined && status >= 500) || (name && TRANSIENT_NAMES.has(name)) || fault === 'server') {
    return {
      kind: 'transient',
      title: 'Bedrock had a temporary problem',
      detail: `The request reached Bedrock but it returned a server-side error${
        status ? ` (HTTP ${status})` : ''
      }. This is almost always temporary and not a problem with your request.${raw}`,
      retryHint: 'This is usually temporary — retrying often works.',
      likelyTransient: true,
    };
  }

  // Access denied — a permissions or model-access change is needed.
  if (name === 'AccessDeniedException' || status === 403) {
    return {
      kind: 'access',
      title: 'Access denied by Bedrock',
      detail:
        'Bedrock rejected the request as unauthorized. Check that:\n' +
        "- The Claude model is enabled in this region's **Bedrock → Model access** settings\n" +
        '- Your credentials allow **`bedrock:InvokeModelWithResponseStream`**\n' +
        '- Cross-region inference is enabled if you are in a non-US region' +
        raw,
      retryHint: "Retrying won't help until model access or permissions are fixed.",
      likelyTransient: false,
    };
  }

  // Model not found — usually a wrong model ID or one not enabled in the region.
  if (name === 'ResourceNotFoundException' || status === 404) {
    return {
      kind: 'config',
      title: 'Model not found',
      detail:
        'Bedrock could not find the requested model. The model ID may be wrong, ' +
        'or the model may not be available/enabled in this region. Check ' +
        '**`VITE_BEDROCK_MODEL_ID`** and your **Bedrock → Model access** settings.' +
        raw,
      retryHint: "Retrying won't help until the model ID or region is corrected.",
      likelyTransient: false,
    };
  }

  // Malformed request — won't fix itself on retry.
  if (name === 'ValidationException' || status === 400) {
    return {
      kind: 'config',
      title: 'Bedrock rejected the request',
      detail: `Bedrock considered the request invalid${status ? ` (HTTP ${status})` : ''}.${raw}`,
      retryHint: "Retrying as-is likely won't help — the request itself was rejected.",
      likelyTransient: false,
    };
  }

  // No HTTP response at all — typically a network/connectivity problem.
  if (status === undefined && (name === undefined || (name && NETWORK_NAMES.has(name)))) {
    return {
      kind: 'network',
      title: 'Could not reach Bedrock',
      detail: `The request didn't get a response from Bedrock.${raw}`,
      retryHint: 'This looks like a network issue — check your connection, then retry.',
      likelyTransient: true,
    };
  }

  return {
    kind: 'unknown',
    title: 'Request failed',
    detail: `Something went wrong while reaching Bedrock${status ? ` (HTTP ${status})` : ''}.${raw}`,
    retryHint: 'You can retry; if it keeps failing, this may not be a temporary issue.',
    likelyTransient: false,
  };
}

export function encodeChatError(info: ChatErrorInfo): string {
  return CHAT_ERROR_PREFIX + JSON.stringify(info);
}

/**
 * Decode a stored assistant message back into structured error info, or null if
 * the message is not an error marker. Falls back gracefully for legacy markers
 * that stored plain text instead of JSON.
 */
export function decodeChatError(content: string): ChatErrorInfo | null {
  if (!content.startsWith(CHAT_ERROR_PREFIX)) return null;
  const payload = content.slice(CHAT_ERROR_PREFIX.length);
  try {
    const parsed = JSON.parse(payload) as Partial<ChatErrorInfo>;
    if (parsed && typeof parsed.detail === 'string' && typeof parsed.title === 'string') {
      return {
        kind: parsed.kind ?? 'unknown',
        title: parsed.title,
        detail: parsed.detail,
        retryHint: parsed.retryHint ?? 'You can retry this request.',
        likelyTransient: parsed.likelyTransient ?? false,
      };
    }
  } catch {
    /* legacy plain-text marker — fall through */
  }
  // Legacy marker: the remainder is human-readable markdown.
  return {
    kind: 'unknown',
    title: 'Request failed',
    detail: payload,
    retryHint: 'You can retry this request.',
    likelyTransient: false,
  };
}

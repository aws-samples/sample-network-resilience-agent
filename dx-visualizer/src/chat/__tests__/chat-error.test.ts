import { describe, it, expect } from 'vitest';
import {
  classifyChatError,
  encodeChatError,
  decodeChatError,
  CHAT_ERROR_PREFIX,
} from '../chat-error';

// Minimal stand-in for an AWS SDK ServiceException.
function awsError(name: string, httpStatusCode?: number, fault?: string, message = 'boom') {
  return Object.assign(new Error(message), {
    name,
    $fault: fault,
    $metadata: httpStatusCode ? { httpStatusCode } : {},
  });
}

describe('classifyChatError', () => {
  it('treats HTTP 500 / InternalServerException as transient and retryable', () => {
    const info = classifyChatError(awsError('InternalServerException', 500, 'server'));
    expect(info.kind).toBe('transient');
    expect(info.likelyTransient).toBe(true);
    expect(info.retryHint.toLowerCase()).toContain('temporary');
  });

  it('classifies a bare HTTP 503 with no name as transient', () => {
    const info = classifyChatError(awsError('', 503));
    expect(info.kind).toBe('transient');
    expect(info.likelyTransient).toBe(true);
  });

  it('treats throttling / 429 as recoverable after a wait', () => {
    const info = classifyChatError(awsError('ThrottlingException', 429));
    expect(info.kind).toBe('throttle');
    expect(info.likelyTransient).toBe(true);
  });

  it('treats AccessDenied / 403 as non-transient with guidance', () => {
    const info = classifyChatError(awsError('AccessDeniedException', 403));
    expect(info.kind).toBe('access');
    expect(info.likelyTransient).toBe(false);
    expect(info.retryHint.toLowerCase()).toContain("won't help");
    expect(info.detail).toContain('Model access');
  });

  it('treats ResourceNotFound / 404 as a config problem', () => {
    const info = classifyChatError(awsError('ResourceNotFoundException', 404));
    expect(info.kind).toBe('config');
    expect(info.likelyTransient).toBe(false);
    expect(info.detail).toContain('VITE_BEDROCK_MODEL_ID');
  });

  it('treats ValidationException / 400 as a non-transient config error', () => {
    const info = classifyChatError(awsError('ValidationException', 400));
    expect(info.kind).toBe('config');
    expect(info.likelyTransient).toBe(false);
  });

  it('treats a response-less failure as a network error', () => {
    const info = classifyChatError(awsError('TypeError', undefined, undefined, 'Failed to fetch'));
    expect(info.kind).toBe('network');
    expect(info.likelyTransient).toBe(true);
  });

  it('falls back to unknown for unrecognized shapes', () => {
    const info = classifyChatError(awsError('WeirdException', 418));
    expect(info.kind).toBe('unknown');
    expect(info.likelyTransient).toBe(false);
  });

  it('handles non-Error throwables without crashing', () => {
    const info = classifyChatError('just a string');
    expect(info.title).toBeTruthy();
    expect(info.detail).toContain('just a string');
  });
});

describe('encode/decode round-trip', () => {
  it('round-trips structured error info through the marker', () => {
    const info = classifyChatError(awsError('InternalServerException', 500, 'server'));
    const encoded = encodeChatError(info);
    expect(encoded.startsWith(CHAT_ERROR_PREFIX)).toBe(true);
    expect(decodeChatError(encoded)).toEqual(info);
  });

  it('returns null for a normal (non-error) assistant message', () => {
    expect(decodeChatError('Here is your topology summary.')).toBeNull();
  });

  it('decodes a legacy plain-text marker into an unknown error', () => {
    const legacy = `${CHAT_ERROR_PREFIX}Failed to reach AWS Bedrock: timeout.`;
    const info = decodeChatError(legacy);
    expect(info).not.toBeNull();
    expect(info!.kind).toBe('unknown');
    expect(info!.detail).toContain('Failed to reach AWS Bedrock');
    expect(info!.retryHint).toBeTruthy();
  });
});

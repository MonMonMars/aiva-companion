import { EPHEMERAL_TOKEN_TTL_SECONDS } from './constants';

/**
 * @typedef {object} XaiClientSecretResponse
 * @property {string} value
 * @property {number} expires_at
 */

/**
 * @typedef {object} VoiceSessionApiResponse
 * @property {string} token
 * @property {number} expiresAt
 * @property {string} model
 * @property {string} wsUrl
 */

export function buildClientSecretRequestBody() {
  return { expires_after: { seconds: EPHEMERAL_TOKEN_TTL_SECONDS } };
}

/** Normalize xAI client_secrets JSON for the browser voice module. */
export function shapeVoiceSessionResponse(raw, model, wsUrl) {
  if (!raw?.value?.trim()) {
    throw new Error('xAI client_secrets response missing token value');
  }
  return {
    token: raw.value.trim(),
    expiresAt: raw.expires_at,
    model,
    wsUrl,
  };
}

export function buildWebSocketSubprotocol(token) {
  return `xai-client-secret.${token}`;
}

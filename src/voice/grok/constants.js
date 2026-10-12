/** xAI Grok realtime speech-to-speech defaults for AIVA companion. */

export const GROK_VOICE_MODEL = 'grok-voice-latest';

export const GROK_REALTIME_WS_URL = `wss://api.x.ai/v1/realtime?model=${GROK_VOICE_MODEL}`;

export const GROK_VOICE_SAMPLE_RATE = 24000;

export const DEFAULT_GROK_VOICE_ID = 'eve';

/** Short-lived browser token (seconds). Covers one voice session. */
export const EPHEMERAL_TOKEN_TTL_SECONDS = 300;

export const XAI_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';

/** Default session mint URL (same origin as dist/server.js). */
export const DEFAULT_GROK_SESSION_PATH = '/api/voice/session';

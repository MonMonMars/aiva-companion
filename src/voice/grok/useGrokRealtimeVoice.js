import { useCallback, useEffect, useRef, useState } from 'react';
import { netFetch } from '../../lib/netFetch';
import {
  base64Pcm16ToFloat32,
  float32ToBase64Pcm16,
  resampleFloat32,
} from './audio-pcm';
import { GROK_VOICE_SAMPLE_RATE } from './constants';
import { buildWebSocketSubprotocol } from './ephemeral-token';
import { buildGrokVoiceSessionUpdate } from './session-config';

/**
 * @typedef {'idle'|'connecting'|'connected'|'disconnecting'|'error'} VoiceConnectionStatus
 */

/**
 * @typedef {object} UseGrokRealtimeVoiceOptions
 * @property {string} sessionUrl POST endpoint that returns { token, wsUrl }
 * @property {import('./session-config').GrokVoiceSessionContext} sessionContext
 * @property {(message: string) => void} [onError]
 * @property {(speaking: boolean) => void} [onSpeakingChange]
 * @property {(text: string, role: 'user'|'assistant') => void} [onTranscript]
 */

export function useGrokRealtimeVoice({
  sessionUrl,
  sessionContext,
  onError,
  onSpeakingChange,
  onTranscript,
}) {
  const [status, setStatus] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [configMissing, setConfigMissing] = useState(false);
  const [lastError, setLastError] = useState(null);
  const [assistantLine, setAssistantLine] = useState('');
  const assistantAccRef = useRef('');

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const processorRef = useRef(null);
  const playbackTimeRef = useRef(0);
  const mutedRef = useRef(muted);
  const speakingRef = useRef(false);
  const ctxRef = useRef(sessionContext);
  ctxRef.current = sessionContext;

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const setSpeaking = useCallback((v) => {
    if (speakingRef.current === v) return;
    speakingRef.current = v;
    onSpeakingChange?.(v);
  }, [onSpeakingChange]);

  const reportError = useCallback((message) => {
    setLastError(message);
    setStatus('error');
    setSpeaking(false);
    onError?.(message);
  }, [onError, setSpeaking]);

  const cleanupMedia = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    if (audioContextRef.current?.state !== 'closed') {
      void audioContextRef.current?.close();
    }
    audioContextRef.current = null;
    playbackTimeRef.current = 0;
    setSpeaking(false);
  }, [setSpeaking]);

  const cleanupSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }, []);

  const stop = useCallback(() => {
    setStatus('disconnecting');
    cleanupSocket();
    cleanupMedia();
    setAssistantLine('');
    setStatus('idle');
  }, [cleanupMedia, cleanupSocket]);

  const schedulePlayback = useCallback((float32) => {
    const ctx = audioContextRef.current;
    if (!ctx || float32.length === 0) return;
    setSpeaking(true);
    const buffer = ctx.createBuffer(1, float32.length, GROK_VOICE_SAMPLE_RATE);
    buffer.copyToChannel(new Float32Array(float32), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playbackTimeRef.current);
    source.start(startAt);
    playbackTimeRef.current = startAt + buffer.duration;
    source.onended = () => {
      if (ctx.currentTime >= playbackTimeRef.current - 0.05) {
        setSpeaking(false);
      }
    };
  }, [setSpeaking]);

  const startMicPipeline = useCallback((ws) => {
    const stream = micStreamRef.current;
    const ctx = audioContextRef.current;
    if (!stream || !ctx) return;

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      if (ws.readyState !== WebSocket.OPEN || mutedRef.current) return;
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleFloat32(input, ctx.sampleRate, GROK_VOICE_SAMPLE_RATE);
      const audio = float32ToBase64Pcm16(resampled);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  }, []);

  const handleEvent = useCallback((parsed) => {
    const type = parsed?.type ?? '';
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      if (parsed.delta) {
        schedulePlayback(base64Pcm16ToFloat32(parsed.delta));
      }
      return;
    }
    if (type === 'response.done' || type === 'response.output_audio.done') {
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.updated') {
      const text = parsed.transcript || parsed.text || '';
      if (text) {
        onTranscript?.(String(text), 'user');
      }
      return;
    }
    if (type === 'response.output_audio_transcript.delta' && parsed.delta) {
      assistantAccRef.current += parsed.delta;
      setAssistantLine(assistantAccRef.current);
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      const text = parsed.transcript || assistantAccRef.current;
      if (text) onTranscript?.(String(text), 'assistant');
      assistantAccRef.current = '';
      setAssistantLine('');
      return;
    }
    if (type === 'error') {
      reportError(parsed.error?.message ?? 'Voice session error.');
    }
  }, [onTranscript, reportError, schedulePlayback]);

  const start = useCallback(async () => {
    if (status === 'connecting' || status === 'connected') return;
    setLastError(null);
    setConfigMissing(false);
    assistantAccRef.current = '';
    setAssistantLine('');
    setStatus('connecting');

    /** @type {{ token: string, wsUrl: string }} */
    let session;
    try {
      const res = await netFetch(sessionUrl, { method: 'POST' });
      if (res.status === 503) {
        setConfigMissing(true);
        setStatus('idle');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        reportError(body?.message ?? 'Could not start voice session.');
        return;
      }
      session = await res.json();
    } catch (e) {
      reportError(e?.message || 'Network error while starting voice.');
      return;
    }

    if (!session?.token || !session?.wsUrl) {
      reportError('Invalid voice session response.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      audioContextRef.current = new AudioContext({ sampleRate: GROK_VOICE_SAMPLE_RATE });
      await audioContextRef.current.resume();
    } catch {
      reportError('Microphone permission is required for voice chat.');
      cleanupMedia();
      return;
    }

    const ws = new WebSocket(session.wsUrl, [buildWebSocketSubprotocol(session.token)]);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify(buildGrokVoiceSessionUpdate(ctxRef.current)));
      startMicPipeline(ws);
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      try {
        handleEvent(JSON.parse(String(event.data)));
      } catch {
        // ignore non-JSON frames
      }
    };

    ws.onerror = () => {
      reportError('Voice connection failed.');
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        cleanupMedia();
        wsRef.current = null;
        setStatus('idle');
      }
    };
  }, [
    cleanupMedia,
    handleEvent,
    reportError,
    sessionUrl,
    startMicPipeline,
    status,
  ]);

  useEffect(() => () => {
    cleanupSocket();
    cleanupMedia();
  }, [cleanupMedia, cleanupSocket]);

  return {
    status,
    muted,
    setMuted,
    configMissing,
    lastError,
    assistantLine,
    start,
    stop,
    isActive: status === 'connected' || status === 'connecting',
  };
}

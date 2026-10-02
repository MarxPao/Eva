import http from 'http';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Unbuffered disk logging for reliable real-time observability
const logFilePath = path.join(__dirname, '..', 'server.log');
const origLog = console.log;
const origErr = console.error;
const formatArg = (a: any) => {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object') {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
};
console.log = (...args: any[]) => {
  origLog(...args);
  try {
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${args.map(formatArg).join(' ')}\n`);
  } catch {}
};
console.error = (...args: any[]) => {
  origErr(...args);
  try {
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] [ERROR] ${args.map(formatArg).join(' ')}\n`);
  } catch {}
};

import { createDefaultVoicePipeline } from './pipeline';
import { ChatMessage } from './core/providers/types';
import { ConfirmationRequest } from './core/tools/types';
import { isWhisperNoise } from './core/agent/whisper-filter';
import { PipelineTrace } from './core/instrumentation/trace-logger';
import { addWavHeader } from './pipeline/audio-transport';

// =========================================================================
// Cache de Síntese de Voz (TTS) em Memória — Elimina Dupla Latência
// =========================================================================
const ttsAudioCache = new Map<string, { buffer: Buffer; expiresAt: number }>();

function getCachedTts(text: string): Buffer | undefined {
  const norm = text.trim();
  const item = ttsAudioCache.get(norm);
  if (item && item.expiresAt > Date.now()) {
    return item.buffer;
  }
  return undefined;
}

function setCachedTts(text: string, buffer: Buffer) {
  const norm = text.trim();
  ttsAudioCache.set(norm, { buffer, expiresAt: Date.now() + 120000 });
  if (ttsAudioCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of ttsAudioCache.entries()) {
      if (v.expiresAt < now) ttsAudioCache.delete(k);
    }
  }
}

dotenv.config();

const PORT = parseInt(process.env.PORT || '8080', 10);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!GROQ_API_KEY) {
  console.warn('[AVISO] GROQ_API_KEY não encontrada no .env. Configure para usar os recursos de IA.');
}

// Inicializa a Voice Pipeline ponta a ponta
const voicePipeline = createDefaultVoicePipeline({
  groqApiKey: GROQ_API_KEY,
  groqModel: GROQ_MODEL,
  geminiApiKey: GEMINI_API_KEY,
  deepgramApiKey: DEEPGRAM_API_KEY,
});

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

declare const WebSocket: any;

// =========================================================================
// ESP32 Hardware Bridge & Server-Sent Events (SSE) Stream
// =========================================================================
const sseClients: Set<http.ServerResponse> = new Set();
let espWsClient: any = null;
let isEspWsConnected = false;
const ESP32_IP = process.env.ESP32_IP || '192.168.100.87';

function broadcastToClients(data: string) {
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

import { hasEvaWakeWord, cleanEvaPrefix, ActiveInteractionState } from './core/agent/barge-in';

// =========================================================================
// Gerenciador de Interrupção Conversacional (Barge-In) e Sessões Ativas
// =========================================================================
let activeInteraction: ActiveInteractionState | null = null;
let lastSpeakerActiveTime = 0;

export function interruptActiveInteraction(newPrompt?: string): {
  wasInterrupted: boolean;
  previousPrompt?: string;
  partialReply?: string;
} {
  const isCurrentlySpeaking = !!(
    activeInteraction &&
    (activeInteraction.isSpeaking || Date.now() < activeInteraction.speakingUntil)
  );

  if (activeInteraction && isCurrentlySpeaking) {
    const prevPrompt = activeInteraction.prompt;
    const prevReply = activeInteraction.partialReply;

    console.log(`[BARGE-IN] ⚡ Interrupção acionada! Interrompendo resposta anterior: "${prevPrompt}"`);
    activeInteraction.abortController.abort();
    activeInteraction.isSpeaking = false;
    activeInteraction.speakingUntil = 0;
    lastSpeakerActiveTime = 0;

    // Notifica todos os clientes SSE para interromperem áudio imediatamente
    broadcastToClients(
      JSON.stringify({
        type: 'interrupt',
        reason: 'barge_in',
        interruptedPrompt: prevPrompt,
        newPrompt: newPrompt || '',
      })
    );

    // Notifica o ESP32 para reativar o VAD imediatamente sem espera
    if (espWsClient && isEspWsConnected) {
      try {
        espWsClient.send(JSON.stringify({ cmd: 'speaker', speaking: false, interrupt: true }));
      } catch (e) {}
    }

    return { wasInterrupted: true, previousPrompt: prevPrompt, partialReply: prevReply };
  }

  return { wasInterrupted: false };
}

interface AudioStreamSession {
  id: string;
  chunks: Buffer[];
  totalBytes: number;
  t_stream_start: number;
  t_first_chunk_received?: number;
  trace: PipelineTrace;
}

let activeStreamSession: AudioStreamSession | null = null;

async function processVoiceAudioBuffer(audioBuffer: Buffer, trace: PipelineTrace) {
  try {
    broadcastToClients(JSON.stringify({
      type: 'voice_status',
      state: 'processing',
      message: 'Transcrevendo áudio do microfone...',
    }));

    // 1. Transcrição STT (Groq Whisper / Deepgram)
    const sttResult = await voicePipeline['sttOrchestrator'].execute(
      (stt) => stt.transcribe(audioBuffer, { language: 'pt' }),
      'Pipeline_Voice_STT'
    );
    trace.mark('t2');

    const userInputText = (sttResult.result.text || '').trim();

    // 2. Filtro Anti-Ruído Inteligente: se for ruído de fundo, respiração ou alucinação do Whisper, descarta
    if (isWhisperNoise(userInputText)) {
      console.log(`[STT Anti-Ruído] Descartado áudio sem fala legítima: "${userInputText}"`);
      broadcastToClients(JSON.stringify({
        type: 'voice_status',
        state: 'idle',
        message: 'Pronto para ouvir',
      }));
      return { userInputText: '', reply: '', ignored: true };
    }

    // 2.1 Cancelamento de Eco Inteligente com Suporte a Interrupção (Barge-In com 'eva:')
    const isSpeakingNow = !!(
      (activeInteraction && (activeInteraction.isSpeaking || Date.now() < activeInteraction.speakingUntil)) ||
      Date.now() < lastSpeakerActiveTime
    );

    const containsEva = hasEvaWakeWord(userInputText);

    if (isSpeakingNow) {
      // Se a EVA estava falando pelos alto-falantes e o áudio NÃO contém a chamada 'eva:',
      // trata-se de eco acústico captado do próprio cômodo. Descarta para evitar auto-resposta.
      if (!containsEva) {
        console.log(`[AEC Anti-Eco] Áudio captado durante fala da EVA sem prefixo 'eva' descartado: "${userInputText}"`);
        broadcastToClients(JSON.stringify({
          type: 'voice_status',
          state: 'idle',
          message: 'Pronto para ouvir',
        }));
        return { userInputText: '', reply: '', ignored: true, reason: 'aec_echo_without_wake_word' };
      }
      console.log(`[BARGE-IN] Comando 'eva' detectado durante fala da EVA! Interrompendo resposta anterior...`);
    }

    // Interrompe fala anterior se estiver em andamento (barge-in)
    const interruption = interruptActiveInteraction(userInputText);

    const currentInteractionId = `voice_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const currentAbortController = new AbortController();

    activeInteraction = {
      id: currentInteractionId,
      abortController: currentAbortController,
      prompt: userInputText,
      partialReply: '',
      isSpeaking: true,
      speakingUntil: Date.now() + 4000,
    };

    console.log(`[STT Fala Confirmada] Usuário disse: "${userInputText}"${interruption.wasInterrupted ? ' [INTERROMPENDO RESPOSTA ANTERIOR]' : ''}`);

    let hasDispatchedFirstAudio = false;

    // 3. Processamento do agente e síntese TTS em pipeline direto com suporte a refatoração
    const result = await voicePipeline.processText(userInputText, [], {
      synthesizeAudio: true,
      trace,
      abortSignal: currentAbortController.signal,
      interruptedFrom: interruption.wasInterrupted ? {
        previousPrompt: interruption.previousPrompt || '',
        partialResponse: interruption.partialReply || '',
      } : undefined,
      onToken: (token) => {
        if (activeInteraction && activeInteraction.id === currentInteractionId) {
          activeInteraction.partialReply += token;
        }
      },
      onSentenceAudio: (audioChunk, sentenceIndex) => {
        if (currentAbortController.signal.aborted) return;
        if (!hasDispatchedFirstAudio) {
          hasDispatchedFirstAudio = true;
          trace.mark('t6');
        }
        broadcastToClients(JSON.stringify({
          type: 'audio_sentence_chunk',
          index: sentenceIndex,
          data: audioChunk.toString('base64'),
          format: 'audio/mpeg',
        }));
      },
    });

    if (currentAbortController.signal.aborted) {
      console.log(`[VoicePipeline] Interação ${currentInteractionId} abortada por nova fala.`);
      return { userInputText, reply: '', ignored: true, aborted: true };
    }

    // 4. Salva o áudio no cache para que a interface web toque instantaneamente (0ms)
    if (result.responseAudioBuffer && result.agentResult.textResponse) {
      setCachedTts(result.agentResult.textResponse, result.responseAudioBuffer);
    }

    // 5. Calcula duração estimada da fala para o AEC (Cancelamento de Eco)
    const textLen = (result.agentResult.textResponse || '').length;
    const estDurationMs = result.responseAudioBuffer
      ? Math.max(3500, Math.round((result.responseAudioBuffer.length / 6000 + 1.8) * 1000))
      : Math.max(3500, Math.round(textLen * 65 + 1800));

    if (activeInteraction && activeInteraction.id === currentInteractionId) {
      activeInteraction.speakingUntil = Date.now() + estDurationMs;
      activeInteraction.isSpeaking = true;
    }
    lastSpeakerActiveTime = Date.now() + estDurationMs;

    // 6. Notifica o ESP32 sobre a fala da EVA para controle de eco
    if (espWsClient && isEspWsConnected) {
      try {
        espWsClient.send(JSON.stringify({ cmd: 'speaker', speaking: true, durationMs: estDurationMs }));
      } catch (e) {}
    }

    // 7. Transmite a transcrição e a resposta para todos os clientes conectados via SSE
    broadcastToClients(JSON.stringify({
      type: 'voice_interaction',
      userInputText,
      reply: result.agentResult.textResponse,
      requiresConfirmation: result.agentResult.requiresConfirmation,
      pendingConfirmation: result.agentResult.pendingConfirmation,
      toolExecutions: result.agentResult.toolExecutions,
      telemetry: result.telemetry,
    }));

    if (!hasDispatchedFirstAudio) {
      trace.mark('t6');
    }
    console.log(trace.report());

    return {
      userInputText,
      reply: result.agentResult.textResponse,
      requiresConfirmation: result.agentResult.requiresConfirmation,
      pendingConfirmation: result.agentResult.pendingConfirmation,
      telemetry: result.telemetry,
      hasAudioResponse: !!result.responseAudioBuffer,
      durationMs: estDurationMs,
    };
  } catch (err: any) {
    console.error('[processVoiceAudioBuffer Erro]', err);
    broadcastToClients(JSON.stringify({
      type: 'voice_status',
      state: 'idle',
      message: 'Pronto para ouvir',
    }));
    return { userInputText: '', reply: '', error: err.message || 'Erro no pipeline' };
  }
}

function startEsp32Bridge() {
  if (espWsClient) {
    try { espWsClient.close(); } catch {}
  }

  const wsUrl = `ws://${ESP32_IP}/ws`;
  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      isEspWsConnected = true;
      console.log(`[ESP32 Bridge] Conectado ao hardware em ${wsUrl}`);
      broadcastToClients(JSON.stringify({ type: 'hw_status', connected: true, ip: ESP32_IP }));
    };

    ws.onmessage = async (event: any) => {
      let isBinary = false;
      let rawBuffer: Buffer | null = null;

      if (event.data instanceof ArrayBuffer) {
        isBinary = true;
        rawBuffer = Buffer.from(event.data);
      } else if (typeof event.data?.arrayBuffer === 'function') {
        isBinary = true;
        rawBuffer = Buffer.from(await event.data.arrayBuffer());
      } else if (Buffer.isBuffer(event.data)) {
        isBinary = true;
        rawBuffer = event.data;
      }

      if (isBinary && rawBuffer) {
        // Chunk binário recebido do ESP32 via streaming contínuo
        if (activeStreamSession) {
          if (activeStreamSession.t_first_chunk_received === undefined) {
            activeStreamSession.t_first_chunk_received = performance.now();
            activeStreamSession.trace.mark('t1', activeStreamSession.t_first_chunk_received);
          }
          activeStreamSession.chunks.push(rawBuffer);
          activeStreamSession.totalBytes += rawBuffer.length;
        }
        return;
      }

      const textMsg = String(event.data);
      if (textMsg.startsWith('{') && textMsg.includes('"type":"audio_stream_')) {
        try {
          const parsed = JSON.parse(textMsg);
          if (parsed.type === 'audio_stream_start') {
            console.log(`[WS Streaming T1] 🎙️ Início de captura de áudio recebido do hardware ESP32!`);
            activeStreamSession = {
              id: `ws_stream_${Date.now()}`,
              chunks: [],
              totalBytes: 0,
              t_stream_start: performance.now(),
              trace: new PipelineTrace(`ws_stream_${Date.now()}`),
            };
            broadcastToClients(JSON.stringify({
              type: 'voice_status',
              state: 'recording',
              message: 'Ouvindo fala (microfone ESP32)...',
            }));
            return;
          }

          if (parsed.type === 'audio_stream_cancel' && activeStreamSession) {
            console.log('[WS Streaming T1] Sessão de áudio cancelada pelo hardware (ruído impulsivo descartado).');
            activeStreamSession = null;
            broadcastToClients(JSON.stringify({
              type: 'voice_status',
              state: 'idle',
              message: 'Pronto para ouvir',
            }));
            return;
          }

          if (parsed.type === 'audio_stream_end' && activeStreamSession) {
            const session = activeStreamSession;
            activeStreamSession = null;

            const t_upload_complete = performance.now();
            const deltaUpload = (parsed.t_upload_complete && parsed.t0)
              ? (parsed.t_upload_complete - parsed.t0)
              : 0;
            const t0 = t_upload_complete - deltaUpload;

            session.trace.mark('t0', t0);
            if (session.t_first_chunk_received) {
              session.trace.mark('t1', session.t_first_chunk_received);
            }

            console.log(`[WS Streaming T1] Concluído: ${session.chunks.length} chunks (${session.totalBytes} bytes). Processando áudio...`);

            if (session.totalBytes < 1600) {
              console.log('[WS Streaming T1] Descartado: áudio muito curto (< 1600 bytes).');
              broadcastToClients(JSON.stringify({
                type: 'voice_status',
                state: 'idle',
                message: 'Pronto para ouvir',
              }));
              return;
            }

            const pcmData = Buffer.concat(session.chunks);
            const wavAudio = addWavHeader(pcmData, 16000, 1, 16);
            await processVoiceAudioBuffer(wavAudio, session.trace);
            return;
          }
        } catch (err) {
          console.error('[WS Streaming Error]', err);
        }
      }

      broadcastToClients(textMsg);
    };

    ws.onclose = () => {
      isEspWsConnected = false;
      broadcastToClients(JSON.stringify({ type: 'hw_status', connected: false, ip: ESP32_IP }));
      setTimeout(startEsp32Bridge, 3000);
    };

    ws.onerror = () => {
      // Reconexão gerenciada no onclose
    };

    espWsClient = ws;
  } catch (err) {
    setTimeout(startEsp32Bridge, 4000);
  }
}

// Inicia a ponte do ESP32 automaticamente
startEsp32Bridge();

function parseBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Headers de CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // =========================================================================
  // API: Stream de Telemetria Serial do ESP32 via Server-Sent Events (SSE)
  // =========================================================================
  if (pathname === '/api/serial/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write(`data: ${JSON.stringify({ type: 'init', connected: isEspWsConnected, ip: ESP32_IP })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // =========================================================================
  // API: Status e Saúde do Sistema
  // =========================================================================
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'online',
        agent: 'EVA Agent Engine v0.1.0',
        groqConfigured: !!GROQ_API_KEY,
        geminiConfigured: !!GEMINI_API_KEY,
        model: GROQ_MODEL,
        uptime: process.uptime(),
      })
    );
    return;
  }

  // =========================================================================
  // API: Controle de Eco Acústico / Estado do Alto-Falante (/api/speaker/state)
  // =========================================================================
  if (pathname === '/api/speaker/state' && req.method === 'POST') {
    try {
      const rawBody = await parseBody(req);
      const body = JSON.parse(rawBody.toString('utf8') || '{}');
      const speaking = !!body.speaking;
      const durationMs = body.durationMs ? Number(body.durationMs) : undefined;

      if (!speaking) {
        if (activeInteraction) activeInteraction.isSpeaking = false;
        lastSpeakerActiveTime = 0;
      } else {
        lastSpeakerActiveTime = Date.now() + (durationMs || 4000);
      }

      if (espWsClient && isEspWsConnected) {
        try {
          espWsClient.send(JSON.stringify({ cmd: 'speaker', speaking, durationMs }));
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, speaking, durationMs }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  // =========================================================================
  // API: Interrupção Manual de Fala (Barge-In) (/api/interrupt)
  // =========================================================================
  if (pathname === '/api/interrupt' && req.method === 'POST') {
    try {
      const rawBody = await parseBody(req);
      const body = JSON.parse(rawBody.toString('utf8') || '{}');
      const resInterruption = interruptActiveInteraction(body.prompt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...resInterruption }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  // =========================================================================
  // API: Chat Inteligente com Tool Use & Human-in-the-Loop (/api/chat)
  // =========================================================================
  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const rawBody = await parseBody(req);
      const body = JSON.parse(rawBody.toString('utf8') || '{}');
      const message: string = body.message || '';
      const history: ChatMessage[] = Array.isArray(body.history) ? body.history : [];
      const confirmed: boolean | undefined = body.confirmed;
      const pendingConfirmation: ConfirmationRequest | undefined = body.pendingConfirmation;

      if (!message && !confirmed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Mensagem vazia' }));
        return;
      }

      const isSpeakingNow = !!(
        (activeInteraction && (activeInteraction.isSpeaking || Date.now() < activeInteraction.speakingUntil)) ||
        Date.now() < lastSpeakerActiveTime
      );
      const isEvaCommand = hasEvaWakeWord(message);

      let interruption: {
        wasInterrupted: boolean;
        previousPrompt?: string;
        partialReply?: string;
      } = { wasInterrupted: false };
      if (isSpeakingNow || isEvaCommand) {
        interruption = interruptActiveInteraction(message);
      }

      const chatAbortController = new AbortController();
      const currentInteractionId = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      activeInteraction = {
        id: currentInteractionId,
        abortController: chatAbortController,
        prompt: message,
        partialReply: '',
        isSpeaking: true,
        speakingUntil: Date.now() + 4000,
      };

      let pipelineResult;
      if (confirmed && pendingConfirmation) {
        pipelineResult = await voicePipeline.confirmAction(pendingConfirmation, history, {
          synthesizeAudio: false,
          abortSignal: chatAbortController.signal,
        });
      } else {
        pipelineResult = await voicePipeline.processText(message, history, {
          synthesizeAudio: false,
          abortSignal: chatAbortController.signal,
          interruptedFrom: interruption.wasInterrupted ? {
            previousPrompt: interruption.previousPrompt || '',
            partialResponse: interruption.partialReply || '',
          } : undefined,
          onToken: (token) => {
            if (activeInteraction && activeInteraction.id === currentInteractionId) {
              activeInteraction.partialReply += token;
            }
          },
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          reply: pipelineResult.agentResult.textResponse,
          requiresConfirmation: pipelineResult.agentResult.requiresConfirmation,
          pendingConfirmation: pipelineResult.agentResult.pendingConfirmation,
          toolExecutions: pipelineResult.agentResult.toolExecutions,
          telemetry: pipelineResult.telemetry,
        })
      );
    } catch (err: any) {
      console.error('[API /api/chat Erro]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Erro no processamento do agente' }));
    }
    return;
  }

  // =========================================================================
  // API: Síntese de Voz Edge-TTS (/api/tts)
  // =========================================================================
  if (pathname === '/api/tts' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let text = '';
      if (req.method === 'POST') {
        const rawBody = await parseBody(req);
        const parsed = JSON.parse(rawBody.toString('utf8') || '{}');
        text = parsed.text || '';
      } else {
        text = urlObj.searchParams.get('text') || '';
      }

      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Texto não informado' }));
        return;
      }

      // 1. Verifica cache em memória para entrega em 0ms (evita requisição repetida)
      const cached = getCachedTts(text);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': cached.length,
          'Cache-Control': 'no-cache',
          'X-Cache': 'HIT',
        });
        res.end(cached);
        return;
      }

      // Utiliza o TTS Provider orquestrado
      const ttsResult = await voicePipeline['ttsOrchestrator'].execute(
        (tts) => tts.synthesize(text),
        'HTTP_TTS'
      );

      setCachedTts(text, ttsResult.result.audioBuffer);

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': ttsResult.result.audioBuffer.length,
        'Cache-Control': 'no-cache',
      });
      res.end(ttsResult.result.audioBuffer);
    } catch (err: any) {
      console.error('[API /api/tts Erro]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Erro na síntese de voz' }));
    }
    return;
  }

  // =========================================================================
  // API: Transcrição de Áudio Groq Whisper (/api/transcribe ou /api/stt)
  // =========================================================================
  if ((pathname === '/api/transcribe' || pathname === '/api/stt') && req.method === 'POST') {
    try {
      const audioBuffer = await parseBody(req);
      if (!audioBuffer || audioBuffer.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Buffer de áudio vazio' }));
        return;
      }

      const sttResult = await voicePipeline['sttOrchestrator'].execute(
        (stt) => stt.transcribe(audioBuffer, { language: 'pt' }),
        'HTTP_STT'
      );

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text: sttResult.result.text, duration: sttResult.result.durationSeconds }));
    } catch (err: any) {
      console.error('[API /api/transcribe Erro]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Erro na transcrição de áudio' }));
    }
    return;
  }

  // =========================================================================
  // API: Ciclo de Voz Ponta a Ponta (/api/pipeline/voice)
  // =========================================================================
  if (pathname === '/api/pipeline/voice' && req.method === 'POST') {
    try {
      let audioBuffer = await parseBody(req);
      if (!audioBuffer || audioBuffer.length < 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Buffer de áudio vazio ou insuficiente' }));
        return;
      }

      const trace = new PipelineTrace(`http_post_${Date.now()}`);
      const t1 = performance.now();
      trace.mark('t1', t1);

      const vadElapsedHeader = req.headers['x-vad-cutoff-elapsed-ms'];
      const vadElapsed = vadElapsedHeader ? Number(vadElapsedHeader) : 0;
      trace.mark('t0', t1 - vadElapsed);

      // Adiciona cabeçalho WAV caso o hardware tenha enviado PCM bruto
      if (audioBuffer.length >= 44 && audioBuffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
        audioBuffer = addWavHeader(audioBuffer, 16000, 1, 16);
      }

      const responsePayload = await processVoiceAudioBuffer(audioBuffer, trace);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(responsePayload));
    } catch (err: any) {
      console.error('[API /api/pipeline/voice Erro]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Erro no pipeline de voz' }));
    }
    return;
  }

  // =========================================================================
  // Servir Arquivos Estáticos (index.html, etc.)
  // =========================================================================
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, '..', reqPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Não Encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 EVA Voice Assistant Engine rodando na porta ${PORT}`);
  console.log(`🔗 Interface Web: http://localhost:${PORT}`);
  console.log(`🤖 Modelo LLM Primário: ${GROQ_MODEL} (Groq)`);
  console.log(`🛡️ Fallback LLM: ${GEMINI_API_KEY ? 'Ativo (Gemini)' : 'Desativado'}`);
  console.log(`🎙️ Provedor STT Primário: ${DEEPGRAM_API_KEY ? 'Deepgram Nova-2 (Streaming WS / REST)' : 'Groq Whisper-large-v3-turbo'}`);
  console.log(`🎙️ Microfone ESP32: ws://192.168.100.87/ws`);
  console.log(`======================================================\n`);

  // Task 4 (P2): Pré-aquecimento das conexões de rede no boot
  voicePipeline.prewarm().then((metrics) => {
    console.log(`[Task 4 Pre-Warm] Conexões ativas e pré-aquecidas: TTS: ${metrics.ttsMs}ms | STT: ${metrics.sttMs}ms | LLM: ${metrics.llmMs}ms.`);
    console.log(`[Task 4 Pre-Warm] Overhead de setup nas interações do usuário: 0ms (TLS/TCP/WS aquecidos).`);
  }).catch((err) => {
    console.warn('[Task 4 Pre-Warm] Aviso ao pré-aquecer:', err);
  });
});

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
import { A2DPStreamer } from './core/audio/a2dp-streamer';

const a2dpStreamer = new A2DPStreamer();

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

import WebSocket, { WebSocketServer } from 'ws';

// =========================================================================
// ESP32 Hardware Bridge & Server-Sent Events (SSE) Stream
// =========================================================================
const sseClients: Set<http.ServerResponse> = new Set();
let espWsClient: any = null;
let isEspWsConnected = false;
let ESP32_IP = process.env.ESP32_IP || '192.168.2.177';
let lastBtConnected = false;
let lastBtDeviceName = 'BT-SPEAKER';

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});

function broadcastToClients(data: string) {
  const cleanData = (typeof data === 'string' ? data : JSON.stringify(data)).trim();
  if (!cleanData) return;
  for (const client of sseClients) {
    try {
      if (client.writable && !client.destroyed && !client.writableEnded) {
        client.write(`data: ${cleanData}\n\n`);
      } else {
        sseClients.delete(client);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

import {
  hasEvaWakeWord,
  cleanEvaPrefix,
  isStopCommand,
  isPureStopCommand,
  ActiveInteractionState,
} from './core/agent/barge-in';

// =========================================================================
// Log Estruturado de Conversação e Histórico Persistente
// =========================================================================
export interface ConversationLogEntry {
  id: string;
  timestamp: string;
  timeStr: string;
  status: 'answered' | 'ignored_ambient' | 'ignored_noise' | 'aec_discarded' | 'error';
  userInput: string;
  reply?: string;
  latencyMs?: number;
  breakdown?: {
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
  };
  note?: string;
}

const historyFilePath = path.join(__dirname, '..', 'conversation_history.jsonl');
export const conversationHistory: ConversationLogEntry[] = [];

try {
  if (fs.existsSync(historyFilePath)) {
    const lines = fs.readFileSync(historyFilePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-100)) {
      try {
        conversationHistory.push(JSON.parse(line));
      } catch {}
    }
  }
} catch {}

export function addConversationLogEntry(entry: ConversationLogEntry) {
  conversationHistory.push(entry);
  if (conversationHistory.length > 200) {
    conversationHistory.shift();
  }
  try {
    fs.appendFileSync(historyFilePath, JSON.stringify(entry) + '\n');
  } catch {}
}

export function clearConversationHistory() {
  conversationHistory.length = 0;
  try {
    fs.writeFileSync(historyFilePath, '');
  } catch {}
}

// Configurações de Ativação por Voz
let requireWakeWord = true; // Ativado por padrão: previne que a EVA responda a ruídos ambientes ou converse consigo mesma
let lastConversationActivity = 0;
const FOLLOW_UP_WINDOW_MS = 7000; // Janela estrita de diálogo contínuo de 7s apenas quando a EVA fez uma pergunta

// =========================================================================
// Registro de Falas Recentes da EVA para Bloqueio de Loops de Auto-Resposta (AEC)
// =========================================================================
interface RecentEvaSpeech {
  text: string;
  normalized: string;
  words: Set<string>;
  timestamp: number;
}

const recentEvaSpeeches: RecentEvaSpeech[] = [];

export function recordEvaSpeech(text: string) {
  if (!text || !text.trim()) return;
  const clean = normalizeTextForComparison(text);
  const words = new Set(clean.split(/\s+/).filter((w) => w.length > 2));
  recentEvaSpeeches.push({
    text,
    normalized: clean,
    words,
    timestamp: Date.now(),
  });
  // Mantém falas dos últimos 60 segundos (até 25 falas recentes)
  while (recentEvaSpeeches.length > 25 || (recentEvaSpeeches[0] && Date.now() - recentEvaSpeeches[0].timestamp > 60000)) {
    recentEvaSpeeches.shift();
  }
}

export function normalizeTextForComparison(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSelfEcho(userInputText: string): { isEcho: boolean; matchedSpeech?: string; similarityRatio: number } {
  if (!userInputText || userInputText.trim().length === 0) {
    return { isEcho: false, similarityRatio: 0 };
  }

  // Se o usuário falou a palavra de ativação "eva", é intenção explícita de comando / interrupção, NUNCA eco!
  if (hasEvaWakeWord(userInputText)) {
    return { isEcho: false, similarityRatio: 0 };
  }

  const cleanInput = normalizeTextForComparison(userInputText);
  if (cleanInput.length < 3) return { isEcho: false, similarityRatio: 0 };

  const inputWords = cleanInput.split(/\s+/).filter((w) => w.length > 2);
  if (inputWords.length === 0) return { isEcho: false, similarityRatio: 0 };

  const now = Date.now();

  // 1. Verifica contra fala que a Eva está sintetizando agora (Barge-In feedback prevention)
  if (activeInteraction?.partialReply) {
    const currentNorm = normalizeTextForComparison(activeInteraction.partialReply);
    if (currentNorm.length > 5) {
      if (currentNorm.includes(cleanInput) || (cleanInput.length > 15 && cleanInput.includes(currentNorm))) {
        return { isEcho: true, matchedSpeech: activeInteraction.partialReply, similarityRatio: 1.0 };
      }
      const currentWords = new Set(currentNorm.split(/\s+/).filter((w) => w.length > 2));
      let matches = 0;
      for (const w of inputWords) {
        if (currentWords.has(w)) matches++;
      }
      const ratio = matches / inputWords.length;
      if (inputWords.length >= 2 && ratio >= 0.4) {
        return { isEcho: true, matchedSpeech: activeInteraction.partialReply, similarityRatio: ratio };
      }
    }
  }

  // 2. Verifica contra o histórico de falas recentes da EVA dos últimos 60 segundos
  for (let i = recentEvaSpeeches.length - 1; i >= 0; i--) {
    const speech = recentEvaSpeeches[i];
    if (now - speech.timestamp > 60000) continue;

    // A. Contenção direta de substring ou frase da EVA
    if (
      speech.normalized.includes(cleanInput) ||
      (cleanInput.length > 15 && cleanInput.includes(speech.normalized))
    ) {
      return { isEcho: true, matchedSpeech: speech.text, similarityRatio: 1.0 };
    }

    // B. Alta sobreposição de vocabulário (>= 35% das palavras do áudio pertencem à fala da EVA)
    if (speech.words.size > 0) {
      let matches = 0;
      for (const w of inputWords) {
        if (speech.words.has(w)) matches++;
      }
      const ratio = matches / inputWords.length;
      if (inputWords.length >= 2 && ratio >= 0.35) {
        return { isEcho: true, matchedSpeech: speech.text, similarityRatio: ratio };
      }
    }
  }

  return { isEcho: false, similarityRatio: 0 };
}

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
  const now = Date.now();
  const isCurrentlySpeaking = !!(
    activeInteraction &&
    activeInteraction.isSpeaking &&
    now < activeInteraction.speakingUntil
  );

  if (activeInteraction && isCurrentlySpeaking) {
    const prevPrompt = activeInteraction.prompt;
    const prevReply = activeInteraction.partialReply;

    console.log(`[BARGE-IN] ⚡ Interrupção acionada! Interrompendo resposta anterior: "${prevPrompt}"`);
    activeInteraction.abortController.abort();
    activeInteraction.isSpeaking = false;
    activeInteraction.speakingUntil = 0;
    lastSpeakerActiveTime = 0;
    a2dpStreamer.stop();

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
        espWsClient.send(JSON.stringify({ cmd: 'speaking_end', interrupt: true }));
        espWsClient.send(JSON.stringify({ cmd: 'interrupt' }));
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
  safetyTimer?: NodeJS.Timeout;
  hasDetectedSpeech?: boolean;
  consecutiveSilenceChunks?: number;
}

export function calculateBufferRms(buf: Buffer): number {
  if (buf.length < 2) return 0;
  let sum = 0;
  const numSamples = Math.floor(buf.length / 2);
  for (let i = 0; i < buf.length - 1; i += 2) {
    const sample = buf.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / numSamples);
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
      (stt) => stt.transcribe(audioBuffer, {
        language: 'pt',
        prompt: 'EVA, assistente virtual inteligente em português. Fala com a Eva.',
      }),
      'Pipeline_Voice_STT'
    );
    trace.mark('t2');

    const userInputText = (sttResult.result.text || '').trim();

    // 2. Filtro Anti-Ruído Inteligente: se for ruído de fundo, respiração ou alucinação do Whisper, descarta
    if (isWhisperNoise(userInputText)) {
      console.log(`[STT Anti-Ruído] Descartado áudio sem fala legítima: "${userInputText}"`);
      addConversationLogEntry({
        id: `noise_${Date.now()}`,
        timestamp: new Date().toISOString(),
        timeStr: new Date().toLocaleTimeString('pt-BR'),
        status: 'ignored_noise',
        userInput: userInputText,
        note: 'Ruído ou alucinação descartada',
      });
      broadcastToClients(JSON.stringify({
        type: 'voice_status',
        state: 'idle',
        message: 'Pronto para ouvir',
      }));
      return { userInputText: '', reply: '', ignored: true };
    }

    // 2.1 Bloqueio Rigoroso de Loop de Auto-Resposta (AEC)
    const echoCheck = isSelfEcho(userInputText);
    if (echoCheck.isEcho) {
      console.log(`[AEC Anti-Eco] 🔇 Eco de auto-resposta bloqueado! Transcrição: "${userInputText}" coincide com fala recente da EVA ("${echoCheck.matchedSpeech}"). DESCARTADO.`);
      addConversationLogEntry({
        id: `echo_${Date.now()}`,
        timestamp: new Date().toISOString(),
        timeStr: new Date().toLocaleTimeString('pt-BR'),
        status: 'aec_discarded',
        userInput: userInputText,
        note: `Eco da própria EVA bloqueado (similaridade: ${Math.round(echoCheck.similarityRatio * 100)}%)`,
      });
      broadcastToClients(JSON.stringify({
        type: 'voice_status',
        state: 'idle',
        message: 'Pronto para ouvir',
      }));
      return { userInputText: '', reply: '', ignored: true, reason: 'self_echo_blocked' };
    }

    // 2.2 Protocolo de Interrupção Imediata (Barge-In) e Bloqueio Rigoroso de Eco do Alto-Falante
    const now = Date.now();
    const isSpeakingNow = !!(
      (activeInteraction && activeInteraction.isSpeaking && now < activeInteraction.speakingUntil) ||
      now < lastSpeakerActiveTime
    );

    let interruption: { wasInterrupted: boolean; previousPrompt?: string; partialReply?: string } = { wasInterrupted: false };
    if (isSpeakingNow) {
      const isExplicitWake = hasEvaWakeWord(userInputText);
      const isExplicitStop = isStopCommand(userInputText);

      // Se a EVA estiver reproduzindo áudio pelo alto-falante e o microfone captar som que NÃO contenha 'Eva'
      // nem comando de parada explícito ('para', 'stop', etc.), trata-se de eco acústico da própria caixa de som!
      // DESCARTA IMEDIATAMENTE para evitar auto-respostas e loops!
      if (!isExplicitWake && !isExplicitStop) {
        console.log(`[AEC Anti-Eco] 🔇 Áudio recebido durante reprodução da EVA sem palavra de ativação nem comando de parada ("${userInputText}"). Descartado como eco acústico.`);
        addConversationLogEntry({
          id: `echo_${Date.now()}`,
          timestamp: new Date().toISOString(),
          timeStr: new Date().toLocaleTimeString('pt-BR'),
          status: 'aec_discarded',
          userInput: userInputText,
          note: 'Eco acústico do alto-falante descartado durante fala da EVA',
        });
        broadcastToClients(JSON.stringify({
          type: 'voice_status',
          state: 'idle',
          message: 'Pronto para ouvir',
        }));
        return { userInputText: '', reply: '', ignored: true, reason: 'speaker_echo_blocked' };
      }

      console.log(`[BARGE-IN] ⚡ Interrupção legítima com wake-word/parada durante fala da EVA! Usuário disse: "${userInputText}". Interrompendo resposta anterior.`);
      interruption = interruptActiveInteraction(userInputText);

      // Se for comando puro de parada ("Eva, para", "para", "silêncio", "stop", etc.), silencia imediatamente sem gerar nova fala
      if (isPureStopCommand(userInputText)) {
        console.log(`[BARGE-IN] 🛑 Comando puro de parada executado. EVA silenciada.`);
        addConversationLogEntry({
          id: `stop_${Date.now()}`,
          timestamp: new Date().toISOString(),
          timeStr: new Date().toLocaleTimeString('pt-BR'),
          status: 'answered',
          userInput: userInputText,
          reply: '[Fala interrompida pelo usuário]',
          note: 'Comando de parada executado',
        });
        broadcastToClients(JSON.stringify({
          type: 'voice_status',
          state: 'idle',
          message: 'Pronta para ouvir',
        }));
        if (espWsClient && isEspWsConnected) {
          try {
            espWsClient.send(JSON.stringify({
              cmd: 'conversation_log',
              status: 'answered',
              user: userInputText,
              reply: '[Fala interrompida]',
            }));
          } catch {}
        }
        return { userInputText, reply: '', ignored: true, reason: 'stop_command' };
      }
    }

    // 2.3 Filtro Rigoroso de Palavra de Ativação ("Eva") e Diálogo Contínuo
    const containsEva = hasEvaWakeWord(userInputText);

    // Diálogo contínuo: só permite fala sem 'Eva' se:
    // 1. Houve resposta anterior recente da EVA
    // 2. A última fala da EVA foi uma pergunta (terminou em '?')
    // 3. A EVA já terminou de falar e estamos na janela curta (<= 7s)
    const lastAnswer = conversationHistory.length > 0 ? conversationHistory[conversationHistory.length - 1] : null;
    const lastReplyWasQuestion = !!(lastAnswer?.reply && lastAnswer.reply.trim().endsWith('?'));
    const isAfterSpeechEnd = Date.now() >= lastConversationActivity;
    const isFollowUp = lastReplyWasQuestion && isAfterSpeechEnd && (Date.now() - lastConversationActivity) < FOLLOW_UP_WINDOW_MS;

    if (requireWakeWord && !containsEva && !isFollowUp) {
      console.log(`[ÁUDIO AMBIENTE IGNORADO] Sem palavra de ativação 'Eva': "${userInputText}"`);
      const ambientEntry: ConversationLogEntry = {
        id: `ambient_${Date.now()}`,
        timestamp: new Date().toISOString(),
        timeStr: new Date().toLocaleTimeString('pt-BR'),
        status: 'ignored_ambient',
        userInput: userInputText,
        note: "Áudio ambiente ignorado (não chamou 'Eva' e fora de diálogo ativo)",
      };
      addConversationLogEntry(ambientEntry);

      broadcastToClients(JSON.stringify({
        type: 'conversation_turn',
        entry: ambientEntry,
      }));

      if (espWsClient && isEspWsConnected) {
        try {
          espWsClient.send(JSON.stringify({
            cmd: 'conversation_log',
            status: 'ignored_ambient',
            user: userInputText,
          }));
        } catch {}
      }

      broadcastToClients(JSON.stringify({
        type: 'voice_status',
        state: 'idle',
        message: 'Pronto para ouvir',
      }));
      return { userInputText: '', reply: '', ignored: true, reason: 'wake_word_missing' };
    }

    // Aborta e cancela imediatamente qualquer interação anterior que ainda estivesse ativa ou sintetizando
    if (activeInteraction) {
      console.log(`[Interaction Manager] Cancelando interação anterior ("${activeInteraction.prompt}") para dar lugar a: "${userInputText}"`);
      try {
        activeInteraction.abortController.abort();
      } catch {}
      activeInteraction.isSpeaking = false;
      activeInteraction.speakingUntil = 0;
      broadcastToClients(JSON.stringify({
        type: 'interrupt',
        reason: 'new_utterance',
      }));
    }

    const currentInteractionId = `voice_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const currentAbortController = new AbortController();

    activeInteraction = {
      id: currentInteractionId,
      abortController: currentAbortController,
      prompt: userInputText,
      partialReply: '',
      isSpeaking: false,
      speakingUntil: 0,
    };

    const promptText = cleanEvaPrefix(userInputText) || userInputText;
    console.log(`[STT Fala Confirmada] Usuário disse: "${userInputText}"${interruption.wasInterrupted ? ' [INTERROMPENDO RESPOSTA ANTERIOR]' : ''}`);

    let hasDispatchedFirstAudio = false;

    // Monta histórico conversacional recente (últimos 4 turnos respondidos com sucesso)
    const recentHistory: ChatMessage[] = [];
    for (const item of conversationHistory.slice(-4)) {
      if (item.status === 'answered' && item.userInput && item.reply) {
        recentHistory.push({ role: 'user', content: item.userInput });
        recentHistory.push({ role: 'assistant', content: item.reply });
      }
    }

    // 3. Processamento do agente e síntese TTS em pipeline direto com suporte a refatoração
    const result = await voicePipeline.processText(promptText, recentHistory, {
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
        // Só transmite PCM ao ESP32 se a caixa BT estiver conectada; caso contrário o fluxo de ~176 KB/s
        // satura Wi-Fi/heap do ESP32 sem ninguém consumir (causa das quedas 1006 do WebSocket).
        if (lastBtConnected) {
          a2dpStreamer.streamSentence(currentInteractionId, sentenceIndex, audioChunk);
        }
        if (!hasDispatchedFirstAudio) {
          hasDispatchedFirstAudio = true;
          trace.mark('t6');
          // Imediatamente marca a EVA como falando para que o ESP32 e o AEC ativem proteção
          const initDurationMs = Math.max(6000, Math.round((activeInteraction?.partialReply?.length || 60) * 75 + 1500));
          if (activeInteraction && activeInteraction.id === currentInteractionId) {
            activeInteraction.isSpeaking = true;
            activeInteraction.speakingUntil = Date.now() + initDurationMs;
          }
          lastSpeakerActiveTime = Date.now() + initDurationMs;
          if (espWsClient && isEspWsConnected) {
            try {
              espWsClient.send(JSON.stringify({ cmd: 'speaking_start', speaking: true, durationMs: initDurationMs }));
            } catch {}
          }
        }
        broadcastToClients(JSON.stringify({
          type: 'audio_sentence_chunk',
          interactionId: currentInteractionId,
          index: sentenceIndex,
          data: audioChunk.toString('base64'),
          format: 'audio/mpeg',
        }));
      },
    });

    if (currentAbortController.signal.aborted) {
      a2dpStreamer.stop();
      console.log(`[VoicePipeline] Interação ${currentInteractionId} abortada por nova fala.`);
      return { userInputText, reply: '', ignored: true, aborted: true };
    }

    a2dpStreamer.finish();

    // 4. Salva o áudio no cache e registra fala no AEC para bloqueio de auto-resposta
    if (result.agentResult.textResponse) {
      recordEvaSpeech(result.agentResult.textResponse);
      if (result.responseAudioBuffer) {
        setCachedTts(result.agentResult.textResponse, result.responseAudioBuffer);
      }
    }

    // 5. Calcula duração estimada da fala para o AEC (Cancelamento de Eco)
    // Edge-TTS em pt-BR tem taxa média de ~13 caracteres/segundo (~75ms/char).
    // Adicionamos 1500ms de margem de folga para pontuação, respiração e buffers de áudio.
    const textLen = (result.agentResult.textResponse || '').length;
    const estDurationMs = result.responseAudioBuffer
      ? Math.max(3500, Math.round((result.responseAudioBuffer.length / 6000) * 1000 + 1500))
      : Math.max(3500, Math.round(textLen * 75 + 1500));

    if (activeInteraction && activeInteraction.id === currentInteractionId) {
      activeInteraction.speakingUntil = Date.now() + estDurationMs;
      activeInteraction.isSpeaking = true;
      setTimeout(() => {
        if (activeInteraction && activeInteraction.id === currentInteractionId) {
          activeInteraction.isSpeaking = false;
          activeInteraction.speakingUntil = 0;
        }
        if (espWsClient && isEspWsConnected) {
          try {
            espWsClient.send(JSON.stringify({ cmd: 'speaking_end', speaking: false }));
          } catch {}
        }
      }, estDurationMs);
    }
    lastSpeakerActiveTime = Date.now() + estDurationMs;
    setTimeout(() => {
      if (Date.now() >= lastSpeakerActiveTime) {
        lastSpeakerActiveTime = 0;
      }
    }, estDurationMs + 50);

    lastConversationActivity = Date.now() + estDurationMs;

    const totalLatency = Math.round(performance.now() - (trace.checkpoints.t0 || trace.baseTime));
    const breakdown = {
      sttMs: Math.round(result.telemetry?.latency?.sttMs || sttResult.result.latencyMs || 0),
      llmMs: Math.round(result.telemetry?.latency?.llmMs || 0),
      ttsMs: Math.round(result.telemetry?.latency?.ttsMs || 0),
    };

    const entry: ConversationLogEntry = {
      id: currentInteractionId,
      timestamp: new Date().toISOString(),
      timeStr: new Date().toLocaleTimeString('pt-BR'),
      status: 'answered',
      userInput: userInputText,
      reply: result.agentResult.textResponse,
      latencyMs: totalLatency,
      breakdown,
      note: 'Respondido com sucesso',
    };
    addConversationLogEntry(entry);

    console.log(`\n┌────────────────── CONVERSAÇÃO EVA ──────────────────┐`);
    console.log(`│ [${entry.timeStr}] 👤 USUÁRIO: "${userInputText}"`);
    console.log(`│ 🤖 EVA: "${result.agentResult.textResponse}"`);
    console.log(`│ ⏱️ LATÊNCIA TOTAL: ${totalLatency}ms (STT: ${breakdown.sttMs}ms | LLM: ${breakdown.llmMs}ms | TTS: ${breakdown.ttsMs}ms)`);
    console.log(`└─────────────────────────────────────────────────────┘\n`);

    // 6. Notifica o ESP32 sobre a fala e o log de conversação para o Monitor Serial
    if (espWsClient && isEspWsConnected) {
      try {
        espWsClient.send(JSON.stringify({ cmd: 'speaking_start', speaking: true, durationMs: estDurationMs }));
        espWsClient.send(JSON.stringify({
          cmd: 'conversation_log',
          status: 'answered',
          user: userInputText,
          reply: result.agentResult.textResponse,
          latencyMs: totalLatency,
        }));
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

    broadcastToClients(JSON.stringify({
      type: 'conversation_turn',
      entry,
    }));

    if (!hasDispatchedFirstAudio) {
      trace.mark('t6');
    }
    console.log(trace.report());
    const stageDurations = trace.getStageDurations();
    console.log(`[PIPELINE TIMINGS] ⏱️ FimFala->Ingestão: ${stageDurations.uploadMs?.toFixed(1) ?? 'N/A'}ms | STT: ${stageDurations.sttMs?.toFixed(1) ?? 'N/A'}ms | 1ºToken LLM: ${stageDurations.ttftMs?.toFixed(1) ?? 'N/A'}ms | 1ªFrase: ${stageDurations.sentenceMs?.toFixed(1) ?? 'N/A'}ms | TTS: ${stageDurations.ttsMs?.toFixed(1) ?? 'N/A'}ms | Envio ESP32: ${stageDurations.dispatchMs?.toFixed(1) ?? 'N/A'}ms | Total (t6-t0): ${stageDurations.totalMs?.toFixed(1) ?? 'N/A'}ms`);

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
    if (espWsClient && isEspWsConnected) {
      try {
        espWsClient.send(JSON.stringify({ cmd: 'speaking_end', speaking: false }));
        espWsClient.send(JSON.stringify({
          cmd: 'conversation_log',
          status: 'error',
          user: 'Áudio captado',
          reply: `Erro: ${err?.message || 'Falha no processamento'}`,
        }));
      } catch {}
    }
    broadcastToClients(JSON.stringify({
      type: 'voice_status',
      state: 'idle',
      message: 'Pronto para ouvir',
    }));
    return { userInputText: '', reply: '', error: err.message || 'Erro no pipeline' };
  }
}

let isBridgeConnecting = false;

function setupEsp32WebSocket(ws: WebSocket, remoteAddress?: string) {
  if (espWsClient && espWsClient !== ws) {
    try {
      (espWsClient as any).removeAllListeners?.();
      espWsClient.close();
    } catch {}
  }

  isBridgeConnecting = false;
  isEspWsConnected = true;
  espWsClient = ws;
  a2dpStreamer.setWsClient(ws);
  console.log(`[ESP32 WS] 🔌 Conexão WebSocket estabelecida com ESP32 (${remoteAddress || ESP32_IP})`);
  broadcastToClients(JSON.stringify({ type: 'hw_status', connected: true, ip: ESP32_IP }));

  if (lastBtConnected) {
    try {
      ws.send(JSON.stringify({ type: 'bt_state', connected: true, deviceName: lastBtDeviceName }));
    } catch {}
  }

  ws.on('message', async (data: any, isBinary: boolean) => {
    console.log(`[ESP32 WS IN] isBinary=${isBinary} len=${data?.length || 0} preview=${data ? data.slice(0, 50).toString() : ''}`);
    let rawBuffer: Buffer | null = null;
    if (isBinary || Buffer.isBuffer(data)) {
      rawBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
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

        // In-Flight VAD: Analisa a energia acústica de cada chunk para corte natural do silêncio
        const chunkRms = calculateBufferRms(rawBuffer);
        if (chunkRms >= 480) {
          activeStreamSession.hasDetectedSpeech = true;
          activeStreamSession.consecutiveSilenceChunks = 0;
        } else if (activeStreamSession.hasDetectedSpeech) {
          activeStreamSession.consecutiveSilenceChunks = (activeStreamSession.consecutiveSilenceChunks || 0) + 1;
          // 22 chunks consecutivos de silêncio (~1408ms) e pelo menos 400ms gravados:
          // Permite pausas naturais na fala, garantindo que o usuário termine a frase completamente antes de processar
          if (activeStreamSession.consecutiveSilenceChunks >= 22 && activeStreamSession.totalBytes >= 6400) {
            const finishedSession = activeStreamSession;
            if (finishedSession.safetyTimer) clearTimeout(finishedSession.safetyTimer);
            activeStreamSession = null;

            console.log(`[VAD Backend] ⚡ Fim de fala detectado por silêncio após ${Math.round(finishedSession.totalBytes / 32)}ms! Finalizando áudio.`);
            const pcmData = Buffer.concat(finishedSession.chunks);
            const wavAudio = addWavHeader(pcmData, 16000, 1, 16);
            finishedSession.trace.mark('t0', performance.now() - 256);
            if (finishedSession.t_first_chunk_received) {
              finishedSession.trace.mark('t1', finishedSession.t_first_chunk_received);
            }
            processVoiceAudioBuffer(wavAudio, finishedSession.trace).catch(() => {});
            return;
          }
        }
      }
      return;
    }

    const textMsg = isBinary ? '' : (Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    if (textMsg.startsWith('{') && textMsg.includes('"type":"audio_stream_')) {
      try {
        const parsed = JSON.parse(textMsg);
        if (parsed.type === 'audio_stream_start') {
          console.log(`[WS Streaming T1] 🎙️ Início de captura de áudio recebido do hardware ESP32!`);
          if (activeInteraction?.isSpeaking) {
            console.log(`[WS Streaming T1] ⚡ Interrupção (Barge-In) detectada no hardware durante reprodução. Interrompendo áudio A2DP.`);
            a2dpStreamer.stop();
          }
          if (activeStreamSession?.safetyTimer) {
            clearTimeout(activeStreamSession.safetyTimer);
          }
          const currentSession: AudioStreamSession = {
            id: `ws_stream_${Date.now()}`,
            chunks: [],
            totalBytes: 0,
            t_stream_start: performance.now(),
            trace: new PipelineTrace(`ws_stream_${Date.now()}`),
            hasDetectedSpeech: false,
            consecutiveSilenceChunks: 0,
          };
          currentSession.safetyTimer = setTimeout(async () => {
            if (activeStreamSession === currentSession) {
              console.warn('[WS Streaming T1] ⚠️ Timeout de segurança (12s). Auto-finalizando captura...');
              const timedOut = activeStreamSession;
              activeStreamSession = null;
              if (timedOut.totalBytes >= 1600) {
                const pcmData = Buffer.concat(timedOut.chunks);
                const wavAudio = addWavHeader(pcmData, 16000, 1, 16);
                await processVoiceAudioBuffer(wavAudio, timedOut.trace);
              } else {
                broadcastToClients(JSON.stringify({
                  type: 'voice_status',
                  state: 'idle',
                  message: 'Pronto para ouvir',
                }));
              }
            }
          }, 12000);
          activeStreamSession = currentSession;
          broadcastToClients(JSON.stringify({
            type: 'voice_status',
            state: 'recording',
            message: 'Ouvindo fala (microfone ESP32)...',
          }));
          return;
        }

        if (parsed.type === 'audio_stream_cancel' && activeStreamSession) {
          console.log('[WS Streaming T1] Sessão de áudio cancelada pelo hardware (ruído impulsivo descartado).');
          if (activeStreamSession.safetyTimer) clearTimeout(activeStreamSession.safetyTimer);
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
          if (session.safetyTimer) clearTimeout(session.safetyTimer);
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

    if (textMsg.startsWith('{') && textMsg.includes('"type":"bt_scan"')) {
      try {
        const parsed = JSON.parse(textMsg);
        console.log(`[BT-SCAN ESP32] 📡 Encontrado: "${parsed.name}" | MAC: ${parsed.mac} | RSSI: ${parsed.rssi} dBm`);
      } catch {}
    }

    if (textMsg.startsWith('{') && textMsg.includes('"type":"bt_state"')) {
      try {
        const parsed = JSON.parse(textMsg);
        lastBtConnected = !!parsed.connected;
        if (parsed.deviceName || parsed.target) {
          lastBtDeviceName = parsed.deviceName || parsed.target;
        }
        console.log(`[BT-A2DP ESP32] ${parsed.connected ? '✅ CONECTADO À CAIXA DE SOM BLUETOOTH!' : '⚠️ Caixa de som desconectada'}`);
      } catch {}
    }

    if (textMsg.startsWith('{') && textMsg.includes('"type":"flow_control"')) {
      try {
        const parsed = JSON.parse(textMsg);
        if (typeof parsed.free_bytes === 'number') {
          a2dpStreamer.updateFlowControl(parsed.free_bytes);
        }
      } catch {}
    }

    broadcastToClients(textMsg);
  });

  let isCleanedUp = false;
  const handleDisconnect = (reason?: string) => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    if (espWsClient === ws) {
      espWsClient = null;
      isEspWsConnected = false;
      console.log(`[ESP32 WS] Desconectado do hardware (${reason || 'close'}).`);
      a2dpStreamer.setWsClient(null);
      a2dpStreamer.stop();
      if (activeStreamSession?.safetyTimer) {
        clearTimeout(activeStreamSession.safetyTimer);
      }
      activeStreamSession = null;
      // Debounce antes de marcar como offline para permitir reconexão sem piscar a interface
      setTimeout(() => {
        if (!isEspWsConnected) {
          lastBtConnected = false;
          broadcastToClients(JSON.stringify({ type: 'hw_status', connected: false, ip: ESP32_IP }));
          broadcastToClients(JSON.stringify({ type: 'bt_state', connected: false, deviceName: lastBtDeviceName }));
        }
      }, 4000);
      setTimeout(startEsp32Bridge, 2500);
    }
    try { ws.terminate(); } catch {}
  };

  ws.on('close', (code, reason) => {
    handleDisconnect(`close code: ${code}, reason: ${reason?.toString() || 'none'}`);
  });

  ws.on('error', (err) => {
    handleDisconnect(`error: ${err?.message || 'unknown'}`);
  });
}

// Inbound WebSocket Server para o ESP32 conectar ativamente via ws://<PC_IP>:8080/api/esp32/ws
const espWss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    for (const p of protocols) return p;
    return false;
  },
});

espWss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress?.replace(/^.*:/, '') || ESP32_IP;
  if (ip && ip !== '127.0.0.1' && ip !== 'localhost') {
    ESP32_IP = ip;
  }
  setupEsp32WebSocket(ws as any, ip);
});

function startEsp32Bridge() {
  // O ESP32 conecta de forma proativa ao servidor em ws://<PC_IP>:8080/api/esp32/ws.
  // Ponte de saída para a porta 81 mantida apenas se expressamente habilitada.
  if (process.env.ENABLE_PORT_81_BRIDGE !== 'true') return;
  if (isBridgeConnecting || isEspWsConnected) return;
  isBridgeConnecting = true;

  const wsUrl = `ws://${ESP32_IP}:81/ws`;
  try {
    const ws = new WebSocket(wsUrl);

    const connectTimeout = setTimeout(() => {
      if (!isEspWsConnected) {
        isBridgeConnecting = false;
        try { ws.terminate(); } catch {}
      }
    }, 5000);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      setupEsp32WebSocket(ws, ESP32_IP);
    });

    ws.on('error', () => {
      clearTimeout(connectTimeout);
      isBridgeConnecting = false;
    });
  } catch (err) {
    isBridgeConnecting = false;
  }
}

// O ESP32 conecta como WebSocket client em /api/esp32/ws
if (process.env.ENABLE_PORT_81_BRIDGE === 'true') {
  startEsp32Bridge();
  setInterval(() => {
    if (!isEspWsConnected && !isBridgeConnecting) {
      startEsp32Bridge();
    }
  }, 5000);
}

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
    req.socket?.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'init', connected: isEspWsConnected, ip: ESP32_IP })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'bt_state', connected: lastBtConnected, deviceName: lastBtDeviceName })}\n\n`);
    sseClients.add(res);

    res.on('error', () => {
      sseClients.delete(res);
    });
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // =========================================================================
  // API: Status e Conexão Bluetooth ESP32
  // =========================================================================
  if (pathname === '/api/bt/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: lastBtConnected,
      deviceName: lastBtDeviceName,
      espConnected: isEspWsConnected,
      espIp: ESP32_IP,
    }));
    return;
  }

  if (pathname === '/api/bt/connect' && req.method === 'POST') {
    if (espWsClient && isEspWsConnected) {
      try {
        let mac: string | undefined;
        let name: string | undefined;
        try {
          const raw = await parseBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          mac = body.mac;
          name = body.name;
        } catch {}
        espWsClient.send(JSON.stringify({ cmd: 'connect_bt', mac, name }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Comando de conexão enviado ao ESP32', mac, name }));
        return;
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ESP32 não conectado no momento' }));
    return;
  }

  if (pathname === '/api/bt/scan' && req.method === 'POST') {
    if (espWsClient && isEspWsConnected) {
      try {
        espWsClient.send(JSON.stringify({ cmd: 'scan_bt' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Comando de busca de dispositivos enviado ao ESP32' }));
        return;
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ESP32 não conectado no momento' }));
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
  // API: Histórico da Conversação para Monitoramento e Devolução
  // =========================================================================
  if (pathname === '/api/conversation/history' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      requireWakeWord,
      history: conversationHistory,
    }));
    return;
  }

  if (pathname === '/api/conversation/clear' && req.method === 'POST') {
    clearConversationHistory();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Histórico limpo com sucesso' }));
    return;
  }

  // =========================================================================
  // API: Previsão e Clima em Tempo Real via Open-Meteo (/api/weather)
  // =========================================================================
  if (pathname === '/api/weather' && req.method === 'GET') {
    const city = urlObj.searchParams.get('city') || 'Juiz de Fora';
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`;
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(3500) });
      const geoData: any = await geoRes.json();

      if (geoData?.results && geoData.results.length > 0) {
        const loc = geoData.results[0];
        const lat = loc.latitude;
        const lon = loc.longitude;
        const resolvedName = loc.name;
        const stateName = loc.admin1 || '';

        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=auto&past_days=1`;
        const weatherRes = await fetch(weatherUrl, { signal: AbortSignal.timeout(4000) });
        const data: any = await weatherRes.json();

        const current = data.current || {};
        const daily = data.daily || {};

        const rainTodayMm = Number(daily.precipitation_sum?.[1] ?? current.precipitation ?? 0);
        const tempAtual = Math.round(current.temperature_2m ?? 22);
        const code = current.weather_code ?? 2;

        const dayNames = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
        const forecastPills = [];
        if (daily.time && Array.isArray(daily.time)) {
          for (let i = 1; i <= Math.min(5, daily.time.length - 1); i++) {
            const dateStr = daily.time[i];
            const d = new Date(dateStr + 'T12:00:00');
            const dayLabel = dayNames[d.getDay()];
            const min = Math.round(daily.temperature_2m_min?.[i] ?? 16);
            const max = Math.round(daily.temperature_2m_max?.[i] ?? 24);
            const wCode = daily.weather_code?.[i] ?? 1;
            forecastPills.push({
              day: dayLabel,
              min,
              max,
              weatherCode: wCode,
              tempRange: `${max}°/${min}°`,
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          city: resolvedName,
          state: stateName,
          temperature: `${tempAtual}°C`,
          tempNumber: tempAtual,
          apparentTemperature: `${Math.round(current.apparent_temperature ?? tempAtual)}°C`,
          humidity: `${current.relative_humidity_2m ?? 70}%`,
          weatherCode: code,
          rainTodayMm: Math.round(rainTodayMm * 10) / 10,
          hasRain: rainTodayMm > 0.5,
          forecast: forecastPills,
        }));
        return;
      }
    } catch (e: any) {
      console.warn('[API /api/weather Erro]', e);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      city,
      temperature: '22°C',
      tempNumber: 22,
      forecast: [],
    }));
    return;
  }

  // =========================================================================
  // API: Auto-Descoberta e Registro Dinâmico do ESP32 (/api/esp32/register)
  // =========================================================================
  if (pathname === '/api/esp32/register') {
    const queryIp = urlObj.searchParams.get('ip') || req.socket.remoteAddress?.replace(/^.*:/, '');
    if (queryIp && queryIp !== '127.0.0.1' && queryIp !== 'localhost') {
      ESP32_IP = queryIp;
      console.log(`[ESP32 Auto-Discovery] 📡 ESP32 registrado automaticamente com IP: ${ESP32_IP}`);
      if (!isEspWsConnected) {
        startEsp32Bridge();
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, registeredIp: ESP32_IP }));
    return;
  }

  // =========================================================================
  // API: Configurações de Ativação por Voz (Wake-Word)
  // =========================================================================
  if (pathname === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requireWakeWord,
      model: GROQ_MODEL,
      espIp: ESP32_IP,
    }));
    return;
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    try {
      const rawBody = await parseBody(req);
      const body = JSON.parse(rawBody.toString('utf8') || '{}');
      if (typeof body.requireWakeWord === 'boolean') {
        requireWakeWord = body.requireWakeWord;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, requireWakeWord, model: GROQ_MODEL }));
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
        if (activeInteraction) {
          activeInteraction.isSpeaking = false;
          activeInteraction.speakingUntil = 0;
        }
        lastSpeakerActiveTime = 0;
        lastConversationActivity = Date.now();
      } else {
        const dur = durationMs || 4000;
        if (activeInteraction) {
          activeInteraction.isSpeaking = true;
          activeInteraction.speakingUntil = Date.now() + dur;
        }
        lastSpeakerActiveTime = Date.now() + dur;
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

      if (pipelineResult.agentResult.textResponse) {
        recordEvaSpeech(pipelineResult.agentResult.textResponse);
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
        res.end(JSON.stringify({ error: 'Texto não fornecido' }));
        return;
      }

      recordEvaSpeech(text);

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

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  console.log(`[HTTP UPGRADE] 🔌 Inbound WS upgrade: ${urlObj.pathname} de ${req.socket.remoteAddress}`);
  if (urlObj.pathname === '/api/esp32/ws' || urlObj.pathname === '/ws') {
    espWss.handleUpgrade(req, socket, head, (ws) => {
      espWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 EVA Voice Assistant Engine rodando na porta ${PORT}`);
  console.log(`🔗 Interface Web: http://localhost:${PORT}`);
  console.log(`🤖 Modelo LLM Primário: ${GROQ_MODEL} (Groq)`);
  console.log(`🛡️ Fallback LLM: ${GEMINI_API_KEY ? 'Ativo (Gemini)' : 'Desativado'}`);
  console.log(`🎙️ Provedor STT Primário: ${DEEPGRAM_API_KEY ? 'Deepgram Nova-2 (Streaming WS / REST)' : 'Groq Whisper-large-v3-turbo'}`);
  console.log(`🎙️ Microfone ESP32: ws://${ESP32_IP}/ws`);
  console.log(`======================================================\n`);

  // Task 4 (P2): Pré-aquecimento das conexões de rede no boot
  voicePipeline.prewarm().then((metrics) => {
    console.log(`[Task 4 Pre-Warm] Conexões ativas e pré-aquecidas: TTS: ${metrics.ttsMs}ms | STT: ${metrics.sttMs}ms | LLM: ${metrics.llmMs}ms.`);
    console.log(`[Task 4 Pre-Warm] Overhead de setup nas interações do usuário: 0ms (TLS/TCP/WS aquecidos).`);
  }).catch((err) => {
    console.warn('[Task 4 Pre-Warm] Aviso ao pré-aquecer:', err);
  });
});

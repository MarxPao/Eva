import { AgentEngine } from '../core/agent/agent-engine';
import { AgentRunResult, InterruptedContext } from '../core/agent/types';
import { FallbackOrchestrator } from '../core/providers/fallback-orchestrator';
import { STTProvider, TTSProvider, ChatMessage } from '../core/providers/types';
import { CostTracker } from '../core/instrumentation/cost-tracker';
import { ConfirmationRequest } from '../core/tools/types';
import { InteractionTelemetry } from '../domain/types';
import { PipelineTrace } from '../core/instrumentation/trace-logger';

export interface VoicePipelineConfig {
  agentEngine: AgentEngine;
  sttOrchestrator: FallbackOrchestrator<STTProvider>;
  ttsOrchestrator: FallbackOrchestrator<TTSProvider>;
  costTracker?: CostTracker;
}

export interface VoicePipelineOptions {
  interactionId?: string;
  userId?: string;
  confirmed?: boolean;
  synthesizeAudio?: boolean; // Padrão true
  trace?: PipelineTrace;
  abortSignal?: AbortSignal;
  interruptedFrom?: InterruptedContext;
  onSentenceAudio?: (audioChunk: Buffer, sentenceIndex: number) => void;
  onToken?: (token: string) => void;
}

export interface VoicePipelineResult {
  interactionId: string;
  userInputText: string;
  responseAudioBuffer?: Buffer;
  agentResult: AgentRunResult;
  telemetry: InteractionTelemetry;
}

export class VoicePipeline {
  private readonly agentEngine: AgentEngine;
  private readonly sttOrchestrator: FallbackOrchestrator<STTProvider>;
  private readonly ttsOrchestrator: FallbackOrchestrator<TTSProvider>;
  private readonly costTracker: CostTracker;

  constructor(config: VoicePipelineConfig) {
    this.agentEngine = config.agentEngine;
    this.sttOrchestrator = config.sttOrchestrator;
    this.ttsOrchestrator = config.ttsOrchestrator;
    this.costTracker = config.costTracker ?? new CostTracker();
  }

  /**
   * Processa uma entrada de áudio bruto capturada pelo microfone I2S do hardware ESP32.
   * Executa: STT (Whisper) ➔ Agent Loop (com Tool Use) ➔ TTS (Voz) ➔ Telemetria consolidada.
   */
  public async processAudio(
    audioBuffer: Buffer,
    history: ChatMessage[] = [],
    options: VoicePipelineOptions = {}
  ): Promise<VoicePipelineResult> {
    const totalStartTime = Date.now();
    const interactionId =
      options.interactionId || `voice_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // 1. Transcrição (STT) com fallback
    const sttStartTime = Date.now();
    const sttResult = await this.sttOrchestrator.execute(
      (stt) => stt.transcribe(audioBuffer, { language: 'pt' }),
      'STT_Transcription'
    );
    const sttLatencyMs = Date.now() - sttStartTime;
    const transcribedText = sttResult.result.text;

    // 2. Raciocínio Agentic (LLM + Ferramentas)
    const agentResult = await this.agentEngine.run(transcribedText, history, {
      ...options,
      interactionId,
    });

    // 3. Síntese de Voz (TTS) com fallback
    let responseAudioBuffer: Buffer | undefined;
    let ttsLatencyMs = 0;
    let ttsChars = 0;
    const shouldSynthesize = options.synthesizeAudio ?? true;

    if (shouldSynthesize && agentResult.textResponse) {
      const ttsStartTime = Date.now();
      const ttsResult = await this.ttsOrchestrator.execute(
        (tts) => tts.synthesize(agentResult.textResponse),
        'TTS_Synthesis'
      );
      ttsLatencyMs = Date.now() - ttsStartTime;
      responseAudioBuffer = ttsResult.result.audioBuffer;
      ttsChars = ttsResult.result.characterCount;
    }

    const totalLatencyMs = Date.now() - totalStartTime;

    // 4. Consolidação final da telemetria de custos do ciclo de voz
    const costs = this.costTracker.computeTotalBreakdown({
      llmModelKey: `${agentResult.telemetry.providerUsed.llm}:${this.agentEngine['llmOrchestrator'].getPrimary().model}`,
      inputTokens: agentResult.telemetry.costs.llm.inputTokens,
      outputTokens: agentResult.telemetry.costs.llm.outputTokens,
      sttProviderKey: sttResult.providerUsed,
      sttDurationSeconds: sttResult.result.durationSeconds,
      ttsProviderKey: this.ttsOrchestrator.getPrimary().name,
      ttsCharacterCount: ttsChars,
    });

    this.costTracker.logCostEvent(interactionId, costs);

    const telemetry: InteractionTelemetry = {
      interactionId,
      timestamp: new Date(),
      providerUsed: {
        llm: agentResult.telemetry.providerUsed.llm,
        stt: sttResult.providerUsed,
        tts: this.ttsOrchestrator.getPrimary().name,
      },
      fallbackTriggered: sttResult.fallbackTriggered || agentResult.telemetry.fallbackTriggered,
      costs,
      latency: {
        sttMs: sttLatencyMs,
        llmMs: agentResult.telemetry.latency.totalMs,
        ttsMs: ttsLatencyMs,
        totalMs: totalLatencyMs,
      },
    };

    return {
      interactionId,
      userInputText: transcribedText,
      responseAudioBuffer,
      agentResult,
      telemetry,
    };
  }

  /**
   * Processa texto direto (ex: interface web ou console).
   */
  public async processText(
    inputText: string,
    history: ChatMessage[] = [],
    options: VoicePipelineOptions = {}
  ): Promise<VoicePipelineResult> {
    const totalStartTime = Date.now();
    const interactionId =
      options.interactionId || `text_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const shouldSynthesize = options.synthesizeAudio ?? true;
    const sentenceAudioBuffers: Buffer[] = [];
    const sentencePromises: Promise<void>[] = [];
    let firstSentenceAudioResolved = false;
    let totalTtsChars = 0;
    const ttsStartTime = Date.now();

    let hasMarkedT3 = false;
    const handleToken = (token: string) => {
      if (!hasMarkedT3 && token) {
        hasMarkedT3 = true;
        if (options.trace) {
          options.trace.mark('t3');
        }
      }
      if (options.onToken) {
        options.onToken(token);
      }
    };

    const handleSentence = (sentence: string, index: number) => {
      if (!shouldSynthesize || !sentence.trim() || options.abortSignal?.aborted) return;

      if (index === 0 && options.trace) {
        options.trace.mark('t4');
      }

      totalTtsChars += sentence.length;
      const synthPromise = this.ttsOrchestrator
        .execute((tts) => tts.synthesize(sentence), 'TTS_Sentence_Synthesis')
        .then((ttsRes) => {
          if (options.abortSignal?.aborted) return;
          if (!firstSentenceAudioResolved) {
            firstSentenceAudioResolved = true;
            if (options.trace) {
              options.trace.mark('t5');
            }
          }
          sentenceAudioBuffers[index] = ttsRes.result.audioBuffer;
          if (options.onSentenceAudio) {
            options.onSentenceAudio(ttsRes.result.audioBuffer, index);
          }
        })
        .catch((err) => {
          if (!options.abortSignal?.aborted) {
            console.error(`[TTS Pipeline Error] Falha na síntese da frase ${index}:`, err);
          }
        });

      sentencePromises.push(synthPromise);
    };

    // Raciocínio Agentic com streaming de sentenças
    const agentResult = await this.agentEngine.run(inputText, history, {
      ...options,
      interactionId,
      onToken: handleToken,
      onSentence: handleSentence,
    });

    if (!hasMarkedT3 && options.trace) {
      options.trace.mark('t3');
    }

    let ttsLatencyMs = 0;
    let responseAudioBuffer: Buffer | undefined;

    if (options.abortSignal?.aborted) {
      return {
        interactionId,
        userInputText: inputText,
        agentResult,
        telemetry: agentResult.telemetry,
      };
    }

    if (sentencePromises.length > 0) {
      await Promise.all(sentencePromises);
      if (options.abortSignal?.aborted) {
        return {
          interactionId,
          userInputText: inputText,
          agentResult,
          telemetry: agentResult.telemetry,
        };
      }
      ttsLatencyMs = Date.now() - ttsStartTime;
      const validBuffers = sentenceAudioBuffers.filter(Boolean);
      if (validBuffers.length > 0) {
        responseAudioBuffer = Buffer.concat(validBuffers);
      }
    } else if (shouldSynthesize && agentResult.textResponse && !options.abortSignal?.aborted) {
      // Fallback em bloco caso nenhuma frase tenha sido emitida via streaming
      if (options.trace) options.trace.mark('t4');
      const startTtsBlock = Date.now();
      const ttsResult = await this.ttsOrchestrator.execute(
        (tts) => tts.synthesize(agentResult.textResponse),
        'TTS_Synthesis'
      );
      ttsLatencyMs = Date.now() - startTtsBlock;
      responseAudioBuffer = ttsResult.result.audioBuffer;
      totalTtsChars = ttsResult.result.characterCount;
      if (options.trace) options.trace.mark('t5');
      if (options.onSentenceAudio && responseAudioBuffer && !options.abortSignal?.aborted) {
        options.onSentenceAudio(responseAudioBuffer, 0);
      }
    }

    const totalLatencyMs = Date.now() - totalStartTime;

    const costs = this.costTracker.computeTotalBreakdown({
      llmModelKey: `${agentResult.telemetry.providerUsed.llm}:${this.agentEngine['llmOrchestrator'].getPrimary().model}`,
      inputTokens: agentResult.telemetry.costs.llm.inputTokens,
      outputTokens: agentResult.telemetry.costs.llm.outputTokens,
      ttsProviderKey: this.ttsOrchestrator.getPrimary().name,
      ttsCharacterCount: totalTtsChars || agentResult.textResponse.length,
    });

    const telemetry: InteractionTelemetry = {
      interactionId,
      timestamp: new Date(),
      providerUsed: {
        llm: agentResult.telemetry.providerUsed.llm,
        tts: this.ttsOrchestrator.getPrimary().name,
      },
      fallbackTriggered: agentResult.telemetry.fallbackTriggered,
      costs,
      latency: {
        llmMs: agentResult.telemetry.latency.totalMs,
        ttsMs: ttsLatencyMs,
        totalMs: totalLatencyMs,
      },
    };

    return {
      interactionId,
      userInputText: inputText,
      responseAudioBuffer,
      agentResult,
      telemetry,
    };
  }

  /**
   * Confirma e executa ação sensível pendente.
   */
  public async confirmAction(
    pendingConfirmation: ConfirmationRequest,
    history: ChatMessage[] = [],
    options: VoicePipelineOptions = {}
  ): Promise<VoicePipelineResult> {
    const totalStartTime = Date.now();
    const interactionId =
      options.interactionId || `conf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const agentResult = await this.agentEngine.confirmAction(
      pendingConfirmation,
      history,
      {
        ...options,
        interactionId,
      }
    );

    let responseAudioBuffer: Buffer | undefined;
    let ttsLatencyMs = 0;
    let ttsChars = 0;
    const shouldSynthesize = options.synthesizeAudio ?? true;

    if (shouldSynthesize && agentResult.textResponse) {
      const ttsStartTime = Date.now();
      const ttsResult = await this.ttsOrchestrator.execute(
        (tts) => tts.synthesize(agentResult.textResponse),
        'TTS_Synthesis'
      );
      ttsLatencyMs = Date.now() - ttsStartTime;
      responseAudioBuffer = ttsResult.result.audioBuffer;
      ttsChars = ttsResult.result.characterCount;
    }

    const totalLatencyMs = Date.now() - totalStartTime;

    const costs = this.costTracker.computeTotalBreakdown({
      llmModelKey: `${agentResult.telemetry.providerUsed.llm}:${this.agentEngine['llmOrchestrator'].getPrimary().model}`,
      inputTokens: agentResult.telemetry.costs.llm.inputTokens,
      outputTokens: agentResult.telemetry.costs.llm.outputTokens,
      ttsProviderKey: this.ttsOrchestrator.getPrimary().name,
      ttsCharacterCount: ttsChars,
    });

    const telemetry: InteractionTelemetry = {
      interactionId,
      timestamp: new Date(),
      providerUsed: {
        llm: agentResult.telemetry.providerUsed.llm,
        tts: this.ttsOrchestrator.getPrimary().name,
      },
      fallbackTriggered: agentResult.telemetry.fallbackTriggered,
      costs,
      latency: {
        llmMs: agentResult.telemetry.latency.totalMs,
        ttsMs: ttsLatencyMs,
        totalMs: totalLatencyMs,
      },
    };

    return {
      interactionId,
      userInputText: 'Confirmação autorizada pelo usuário',
      responseAudioBuffer,
      agentResult,
      telemetry,
    };
  }

  /**
   * Pré-aquece as conexões de rede (TTS, STT, LLM) para eliminar a latência de handshake TLS/TCP.
   * Reduz o overhead de setup de conexão para 0ms nas interações reais.
   */
  public async prewarm(): Promise<{ ttsMs: number; sttMs: number; llmMs: number }> {
    const results = { ttsMs: 0, sttMs: 0, llmMs: 0 };
    const tasks: Promise<void>[] = [];

    // Pre-warm TTS
    const primaryTTS = this.ttsOrchestrator.getPrimary() as any;
    if (typeof primaryTTS.prewarm === 'function') {
      tasks.push(
        primaryTTS.prewarm().then((ms: number) => {
          results.ttsMs = ms;
        }).catch(() => {})
      );
    }

    // Pre-warm STT
    const primarySTT = this.sttOrchestrator.getPrimary() as any;
    if (typeof primarySTT.prewarm === 'function') {
      tasks.push(
        primarySTT.prewarm().then((ms: number) => {
          results.sttMs = ms;
        }).catch(() => {})
      );
    }

    // Pre-warm LLM
    const primaryLLM = (this.agentEngine as any)['llmOrchestrator']?.getPrimary?.() as any;
    if (primaryLLM && typeof primaryLLM.prewarm === 'function') {
      tasks.push(
        primaryLLM.prewarm().then((ms: number) => {
          results.llmMs = ms;
        }).catch(() => {})
      );
    }

    await Promise.all(tasks);
    return results;
  }
}

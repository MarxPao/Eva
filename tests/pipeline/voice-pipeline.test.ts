import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoicePipeline } from '../../src/pipeline/voice-pipeline';
import { AgentEngine } from '../../src/core/agent/agent-engine';
import { FallbackOrchestrator } from '../../src/core/providers/fallback-orchestrator';
import { STTProvider, TTSProvider, LLMProvider } from '../../src/core/providers/types';
import { createDefaultToolRegistry } from '../../src/tools';
import { ToolExecutor } from '../../src/core/tools/tool-executor';
import { CostTracker } from '../../src/core/instrumentation/cost-tracker';

describe('VoicePipeline (Pipeline de Voz Ponta a Ponta)', () => {
  let mockLLM: LLMProvider;
  let mockSTT: STTProvider;
  let mockTTS: TTSProvider;
  let pipeline: VoicePipeline;

  beforeEach(() => {
    mockLLM = {
      name: 'groq',
      model: 'qwen/qwen3.8-27b',
      generate: vi.fn().mockResolvedValue({
        content: 'Olá! A temperatura em São Paulo é 24 graus.',
        usage: { inputTokens: 50, outputTokens: 15 },
        provider: 'groq',
        model: 'qwen/qwen3.8-27b',
        latencyMs: 120,
      }),
      isHealthy: async () => true,
    };

    mockSTT = {
      name: 'groq:whisper',
      transcribe: vi.fn().mockResolvedValue({
        text: 'Qual a temperatura em São Paulo?',
        durationSeconds: 2.5,
        provider: 'groq:whisper',
        latencyMs: 300,
      }),
      isHealthy: async () => true,
    };

    mockTTS = {
      name: 'edge-tts',
      synthesize: vi.fn().mockResolvedValue({
        audioBuffer: Buffer.from('mock-mp3-audio-data'),
        characterCount: 42,
        provider: 'edge-tts',
        latencyMs: 180,
      }),
      isHealthy: async () => true,
    };

    const llmOrchestrator = new FallbackOrchestrator(mockLLM);
    const sttOrchestrator = new FallbackOrchestrator(mockSTT);
    const ttsOrchestrator = new FallbackOrchestrator(mockTTS);
    const registry = createDefaultToolRegistry();
    const executor = new ToolExecutor(registry);
    const costTracker = new CostTracker();

    const agentEngine = new AgentEngine({
      llmOrchestrator,
      registry,
      executor,
      costTracker,
    });

    pipeline = new VoicePipeline({
      agentEngine,
      sttOrchestrator,
      ttsOrchestrator,
      costTracker,
    });
  });

  it('deve processar texto sintetizando áudio e telemetria completa', async () => {
    const result = await pipeline.processText('Qual a temperatura em São Paulo?');

    expect(result.userInputText).toBe('Qual a temperatura em São Paulo?');
    expect(result.agentResult.textResponse).toBe('Olá! A temperatura em São Paulo é 24 graus.');
    expect(result.responseAudioBuffer).toBeDefined();
    expect(result.responseAudioBuffer?.toString()).toBe('mock-mp3-audio-data');
    expect(result.telemetry.costs.totalCostUSD).toBeGreaterThan(0);
    expect(result.telemetry.latency.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('deve processar buffer de áudio do microfone passando por STT, Agent e TTS', async () => {
    const fakeAudioInput = Buffer.alloc(16000 * 2); // 1 segundo de PCM simulado
    const result = await pipeline.processAudio(fakeAudioInput);

    expect(result.userInputText).toBe('Qual a temperatura em São Paulo?');
    expect(mockSTT.transcribe).toHaveBeenCalled();
    expect(mockLLM.generate).toHaveBeenCalled();
    expect(mockTTS.synthesize).toHaveBeenCalledWith('Olá! A temperatura em São Paulo é 24 graus.');
    expect(result.telemetry.costs.stt.durationSeconds).toBe(2.5);
    expect(result.telemetry.latency.sttMs).toBeGreaterThanOrEqual(0);
  });
});

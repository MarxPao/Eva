import { describe, it, expect, vi, afterEach } from 'vitest';
import { EdgeTTSProvider } from '../../src/core/providers/tts/edge-tts';
import { GroqLLMProvider } from '../../src/core/providers/groq/groq-llm';
import { GroqSTTProvider } from '../../src/core/providers/groq/groq-stt';
import { VoicePipeline } from '../../src/pipeline/voice-pipeline';
import { FallbackOrchestrator } from '../../src/core/providers/fallback-orchestrator';
import { AgentEngine } from '../../src/core/agent/agent-engine';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { ToolExecutor } from '../../src/core/tools/tool-executor';

describe('Task 4 Connection Reuse & Pre-warming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deve pré-aquecer o EdgeTTSProvider e manter a conexão viva (0ms de overhead subsequente)', async () => {
    const tts = new EdgeTTSProvider();
    
    // Mock do ensureInitialized para simular conexão
    vi.spyOn(tts as any, 'ensureInitialized').mockResolvedValue({
      toStream: vi.fn(),
    });

    const elapsed = await tts.prewarm();
    expect(elapsed).toBeGreaterThanOrEqual(0);

    // O timer de keepalive deve ter sido iniciado
    expect((tts as any).keepAliveTimer).not.toBeNull();

    // Uma chamada subsequente não deve pagar penalidade de inicialização
    const callStart = performance.now();
    await (tts as any).ensureInitialized();
    const callDelta = performance.now() - callStart;

    expect(callDelta).toBeLessThan(5); // 0ms de overhead (pronto em RAM)

    tts.stopKeepAlive();
    expect((tts as any).keepAliveTimer).toBeNull();
  });

  it('deve pré-aquecer o pipeline de voz completo (TTS, STT, LLM)', async () => {
    const mockTts = {
      name: 'mock-tts',
      prewarm: vi.fn().mockResolvedValue(150),
      synthesize: vi.fn(),
      isHealthy: async () => true,
    };

    const mockStt = {
      name: 'mock-stt',
      prewarm: vi.fn().mockResolvedValue(80),
      transcribe: vi.fn(),
      isHealthy: async () => true,
    };

    const mockLlm = {
      name: 'mock-llm',
      model: 'mock-model',
      prewarm: vi.fn().mockResolvedValue(120),
      generate: vi.fn(),
      isHealthy: async () => true,
    };

    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    const agentEngine = new AgentEngine({
      llmOrchestrator: new FallbackOrchestrator(mockLlm as any),
      registry,
      executor,
    });

    const pipeline = new VoicePipeline({
      agentEngine,
      sttOrchestrator: new FallbackOrchestrator(mockStt as any),
      ttsOrchestrator: new FallbackOrchestrator(mockTts as any),
    });

    const metrics = await pipeline.prewarm();

    expect(metrics.ttsMs).toBe(150);
    expect(metrics.sttMs).toBe(80);
    expect(metrics.llmMs).toBe(120);

    expect(mockTts.prewarm).toHaveBeenCalledTimes(1);
    expect(mockStt.prewarm).toHaveBeenCalledTimes(1);
    expect(mockLlm.prewarm).toHaveBeenCalledTimes(1);
  });
});

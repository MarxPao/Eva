import { describe, it, expect, vi } from 'vitest';
import { VoicePipeline } from '../../src/pipeline/voice-pipeline';
import { PipelineTrace } from '../../src/core/instrumentation/trace-logger';
import { FallbackOrchestrator } from '../../src/core/providers/fallback-orchestrator';
import { LLMProvider, STTProvider, TTSProvider } from '../../src/core/providers/types';
import { AgentEngine } from '../../src/core/agent/agent-engine';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { ToolExecutor } from '../../src/core/tools/tool-executor';
import { CostTracker } from '../../src/core/instrumentation/cost-tracker';

describe('Task 3 Pipelined Sentence Boundary TTS', () => {
  it('deve disparar a síntese da frase 1 assim que o primeiro delimitador for detectado, sem esperar o fim do LLM', async () => {
    const trace = new PipelineTrace('test_task3_pipelined');
    const t0 = performance.now();
    trace.mark('t0', t0);
    trace.mark('t1', t0 - 1500);
    trace.mark('t2', t0 + 200);

    const synthesizedSentences: string[] = [];

    // Mock do LLM que simula stream token por token
    const mockLlm: LLMProvider = {
      name: 'mock-llm',
      model: 'mock-model',
      generate: async (_messages, options) => {
        // Simula tokens chegando com atrasos realistas
        if (options?.onToken) {
          options.onToken('Olá!');
          options.onToken(' ');
          options.onToken('Esta');
          options.onToken(' é');
          options.onToken(' a');
          options.onToken(' primeira');
          options.onToken(' frase.');
          // Frase 1 concluída aqui! O TTS já deve ter sido disparado.
          options.onToken(' ');
          options.onToken('E');
          options.onToken(' aqui');
          options.onToken(' temos');
          options.onToken(' a');
          options.onToken(' segunda');
          options.onToken(' frase.');
        }
        return {
          content: 'Olá! Esta é a primeira frase. E aqui temos a segunda frase.',
          usage: { inputTokens: 20, outputTokens: 15 },
          provider: 'mock-llm',
          model: 'mock-model',
          latencyMs: 50,
        };
      },
      isHealthy: async () => true,
    };

    // Mock do TTS
    const mockTts: TTSProvider = {
      name: 'mock-tts',
      synthesize: async (text) => {
        synthesizedSentences.push(text);
        return {
          audioBuffer: Buffer.alloc(1024),
          characterCount: text.length,
          provider: 'mock-tts',
          latencyMs: 25,
        };
      },
      isHealthy: async () => true,
    };

    const mockStt: STTProvider = {
      name: 'mock-stt',
      transcribe: async () => ({
        text: 'teste',
        durationSeconds: 1,
        provider: 'mock-stt',
        latencyMs: 10,
      }),
      isHealthy: async () => true,
    };

    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    const agentEngine = new AgentEngine({
      llmOrchestrator: new FallbackOrchestrator(mockLlm),
      registry,
      executor,
    });

    const pipeline = new VoicePipeline({
      agentEngine,
      sttOrchestrator: new FallbackOrchestrator(mockStt),
      ttsOrchestrator: new FallbackOrchestrator(mockTts),
      costTracker: new CostTracker(),
    });

    const dispatchedAudioChunks: Buffer[] = [];

    const result = await pipeline.processText('olá', [], {
      synthesizeAudio: true,
      trace,
      onSentenceAudio: (chunk) => {
        dispatchedAudioChunks.push(chunk);
      },
    });

    expect(result.agentResult.textResponse).toContain('Olá! Esta é a primeira frase.');
    expect(synthesizedSentences).toHaveLength(2);
    expect(synthesizedSentences[0]).toBe('Olá! Esta é a primeira frase.');
    expect(synthesizedSentences[1]).toBe('E aqui temos a segunda frase.');
    expect(dispatchedAudioChunks).toHaveLength(2);

    // Validação dos checkpoints t3, t4, t5, t6
    const report = trace.report();
    expect(report).toContain('t3: LLM first token');
    expect(report).toContain('t4: LLM first sentence boundary');
    expect(report).toContain('t5: TTS first byte generated');
  });
});

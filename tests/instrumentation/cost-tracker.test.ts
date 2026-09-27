import { describe, it, expect } from 'vitest';
import { CostTracker } from '../../src/core/instrumentation/cost-tracker';

describe('CostTracker (Instrumentação de Custos)', () => {
  const tracker = new CostTracker();

  it('deve calcular corretamente os custos de LLM por tokens', () => {
    // groq:qwen/qwen3.8-27b => $0.20/1M in, $0.60/1M out
    const cost = tracker.calculateLLMCost('groq:qwen/qwen3.8-27b', 1_000, 500);

    expect(cost.inputTokens).toBe(1_000);
    expect(cost.outputTokens).toBe(500);
    // (1000 / 1M * 0.20) + (500 / 1M * 0.60) = 0.0002 + 0.0003 = 0.0005 USD
    expect(cost.costUSD).toBeCloseTo(0.0005, 6);
  });

  it('deve calcular custo de STT por duração de áudio', () => {
    // groq:whisper-large-v3-turbo => $0.111 / 3600s = 0.0000308333... USD/s
    const cost = tracker.calculateSTTCost('groq:whisper-large-v3-turbo', 10);

    expect(cost.durationSeconds).toBe(10);
    expect(cost.costUSD).toBeCloseTo(0.000308, 6);
  });

  it('deve calcular custo de TTS por caracteres (Edge-TTS deve ser zero)', () => {
    const edgeCost = tracker.calculateTTSCost('edge-tts', 250);
    expect(edgeCost.costUSD).toBe(0.0);

    // Cartesia Sonic => $0.075 / 1.000 chars => 100 chars = $0.0075
    const cartesiaCost = tracker.calculateTTSCost('cartesia:sonic', 100);
    expect(cartesiaCost.costUSD).toBeCloseTo(0.0075, 5);
  });

  it('deve consolidar o breakdown completo de custos de uma interação', () => {
    const breakdown = tracker.computeTotalBreakdown({
      llmModelKey: 'groq:qwen/qwen3.8-27b',
      inputTokens: 2_000,
      outputTokens: 800,
      sttProviderKey: 'groq:whisper-large-v3-turbo',
      sttDurationSeconds: 4.5,
      ttsProviderKey: 'edge-tts',
      ttsCharacterCount: 180,
    });

    expect(breakdown.llm.costUSD).toBeGreaterThan(0);
    expect(breakdown.stt.costUSD).toBeGreaterThan(0);
    expect(breakdown.tts.costUSD).toBe(0); // Edge-TTS no MVP
    expect(breakdown.totalCostUSD).toBe(Number((breakdown.llm.costUSD + breakdown.stt.costUSD).toFixed(8)));
  });
});

import { CostBreakdown, LLMCost, STTCost, TTSCost } from '../../domain/types';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface PricingRates {
  llm: Record<string, ModelPricing>;
  stt: Record<string, number>; // Custo por segundo de áudio em USD
  tts: Record<string, number>; // Custo por 1.000 caracteres em USD
}

export const DEFAULT_PRICING: PricingRates = {
  llm: {
    // Groq Qwen 2.5 32B / 70B (Valores de referência de mercado)
    'groq:qwen/qwen3.8-27b': { inputPerMillion: 0.20, outputPerMillion: 0.60 },
    'groq:llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    // Google Gemini 1.5 Flash (Fallback)
    'gemini:gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
    // Default fallback para modelos não cadastrados
    'default': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  },
  stt: {
    // Groq Whisper-large-v3-turbo ($0.111 por hora ~ $0.0000308 por segundo)
    'groq:whisper-large-v3-turbo': 0.111 / 3600,
    // Deepgram Nova-2 ($0.0043 por minuto ~ $0.0000717 por segundo)
    'deepgram:nova-2': 0.0043 / 60,
    'default': 0.00005,
  },
  tts: {
    // Microsoft Edge-TTS (Gratuito / Dívida Técnica)
    'edge-tts': 0.0,
    // Cartesia Sonic ($0.075 por 1.000 caracteres)
    'cartesia:sonic': 0.075 / 1000,
    // ElevenLabs Flash ($0.15 por 1.000 caracteres)
    'elevenlabs:flash': 0.15 / 1000,
    'default': 0.0,
  },
};

export class CostTracker {
  constructor(private readonly pricing: PricingRates = DEFAULT_PRICING) {}

  public calculateLLMCost(modelKey: string, inputTokens: number, outputTokens: number): LLMCost {
    const rate = this.pricing.llm[modelKey] || this.pricing.llm['default'];
    const inputCost = (inputTokens / 1_000_000) * rate.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * rate.outputPerMillion;
    const costUSD = Number((inputCost + outputCost).toFixed(8));

    return {
      inputTokens,
      outputTokens,
      costUSD,
    };
  }

  public calculateSTTCost(providerKey: string, durationSeconds: number): STTCost {
    const ratePerSecond = this.pricing.stt[providerKey] ?? this.pricing.stt['default'];
    const costUSD = Number((durationSeconds * ratePerSecond).toFixed(8));

    return {
      durationSeconds,
      costUSD,
    };
  }

  public calculateTTSCost(providerKey: string, characterCount: number, durationSeconds?: number): TTSCost {
    const ratePerChar = this.pricing.tts[providerKey] ?? this.pricing.tts['default'];
    const costUSD = Number((characterCount * ratePerChar).toFixed(8));

    return {
      characterCount,
      durationSeconds,
      costUSD,
    };
  }

  public computeTotalBreakdown(params: {
    llmModelKey: string;
    inputTokens: number;
    outputTokens: number;
    sttProviderKey?: string;
    sttDurationSeconds?: number;
    ttsProviderKey?: string;
    ttsCharacterCount?: number;
    ttsDurationSeconds?: number;
  }): CostBreakdown {
    const llm = this.calculateLLMCost(params.llmModelKey, params.inputTokens, params.outputTokens);
    const stt = this.calculateSTTCost(
      params.sttProviderKey || 'edge-tts',
      params.sttDurationSeconds || 0
    );
    const tts = this.calculateTTSCost(
      params.ttsProviderKey || 'edge-tts',
      params.ttsCharacterCount || 0,
      params.ttsDurationSeconds
    );

    const totalCostUSD = Number((llm.costUSD + stt.costUSD + tts.costUSD).toFixed(8));

    return {
      llm,
      stt,
      tts,
      totalCostUSD,
    };
  }

  /**
   * Emite log estruturado da telemetria de custo para observabilidade
   */
  public logCostEvent(interactionId: string, breakdown: CostBreakdown): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      interactionId,
      costs: {
        llmUSD: breakdown.llm.costUSD,
        sttUSD: breakdown.stt.costUSD,
        ttsUSD: breakdown.tts.costUSD,
        totalUSD: breakdown.totalCostUSD,
      },
      tokens: {
        in: breakdown.llm.inputTokens,
        out: breakdown.llm.outputTokens,
      },
      voice: {
        sttSeconds: breakdown.stt.durationSeconds,
        ttsChars: breakdown.tts.characterCount,
      },
    };

    console.info(`[COST_TELEMETRY] ${JSON.stringify(logEntry)}`);
  }
}

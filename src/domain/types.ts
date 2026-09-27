/**
 * Tipos de domínio e telemetria da EVA
 */

export interface LLMCost {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface STTCost {
  durationSeconds: number;
  costUSD: number;
}

export interface TTSCost {
  characterCount: number;
  durationSeconds?: number;
  costUSD: number;
}

export interface CostBreakdown {
  llm: LLMCost;
  stt: STTCost;
  tts: TTSCost;
  totalCostUSD: number;
}

export interface InteractionTelemetry {
  interactionId: string;
  timestamp: Date;
  providerUsed: {
    llm: string;
    stt?: string;
    tts?: string;
  };
  fallbackTriggered: boolean;
  costs: CostBreakdown;
  latency: {
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
    toolsMs?: number;
    totalMs: number;
  };
}

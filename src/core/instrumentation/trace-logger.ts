/**
 * Módulo de Instrumentação e Rastreamento de Latência (Checkpoints t0-t6)
 * Conforme especificação Phase 2:
 * t0: end-of-speech detected (VAD cutoff)
 * t1: first byte received at backend
 * t2: STT first partial / STT completion
 * t3: LLM first token
 * t4: LLM first sentence boundary
 * t5: TTS first byte generated
 * t6: first audio byte received by client
 */

export interface PipelineCheckpoints {
  t0?: number; // VAD cutoff
  t1?: number; // First byte received at backend
  t2?: number; // STT completion / first partial
  t3?: number; // LLM first token
  t4?: number; // LLM first sentence boundary
  t5?: number; // TTS first byte generated
  t6?: number; // First audio byte received by client
}

export class PipelineTrace {
  public readonly id: string;
  public readonly checkpoints: PipelineCheckpoints = {};
  public readonly baseTime: number;

  constructor(id: string = `trace_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`) {
    this.id = id;
    this.baseTime = performance.now();
  }

  public mark(checkpoint: keyof PipelineCheckpoints, timestamp?: number): void {
    this.checkpoints[checkpoint] = timestamp ?? performance.now();
  }

  public getDelta(start: keyof PipelineCheckpoints, end: keyof PipelineCheckpoints): number | undefined {
    const s = this.checkpoints[start];
    const e = this.checkpoints[end];
    if (s === undefined || e === undefined) return undefined;
    return e - s;
  }

  public report(): string {
    const c = this.checkpoints;
    const t0 = c.t0 ?? c.t1 ?? this.baseTime;

    const fmt = (val: number | undefined) =>
      val !== undefined ? `+${(val - t0).toFixed(1)} ms` : 'N/A';

    const t6_t0 = c.t6 !== undefined ? `${(c.t6 - t0).toFixed(1)} ms` : 'N/A';

    return [
      `[TRACE] ================= Pipeline Latency Trace (${this.id}) =================`,
      `[TRACE] t0: end-of-speech detected (VAD cutoff) : +0.0 ms`,
      `[TRACE] t1: first byte received at backend      : ${fmt(c.t1)}`,
      `[TRACE] t2: STT first partial / STT completion  : ${fmt(c.t2)}`,
      `[TRACE] t3: LLM first token                     : ${fmt(c.t3)}`,
      `[TRACE] t4: LLM first sentence boundary         : ${fmt(c.t4)}`,
      `[TRACE] t5: TTS first byte generated            : ${fmt(c.t5)}`,
      `[TRACE] t6: first audio byte received by client : ${fmt(c.t6)}`,
      `[TRACE] -------------------------------------------------------------------------`,
      `[TRACE] Total End-to-End Latency (t6 - t0)       : ${t6_t0}`,
      `[TRACE] =========================================================================`,
    ].join('\n');
  }
}

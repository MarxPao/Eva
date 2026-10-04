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

export interface StageDurations {
  uploadMs?: number;    // t1 - t0: tempo até chegada ao backend
  sttMs?: number;       // t2 - t1: duração da transcrição Whisper
  ttftMs?: number;      // t3 - t2: Time-To-First-Token do LLM
  sentenceMs?: number;  // t4 - t3: tempo até fechar a 1ª frase
  ttsMs?: number;       // t5 - t4: síntese TTS da 1ª frase
  dispatchMs?: number;  // t6 - t5: envio do 1º chunk de áudio ao ESP32
  totalMs?: number;     // t6 - t0: latência total fim-a-fim
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

  public getStageDurations(): StageDurations {
    const c = this.checkpoints;
    const t0 = c.t0 ?? c.t1 ?? this.baseTime;
    return {
      uploadMs: c.t1 !== undefined && c.t0 !== undefined ? Math.max(0, c.t1 - c.t0) : undefined,
      sttMs: c.t2 !== undefined ? Math.max(0, c.t2 - (c.t1 ?? t0)) : undefined,
      ttftMs: c.t3 !== undefined && c.t2 !== undefined ? Math.max(0, c.t3 - c.t2) : undefined,
      sentenceMs: c.t4 !== undefined && c.t3 !== undefined ? Math.max(0, c.t4 - c.t3) : undefined,
      ttsMs: c.t5 !== undefined && c.t4 !== undefined ? Math.max(0, c.t5 - c.t4) : undefined,
      dispatchMs: c.t6 !== undefined && c.t5 !== undefined ? Math.max(0, c.t6 - c.t5) : undefined,
      totalMs: c.t6 !== undefined ? Math.max(0, c.t6 - t0) : undefined,
    };
  }

  public report(): string {
    const c = this.checkpoints;
    const t0 = c.t0 ?? c.t1 ?? this.baseTime;

    const fmtOffset = (val: number | undefined) =>
      val !== undefined ? `+${(val - t0).toFixed(1)} ms` : 'N/A';

    const fmtDur = (dur: number | undefined) =>
      dur !== undefined ? `${dur.toFixed(1)} ms` : 'N/A';

    const d = this.getStageDurations();
    const t6_t0 = d.totalMs !== undefined ? `${d.totalMs.toFixed(1)} ms` : (c.t6 !== undefined ? `${(c.t6 - t0).toFixed(1)} ms` : 'N/A');

    return [
      `[TRACE] ================= Pipeline Latency Trace (${this.id}) =================`,
      `[TRACE] t0: end-of-speech detected (VAD cutoff) : +0.0 ms          (fim da fala)`,
      `[TRACE] t1: first byte received at backend      : ${fmtOffset(c.t1).padEnd(16)} (duração rede/ingestão : ${fmtDur(d.uploadMs)})`,
      `[TRACE] t2: STT first partial / STT completion  : ${fmtOffset(c.t2).padEnd(16)} (duração STT Whisper   : ${fmtDur(d.sttMs)})`,
      `[TRACE] t3: LLM first token                     : ${fmtOffset(c.t3).padEnd(16)} (duração 1º token LLM  : ${fmtDur(d.ttftMs)})`,
      `[TRACE] t4: LLM first sentence boundary         : ${fmtOffset(c.t4).padEnd(16)} (duração 1ª frase LLM  : ${fmtDur(d.sentenceMs)})`,
      `[TRACE] t5: TTS first byte generated            : ${fmtOffset(c.t5).padEnd(16)} (duração TTS pronto    : ${fmtDur(d.ttsMs)})`,
      `[TRACE] t6: first audio byte received by client : ${fmtOffset(c.t6).padEnd(16)} (duração envio ao ESP32: ${fmtDur(d.dispatchMs)})`,
      `[TRACE] -------------------------------------------------------------------------`,
      `[TRACE] Total End-to-End Latency (t6 - t0)       : ${t6_t0}`,
      `[TRACE] =========================================================================`,
    ].join('\n');
  }
}

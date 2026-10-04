import { describe, it, expect } from 'vitest';
import { PipelineTrace } from '../../src/core/instrumentation/trace-logger';

describe('PipelineTrace (Instrumentação de Latência Phase 2)', () => {
  it('deve registrar checkpoints t0 a t6 e calcular deltas corretamente', () => {
    const trace = new PipelineTrace('test-trace');
    trace.mark('t0', 1000);
    trace.mark('t1', 1080);
    trace.mark('t2', 1350);
    trace.mark('t3', 1700);
    trace.mark('t4', 1750);
    trace.mark('t5', 2100);
    trace.mark('t6', 2110);

    expect(trace.getDelta('t0', 't1')).toBeCloseTo(80);
    expect(trace.getDelta('t0', 't2')).toBeCloseTo(350);
    expect(trace.getDelta('t0', 't6')).toBeCloseTo(1110);

    const report = trace.report();
    expect(report).toContain('t0: end-of-speech detected');
    expect(report).toContain('t6: first audio byte received by client');
    expect(report).toContain('1110.0 ms');
  });

  it('deve calcular corretamente as durações individuais de cada etapa do pipeline', () => {
    const trace = new PipelineTrace('test-stages');
    trace.mark('t0', 1000);
    trace.mark('t1', 1100); // upload: 100ms
    trace.mark('t2', 1350); // stt: 250ms
    trace.mark('t3', 1550); // ttft: 200ms
    trace.mark('t4', 1600); // sentence: 50ms
    trace.mark('t5', 1900); // tts: 300ms
    trace.mark('t6', 1920); // dispatch: 20ms

    const durations = trace.getStageDurations();
    expect(durations.uploadMs).toBeCloseTo(100);
    expect(durations.sttMs).toBeCloseTo(250);
    expect(durations.ttftMs).toBeCloseTo(200);
    expect(durations.sentenceMs).toBeCloseTo(50);
    expect(durations.ttsMs).toBeCloseTo(300);
    expect(durations.dispatchMs).toBeCloseTo(20);
    expect(durations.totalMs).toBeCloseTo(920);

    const report = trace.report();
    expect(report).toContain('duração STT Whisper   : 250.0 ms');
    expect(report).toContain('Total End-to-End Latency (t6 - t0)       : 920.0 ms');
  });
});

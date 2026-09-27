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
});

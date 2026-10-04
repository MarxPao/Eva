import { describe, it, expect, beforeEach } from 'vitest';
import { consultarLogsSistemaTool } from '../../src/tools/low-risk/consultar-logs-sistema';
import { systemTelemetry, SystemTelemetryStore } from '../../src/core/instrumentation/system-telemetry';
import { ToolExecutionContext } from '../../src/core/tools/types';
import { getEvaSystemPrompt, getDynamicTelemetryContext } from '../../src/core/agent/system-prompt';

describe('consultar_logs_sistema (Auto-acesso da EVA a logs e telemetria)', () => {
  const context: ToolExecutionContext = {
    interactionId: 'test-telemetry-1',
    timestamp: new Date(),
  };

  beforeEach(() => {
    systemTelemetry.clearHistory();
    systemTelemetry.updateHardware({
      esp32Connected: true,
      esp32Ip: '192.168.2.126',
      sampleRate: 16000,
      rms: 1250,
      level: 54,
    });
  });

  it('deve consultar logs e retornar resumo com hardware e status inicial', async () => {
    const res = await consultarLogsSistemaTool.execute({ categoria: 'todos', limite: 5 }, context);

    expect(res.resumo).toBeDefined();
    expect(res.statusHardware.esp32Conectado).toBe(true);
    expect(res.statusHardware.esp32Ip).toBe('192.168.2.126');
    expect(res.statusHardware.taxaAmostragem).toBe(16000);
  });

  it('deve registrar interações com latência e retornar detalhamento por etapa', async () => {
    systemTelemetry.addEntry({
      id: 'voice_test_1',
      timestamp: new Date().toISOString(),
      timeStr: '09:40:00',
      status: 'answered',
      userInput: 'Eva, que horas são?',
      reply: 'Agora são 9h40 da manhã.',
      latencyMs: 1450,
      breakdown: {
        sttMs: 250,
        llmMs: 820,
        ttsMs: 380,
      },
      note: 'Respondido com sucesso',
    });

    const res = await consultarLogsSistemaTool.execute({ categoria: 'latencia', limite: 5 }, context);

    expect(res.ultimaLatencia).toBeDefined();
    expect(res.ultimaLatencia?.totalMs).toBe(1450);
    expect(res.ultimaLatencia?.sttMs).toBe(250);
    expect(res.ultimaLatencia?.llmMs).toBe(820);
    expect(res.ultimaLatencia?.ttsMs).toBe(380);
    expect(res.resumo).toContain('1450ms');
  });

  it('deve calcular médias de latência acumuladas de múltiplos turnos', () => {
    const testStore = new SystemTelemetryStore();
    testStore.clearHistory();

    testStore.addEntry({
      id: 'test_1',
      timestamp: new Date().toISOString(),
      timeStr: '09:41:00',
      status: 'answered',
      userInput: 'Teste 1',
      latencyMs: 1000,
      breakdown: { sttMs: 200, llmMs: 600, ttsMs: 200 },
    });

    testStore.addEntry({
      id: 'test_2',
      timestamp: new Date().toISOString(),
      timeStr: '09:42:00',
      status: 'answered',
      userInput: 'Teste 2',
      latencyMs: 2000,
      breakdown: { sttMs: 400, llmMs: 1200, ttsMs: 400 },
    });

    const summary = testStore.getMetricsSummary();
    expect(summary.mediasLatencia).toBeDefined();
    expect(summary.mediasLatencia?.mediaTotalMs).toBe(1500);
    expect(summary.mediasLatencia?.mediaSttMs).toBe(300);
    expect(summary.mediasLatencia?.mediaLlmMs).toBe(900);
    expect(summary.mediasLatencia?.mediaTtsMs).toBe(300);
    expect(summary.mediasLatencia?.amostras).toBe(2);
  });

  it('deve injetar contexto dinâmico de telemetria no System Prompt da EVA', () => {
    systemTelemetry.addEntry({
      id: 'voice_test_prompt',
      timestamp: new Date().toISOString(),
      timeStr: '09:43:00',
      status: 'answered',
      userInput: 'Eva, qual sua latência?',
      reply: 'Minha latência foi de 1.3 segundos.',
      latencyMs: 1320,
      breakdown: { sttMs: 220, llmMs: 780, ttsMs: 320 },
    });

    const telemetryCtx = getDynamicTelemetryContext();
    expect(telemetryCtx).toContain('MÉTRICAS DO SISTEMA E LOGS EM TEMPO REAL');
    expect(telemetryCtx).toContain('1320ms');
    expect(telemetryCtx).toContain('Whisper');
    expect(telemetryCtx).toContain('consultar_logs_sistema');

    const fullPrompt = getEvaSystemPrompt();
    expect(fullPrompt).toContain('AUTO-ACESSO A LOGS, LATÊNCIA E TELEMETRIA DO SISTEMA');
    expect(fullPrompt).toContain('1320ms');
  });
});

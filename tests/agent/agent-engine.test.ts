import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentEngine } from '../../src/core/agent/agent-engine';
import { FallbackOrchestrator } from '../../src/core/providers/fallback-orchestrator';
import { LLMProvider, LLMCompletionResult } from '../../src/core/providers/types';
import { createDefaultToolRegistry } from '../../src/tools';
import { ToolExecutor } from '../../src/core/tools/tool-executor';
import { SafetyGate } from '../../src/core/tools/safety-gate';
import { CostTracker } from '../../src/core/instrumentation/cost-tracker';

describe('AgentEngine (Loop de Raciocínio da EVA)', () => {
  let mockPrimaryLLM: LLMProvider;
  let mockFallbackLLM: LLMProvider;
  let orchestrator: FallbackOrchestrator<LLMProvider>;
  let registry: ReturnType<typeof createDefaultToolRegistry>;
  let safetyGate: SafetyGate;
  let executor: ToolExecutor;
  let costTracker: CostTracker;
  let engine: AgentEngine;

  beforeEach(() => {
    mockPrimaryLLM = {
      name: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      generate: vi.fn(),
      isHealthy: async () => true,
    };

    mockFallbackLLM = {
      name: 'mock-fallback',
      model: 'gemini-1.5-flash',
      generate: vi.fn(),
      isHealthy: async () => true,
    };

    orchestrator = new FallbackOrchestrator(mockPrimaryLLM, mockFallbackLLM);
    registry = createDefaultToolRegistry();
    safetyGate = new SafetyGate();
    executor = new ToolExecutor(registry, { safetyGate });
    costTracker = new CostTracker();

    engine = new AgentEngine({
      llmOrchestrator: orchestrator,
      registry,
      executor,
      costTracker,
    });
  });

  it('deve processar diálogo direto sem chamada de ferramentas', async () => {
    const directLLMResponse: LLMCompletionResult = {
      content: 'Olá! Sou a EVA. Em que posso te ajudar hoje?',
      usage: { inputTokens: 50, outputTokens: 15 },
      provider: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      latencyMs: 80,
    };

    vi.mocked(mockPrimaryLLM.generate).mockResolvedValueOnce(directLLMResponse);

    const result = await engine.run('Olá, quem é você?');

    expect(result.textResponse).toBe('Olá! Sou a EVA. Em que posso te ajudar hoje?');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.toolExecutions).toHaveLength(0);
    expect(result.telemetry.costs.totalCostUSD).toBeGreaterThan(0);
    expect(result.telemetry.fallbackTriggered).toBe(false);
  });

  it('deve orquestrar chamada de ferramenta (consultar_clima) e sintetizar resposta final', async () => {
    // 1º turno: LLM decide chamar a ferramenta consultar_clima
    const toolCallResponse: LLMCompletionResult = {
      content: null,
      toolCalls: [
        {
          id: 'call_clima_abc',
          name: 'consultar_clima',
          rawArguments: JSON.stringify({ cidade: 'Curitiba', dias: 1 }),
          parsedArguments: { cidade: 'Curitiba', dias: 1 },
        },
      ],
      usage: { inputTokens: 120, outputTokens: 25 },
      provider: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      latencyMs: 95,
    };

    // 2º turno: LLM recebe o resultado da ferramenta e gera resposta natural para voz
    const synthesisResponse: LLMCompletionResult = {
      content: 'Em Curitiba está fazendo 24°C com tempo parcialmente nublado.',
      usage: { inputTokens: 180, outputTokens: 20 },
      provider: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      latencyMs: 85,
    };

    vi.mocked(mockPrimaryLLM.generate)
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce(synthesisResponse);

    const result = await engine.run('Como está o tempo em Curitiba?');

    expect(result.textResponse).toBe('Em Curitiba está fazendo 24°C com tempo parcialmente nublado.');
    expect(result.toolExecutions).toHaveLength(1);
    expect(result.toolExecutions[0].toolName).toBe('consultar_clima');
    expect(result.toolExecutions[0].status).toBe('success');
    expect(result.toolExecutions[0].data).toMatchObject({
      cidade: 'Curitiba',
      temperaturaAtual: expect.stringMatching(/\d+°C/),
    });
    // Verifica que totalizou tokens dos 2 turnos
    expect(result.telemetry.costs.llm.inputTokens).toBe(300);
    expect(result.telemetry.costs.llm.outputTokens).toBe(45);
  }, 15000);

  it('deve suspender o loop e solicitar confirmação expressa ao tentar destrancar fechadura sem autorização prévia', async () => {
    const lockToolCallResponse: LLMCompletionResult = {
      content: null,
      toolCalls: [
        {
          id: 'call_fechadura_1',
          name: 'destrancar_fechadura',
          rawArguments: JSON.stringify({ porta: 'principal' }),
          parsedArguments: { porta: 'principal' },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 20 },
      provider: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      latencyMs: 90,
    };

    vi.mocked(mockPrimaryLLM.generate).mockResolvedValueOnce(lockToolCallResponse);

    const result = await engine.run('EVA, abre a porta principal');

    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingConfirmation).toBeDefined();
    expect(result.pendingConfirmation?.toolName).toBe('destrancar_fechadura');
    expect(result.pendingConfirmation?.prompt).toContain("Você realmente deseja destrancar a fechadura 'principal'?");
    // O loop não deve chamar o LLM pela 2ª vez sem confirmação
    expect(mockPrimaryLLM.generate).toHaveBeenCalledTimes(1);
  });

  it('deve executar ação crítica quando o usuário já concedeu confirmed: true', async () => {
    const lockToolCallResponse: LLMCompletionResult = {
      content: null,
      toolCalls: [
        {
          id: 'call_fechadura_1',
          name: 'destrancar_fechadura',
          rawArguments: JSON.stringify({ porta: 'principal' }),
          parsedArguments: { porta: 'principal' },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 20 },
      provider: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      latencyMs: 90,
    };

    const confirmSynthesis: LLMCompletionResult = {
      content: 'A porta principal foi destrancada com sucesso.',
      usage: { inputTokens: 140, outputTokens: 15 },
      provider: 'mock-primary',
      model: 'qwen/qwen3.8-27b',
      latencyMs: 80,
    };

    vi.mocked(mockPrimaryLLM.generate)
      .mockResolvedValueOnce(lockToolCallResponse)
      .mockResolvedValueOnce(confirmSynthesis);

    const result = await engine.run('Sim, pode abrir', [], { confirmed: true });

    expect(result.requiresConfirmation).toBe(false);
    expect(result.toolExecutions[0].toolName).toBe('destrancar_fechadura');
    expect(result.toolExecutions[0].status).toBe('success');
    expect(result.textResponse).toBe('A porta principal foi destrancada com sucesso.');
  });

  it('deve acionar o fallback de contingência quando o provedor primário falhar', async () => {
    vi.mocked(mockPrimaryLLM.generate).mockRejectedValueOnce(new Error('Groq 503 Service Unavailable'));

    const fallbackResponse: LLMCompletionResult = {
      content: 'Resposta gerada pelo provedor de contingência.',
      usage: { inputTokens: 60, outputTokens: 12 },
      provider: 'mock-fallback',
      model: 'gemini-1.5-flash',
      latencyMs: 150,
    };

    vi.mocked(mockFallbackLLM.generate).mockResolvedValueOnce(fallbackResponse);

    const result = await engine.run('Qual é a capital da França?');

    expect(result.textResponse).toBe('Resposta gerada pelo provedor de contingência.');
    expect(result.telemetry.fallbackTriggered).toBe(true);
    expect(result.telemetry.providerUsed.llm).toBe('mock-fallback');
  });
});

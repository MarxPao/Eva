import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { ToolExecutor } from '../../src/core/tools/tool-executor';
import { ToolDefinition, ToolExecutionContext } from '../../src/core/tools/types';

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  const testContext: ToolExecutionContext = {
    interactionId: 'interaction-xyz',
    timestamp: new Date(),
  };

  const somaTool: ToolDefinition<{ a: number; b: number }, { resultado: number }> = {
    name: 'somar',
    description: 'Soma dois números',
    sensitivity: 'low',
    requiresConfirmation: false,
    schema: z.object({
      a: z.number().describe('Primeiro número'),
      b: z.number().describe('Segundo número'),
    }),
    execute: async (params) => ({
      resultado: params.a + params.b,
    }),
  };

  const hangingTool: ToolDefinition<{ delayMs: number }, string> = {
    name: 'lenta',
    description: 'Ferramenta que demora mais que o permitido',
    sensitivity: 'low',
    requiresConfirmation: false,
    schema: z.object({ delayMs: z.number() }),
    execute: async (params) => {
      await new Promise((resolve) => setTimeout(resolve, params.delayMs));
      return 'concluido';
    },
  };

  const failingTool: ToolDefinition<{ msg: string }, void> = {
    name: 'falhar',
    description: 'Ferramenta que lança erro deliberado',
    sensitivity: 'low',
    requiresConfirmation: false,
    schema: z.object({ msg: z.string() }),
    execute: async (params) => {
      throw new Error(`Erro intencional: ${params.msg}`);
    },
  };

  const sensitiveTool: ToolDefinition<{ porta: string }, { status: string }> = {
    name: 'destrancar_fechadura',
    description: 'Destranca fechadura',
    sensitivity: 'critical',
    requiresConfirmation: true,
    confirmationPrompt: (p) => `Confirma abertura da porta ${p.porta}?`,
    schema: z.object({ porta: z.string().min(1) }),
    execute: async (p) => ({ status: `destrancada ${p.porta}` }),
  };

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([somaTool, hangingTool, failingTool, sensitiveTool]);
    executor = new ToolExecutor(registry, { defaultTimeoutMs: 150 });
  });

  it('deve executar uma ferramenta com sucesso e retornar o resultado tipado', async () => {
    const result = await executor.execute<{ resultado: number }>('somar', { a: 10, b: 32 }, testContext);

    expect(result.status).toBe('success');
    expect(result.data).toEqual({ resultado: 42 });
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('deve retornar falha estruturada quando a ferramenta não existir', async () => {
    const result = await executor.execute('ferramenta_inexistente', {}, testContext);

    expect(result.status).toBe('failure');
    expect(result.error).toContain("Ferramenta 'ferramenta_inexistente' não está registrada");
  });

  it('deve validar argumentos com Zod e retornar erro sem quebrar a execução se parâmetros forem inválidos', async () => {
    // b está ausente e a é string em vez de número
    const result = await executor.execute('somar', { a: 'invalido' }, testContext);

    expect(result.status).toBe('failure');
    expect(result.error).toContain("Falha de validação nos argumentos da ferramenta 'somar'");
    expect(result.data).toBeUndefined();
  });

  it('deve interceptar ferramentas com requiresConfirmation e exigir confirmação', async () => {
    const result = await executor.execute('destrancar_fechadura', { porta: 'principal' }, testContext);

    expect(result.status).toBe('confirmation_required');
    expect(result.confirmation).toBeDefined();
    expect(result.confirmation?.prompt).toBe('Confirma abertura da porta principal?');
    expect(result.confirmation?.parameters).toEqual({ porta: 'principal' });
  });

  it('deve executar a ferramenta sensível se context.confirmed for true', async () => {
    const confirmedCtx: ToolExecutionContext = {
      ...testContext,
      confirmed: true,
    };

    const result = await executor.execute<{ status: string }>('destrancar_fechadura', { porta: 'principal' }, confirmedCtx);

    expect(result.status).toBe('success');
    expect(result.data?.status).toBe('destrancada principal');
  });

  it('deve interromper execução com erro de timeout caso o tempo limite seja excedido', async () => {
    // Tool espera 400ms, mas o timeout configurado é 100ms
    const result = await executor.execute('lenta', { delayMs: 400 }, testContext, 100);

    expect(result.status).toBe('failure');
    expect(result.error).toContain("excedeu o tempo limite de execução (100ms)");
  });

  it('deve capturar exceções internas da ferramenta e encapsular como falha estruturada', async () => {
    const result = await executor.execute('falhar', { msg: 'banco fora do ar' }, testContext);

    expect(result.status).toBe('failure');
    expect(result.error).toContain('Erro intencional: banco fora do ar');
  });
});

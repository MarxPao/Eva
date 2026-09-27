import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SafetyGate } from '../../src/core/tools/safety-gate';
import { ToolDefinition, ToolExecutionContext } from '../../src/core/tools/types';

describe('SafetyGate', () => {
  const gate = new SafetyGate();

  const standardTool: ToolDefinition<{ query: string }, { result: string }> = {
    name: 'pesquisa_simples',
    description: 'Pesquisa comum',
    sensitivity: 'low',
    requiresConfirmation: false,
    schema: z.object({ query: z.string() }),
    execute: async (p) => ({ result: p.query }),
  };

  const sensitiveTool: ToolDefinition<{ door: string }, { status: string }> = {
    name: 'destrancar_porta',
    description: 'Destranca fechadura',
    sensitivity: 'critical',
    requiresConfirmation: true,
    confirmationPrompt: (p) => `Confirma a abertura da porta '${p.door}'?`,
    schema: z.object({ door: z.string() }),
    execute: async (p) => ({ status: `porta ${p.door} aberta` }),
  };

  const baseContext: ToolExecutionContext = {
    interactionId: 'test-interaction-1',
    timestamp: new Date(),
  };

  it('deve liberar execução direta para ferramentas de baixa sensibilidade (sem confirmação)', () => {
    const result = gate.evaluate(standardTool, { query: 'previsão do tempo' }, baseContext);
    expect(result.allowed).toBe(true);
    expect(result.confirmation).toBeUndefined();
  });

  it('deve bloquear e exigir confirmação para ferramentas críticas quando context.confirmed não for true', () => {
    const result = gate.evaluate(sensitiveTool, { door: 'principal' }, baseContext);
    expect(result.allowed).toBe(false);
    expect(result.confirmation).toBeDefined();
    expect(result.confirmation?.toolName).toBe('destrancar_porta');
    expect(result.confirmation?.prompt).toBe("Confirma a abertura da porta 'principal'?");
    expect(result.confirmation?.parameters).toEqual({ door: 'principal' });
  });

  it('deve permitir a execução da ferramenta crítica quando o contexto já possuir confirmação expressa', () => {
    const confirmedContext: ToolExecutionContext = {
      ...baseContext,
      confirmed: true,
    };

    const result = gate.evaluate(sensitiveTool, { door: 'principal' }, confirmedContext);
    expect(result.allowed).toBe(true);
    expect(result.confirmation).toBeUndefined();
  });

  it('deve usar prompt padrão de segurança caso a ferramenta crítica não defina um prompt customizado', () => {
    const toolWithoutCustomPrompt: ToolDefinition<{ target: string }, void> = {
      name: 'apagar_dados',
      description: 'Apaga dados',
      sensitivity: 'critical',
      requiresConfirmation: true,
      schema: z.object({ target: z.string() }),
      execute: async () => {},
    };

    const result = gate.evaluate(toolWithoutCustomPrompt, { target: 'banco' }, baseContext);
    expect(result.allowed).toBe(false);
    expect(result.confirmation?.prompt).toContain("possui impacto crítico e precisa da sua confirmação expressa");
  });
});

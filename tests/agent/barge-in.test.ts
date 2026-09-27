import { describe, it, expect, vi } from 'vitest';
import { hasEvaWakeWord, cleanEvaPrefix } from '../../src/core/agent/barge-in';
import { AgentEngine } from '../../src/core/agent/agent-engine';
import { FallbackOrchestrator } from '../../src/core/providers/fallback-orchestrator';
import { LLMProvider, ChatMessage, LLMCompletionResult } from '../../src/core/providers/types';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { ToolExecutor } from '../../src/core/tools/tool-executor';

describe('Barge-In & Conversational Interruption ("eva:")', () => {
  describe('Detecção e Limpeza da Palavra de Ativação ("eva:")', () => {
    it('deve detectar com precisão a chamada "eva:" em diferentes variações', () => {
      expect(hasEvaWakeWord('eva: que horas são?')).toBe(true);
      expect(hasEvaWakeWord('Eva, cancela a ação')).toBe(true);
      expect(hasEvaWakeWord('EVA! me diz o clima')).toBe(true);
      expect(hasEvaWakeWord('Para, Eva.')).toBe(true);
      expect(hasEvaWakeWord('éva: bom dia')).toBe(true);
      expect(hasEvaWakeWord('Olá Eva como vai?')).toBe(true);
    });

    it('não deve disparar falso positivo em palavras semelhantes ou falas sem "eva"', () => {
      expect(hasEvaWakeWord('hoje o dia está ensolarado')).toBe(false);
      expect(hasEvaWakeWord('ele viajou para a praia')).toBe(false);
      expect(hasEvaWakeWord('vou levar o casaco')).toBe(false);
      expect(hasEvaWakeWord('evasão fiscal')).toBe(false);
      expect(hasEvaWakeWord('relevante')).toBe(false);
      expect(hasEvaWakeWord('')).toBe(false);
    });

    it('deve limpar o prefixo "eva:" para processamento natural do texto', () => {
      expect(cleanEvaPrefix('eva: que horas são?')).toBe('que horas são?');
      expect(cleanEvaPrefix('Eva, cancela')).toBe('cancela');
      expect(cleanEvaPrefix('EVA! bom dia')).toBe('bom dia');
      expect(cleanEvaPrefix('éva: previsão do tempo')).toBe('previsão do tempo');
      expect(cleanEvaPrefix('que horas são?')).toBe('que horas são?');
    });
  });

  describe('Refatoração Conversacional no AgentEngine', () => {
    it('deve injetar contexto de interrupção (Barge-In) e instrução de refatoração para o LLM', async () => {
      let capturedMessages: ChatMessage[] = [];
      const mockPrimaryLLM: LLMProvider = {
        name: 'mock-primary',
        model: 'mock-model',
        generate: vi.fn(async (messages: ChatMessage[]): Promise<LLMCompletionResult> => {
          capturedMessages = [...messages];
          return {
            content: 'Agora são 11 horas e 15 minutos.',
            usage: { inputTokens: 50, outputTokens: 10 },
            provider: 'mock-primary',
            model: 'mock-model',
            latencyMs: 15,
          };
        }),
        isHealthy: async () => true,
      };

      const orchestrator = new FallbackOrchestrator(mockPrimaryLLM);
      const registry = new ToolRegistry();
      const executor = new ToolExecutor(registry);
      const agent = new AgentEngine({
        llmOrchestrator: orchestrator,
        registry,
        executor,
      });

      const userInput = 'eva: na verdade me diz que horas são';
      const result = await agent.run(userInput, [
        { role: 'user', content: 'me conte uma história sobre a lua' },
      ], {
        interruptedFrom: {
          previousPrompt: 'me conte uma história sobre a lua',
          partialResponse: 'Era uma vez uma noite clara em que a lua brilhava...',
        },
      });

      expect(result.textResponse).toBe('Agora são 11 horas e 15 minutos.');

      // Verifica se a diretriz de interrupção foi injetada no prompt
      const systemDirective = capturedMessages.find(
        (m) => m.role === 'system' && m.content.includes('[INTERRUPÇÃO DE FALA (BARGE-IN) DETECTADA]')
      );
      expect(systemDirective).toBeDefined();
      expect(systemDirective?.content).toContain('Era uma vez uma noite clara em que a lua brilhava...');
      expect(systemDirective?.content).toContain('eva: na verdade me diz que horas são');
      expect(systemDirective?.content).toContain('Refatore e produza a sua resposta focando EXCLUSIVAMENTE');
    });

    it('deve abortar execução imediatamente se abortSignal estiver acionado', async () => {
      const mockPrimaryLLM: LLMProvider = {
        name: 'mock-primary',
        model: 'mock-model',
        generate: vi.fn(),
        isHealthy: async () => true,
      };

      const orchestrator = new FallbackOrchestrator(mockPrimaryLLM);
      const registry = new ToolRegistry();
      const executor = new ToolExecutor(registry);
      const agent = new AgentEngine({
        llmOrchestrator: orchestrator,
        registry,
        executor,
      });

      const abortController = new AbortController();
      abortController.abort(); // já abortado

      const result = await agent.run('eva: cancela', [], {
        abortSignal: abortController.signal,
      });

      expect(result.textResponse).toBe('');
      expect(mockPrimaryLLM.generate).not.toHaveBeenCalled();
    });
  });
});

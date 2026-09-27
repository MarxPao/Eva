import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroqLLMProvider } from '../../src/core/providers/groq/groq-llm';

describe('GroqLLMProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('deve gerar resposta de texto com sucesso', async () => {
    const mockResponse = {
      id: 'chatcmpl-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Olá! Como posso ajudar você hoje?',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 10,
        total_tokens: 25,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const provider = new GroqLLMProvider({ apiKey: 'gsk_dummy' });
    const result = await provider.generate([{ role: 'user', content: 'Olá EVA' }]);

    expect(result.content).toBe('Olá! Como posso ajudar você hoje?');
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.provider).toBe('groq');
  });

  it('deve parsear tool_calls retornadas pelo Groq corretamente', async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_clima_1',
                type: 'function',
                function: {
                  name: 'consultar_clima',
                  arguments: JSON.stringify({ cidade: 'Curitiba', dias: 2 }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 20,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const provider = new GroqLLMProvider({ apiKey: 'gsk_dummy' });
    const result = await provider.generate([{ role: 'user', content: 'Como está o tempo em Curitiba?' }]);

    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toEqual({
      id: 'call_clima_1',
      name: 'consultar_clima',
      rawArguments: JSON.stringify({ cidade: 'Curitiba', dias: 2 }),
      parsedArguments: { cidade: 'Curitiba', dias: 2 },
    });
  });

  it('deve lançar erro descritivo em caso de resposta com erro da API Groq', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
    } as any);

    const provider = new GroqLLMProvider({ apiKey: 'gsk_dummy' });
    await expect(
      provider.generate([{ role: 'user', content: 'Teste' }])
    ).rejects.toThrowError(/Rate limit exceeded/);
  });
});

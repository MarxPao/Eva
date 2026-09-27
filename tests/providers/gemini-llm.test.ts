import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiLLMProvider } from '../../src/core/providers/gemini/gemini-llm';

describe('GeminiLLMProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('deve gerar resposta de texto via Gemini formatando contents adequadamente', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Olá do Gemini Flash!' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 8,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const provider = new GeminiLLMProvider({ apiKey: 'gemini_test_key' });
    const result = await provider.generate([
      { role: 'system', content: 'Você é a EVA' },
      { role: 'user', content: 'Olá' },
    ]);

    expect(result.content).toBe('Olá do Gemini Flash!');
    expect(result.provider).toBe('gemini');
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('deve mapear functionCall do Gemini para toolCalls compatíveis', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'consultar_clima',
                  args: { cidade: 'São Paulo' },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 15,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const provider = new GeminiLLMProvider({ apiKey: 'gemini_test_key' });
    const result = await provider.generate([{ role: 'user', content: 'Tempo em SP' }]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].name).toBe('consultar_clima');
    expect(result.toolCalls?.[0].parsedArguments).toEqual({ cidade: 'São Paulo' });
  });
});

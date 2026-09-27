import { describe, it, expect, vi } from 'vitest';
import { FallbackOrchestrator } from '../../src/core/providers/fallback-orchestrator';

describe('FallbackOrchestrator (Abstração e Contingência de Provedores)', () => {
  interface MockProvider {
    name: string;
    complete: (prompt: string) => Promise<string>;
  }

  const primary: MockProvider = {
    name: 'groq-primary',
    complete: vi.fn(),
  };

  const fallback: MockProvider = {
    name: 'gemini-fallback',
    complete: vi.fn(),
  };

  it('deve usar o provedor primário quando a chamada for bem-sucedida', async () => {
    vi.mocked(primary.complete).mockResolvedValueOnce('Resposta do Groq');
    const orchestrator = new FallbackOrchestrator<MockProvider>(primary, fallback);

    const res = await orchestrator.execute(
      (provider) => provider.complete('Olá'),
      'LLM_Generation'
    );

    expect(res.providerUsed).toBe('groq-primary');
    expect(res.fallbackTriggered).toBe(false);
    expect(res.result).toBe('Resposta do Groq');
    expect(primary.complete).toHaveBeenCalledWith('Olá');
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('deve acionar o provedor de fallback quando o primário lançar erro', async () => {
    vi.mocked(primary.complete).mockRejectedValueOnce(new Error('Groq 429 Rate Limit Exceeded'));
    vi.mocked(fallback.complete).mockResolvedValueOnce('Resposta do Gemini Flash');
    const orchestrator = new FallbackOrchestrator<MockProvider>(primary, fallback);

    const res = await orchestrator.execute(
      (provider) => provider.complete('Olá com erro'),
      'LLM_Generation'
    );

    expect(res.providerUsed).toBe('gemini-fallback');
    expect(res.fallbackTriggered).toBe(true);
    expect(res.primaryError?.message).toBe('Groq 429 Rate Limit Exceeded');
    expect(res.result).toBe('Resposta do Gemini Flash');
    expect(fallback.complete).toHaveBeenCalledWith('Olá com erro');
  });

  it('deve lançar erro descritivo quando ambos os provedores falharem', async () => {
    vi.mocked(primary.complete).mockRejectedValueOnce(new Error('Groq Timeout'));
    vi.mocked(fallback.complete).mockRejectedValueOnce(new Error('Gemini Quota Exceeded'));
    const orchestrator = new FallbackOrchestrator<MockProvider>(primary, fallback);

    await expect(
      orchestrator.execute((provider) => provider.complete('Teste de queda geral'), 'LLM_Generation')
    ).rejects.toThrowError(/Falha em todos os provedores/);
  });
});

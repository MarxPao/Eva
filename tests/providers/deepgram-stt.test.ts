import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepgramSTTProvider } from '../../src/core/providers/deepgram/deepgram-stt';

describe('DeepgramSTTProvider (STT Provider Port)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('deve lançar erro se instanciado sem apiKey', () => {
    expect(() => new DeepgramSTTProvider({ apiKey: '' })).toThrow(
      'DeepgramSTTProvider requer uma apiKey válida.'
    );
  });

  it('deve realizar transcrição via API REST com sucesso', async () => {
    const mockResponse = {
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'olá mundo, esta é uma transcrição de teste',
                confidence: 0.99,
              },
            ],
          },
        ],
      },
      metadata: {
        duration: 2.5,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    const provider = new DeepgramSTTProvider({ apiKey: 'dg_mock_token_123' });
    const audioBuffer = Buffer.alloc(80000); // ~2.5s de áudio PCM16 a 16kHz
    const result = await provider.transcribe(audioBuffer, { language: 'pt' });

    expect(result.text).toBe('olá mundo, esta é uma transcrição de teste');
    expect(result.durationSeconds).toBe(2.5);
    expect(result.provider).toBe('deepgram:nova-2');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/listen?model=nova-2&language=pt'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Token dg_mock_token_123',
          'Content-Type': 'audio/wav',
        }),
      })
    );
  });

  it('deve repassar erro da API com código HTTP e mensagem', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Invalid Credentials'),
    });

    const provider = new DeepgramSTTProvider({ apiKey: 'invalid_key' });
    await expect(provider.transcribe(Buffer.alloc(100))).rejects.toThrow(
      '[DeepgramSTTProvider] Erro na transcrição (401): Invalid Credentials'
    );
  });

  it('deve criar sessão de streaming com interface funcional', async () => {
    // Mock simples de WebSocket no ambiente global
    class MockWebSocket {
      public readyState = 1; // OPEN
      public sent: any[] = [];
      public onopen: any = null;
      public onmessage: any = null;
      constructor(public url: string, public options: any) {
        setTimeout(() => {
          if (this.onopen) this.onopen();
        }, 5);
      }
      send(data: any) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3; // CLOSED
      }
    }

    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;

    try {
      const provider = new DeepgramSTTProvider({ apiKey: 'dg_key_live' });
      let partialReceived = '';
      const session = provider.createStreamingSession({
        language: 'pt',
        onPartial: (p) => { partialReceived = p; },
      });

      session.sendChunk(Buffer.alloc(4096));
      session.sendChunk(Buffer.alloc(4096));

      expect(session).toHaveProperty('sendChunk');
      expect(session).toHaveProperty('finish');
      expect(session).toHaveProperty('cancel');

      session.cancel();
    } finally {
      (globalThis as any).WebSocket = origWS;
    }
  });
});

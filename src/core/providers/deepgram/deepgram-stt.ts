import { STTProvider, STTOptions, STTResult } from '../types';

export interface DeepgramSTTOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  wsBaseUrl?: string;
}

export interface DeepgramStreamSession {
  sendChunk(pcmChunk: Buffer): void;
  finish(): Promise<STTResult>;
  cancel(): void;
}

export class DeepgramSTTProvider implements STTProvider {
  public readonly name = 'deepgram:nova-2';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly wsBaseUrl: string;

  constructor(options: DeepgramSTTOptions) {
    if (!options.apiKey) {
      throw new Error('DeepgramSTTProvider requer uma apiKey válida.');
    }
    this.apiKey = options.apiKey;
    this.model = options.model || 'nova-2';
    this.baseUrl = (options.baseUrl || 'https://api.deepgram.com/v1').replace(/\/+$/, '');
    this.wsBaseUrl = (options.wsBaseUrl || 'wss://api.deepgram.com/v1').replace(/\/+$/, '');
  }

  /**
   * Transcrição batch de buffer de áudio via API REST do Deepgram.
   */
  public async transcribe(audioBuffer: Buffer, options: STTOptions = {}): Promise<STTResult> {
    const startTime = Date.now();
    const language = options.language || 'pt';
    const url = `${this.baseUrl}/listen?model=${encodeURIComponent(this.model)}&language=${encodeURIComponent(language)}&smart_format=true`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer as any,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`[DeepgramSTTProvider] Erro na transcrição (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as any;
    const latencyMs = Date.now() - startTime;
    const transcript =
      data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    const durationSeconds =
      typeof data.metadata?.duration === 'number'
        ? data.metadata.duration
        : audioBuffer.length / (16000 * 2);

    return {
      text: transcript.trim(),
      durationSeconds,
      provider: this.name,
      latencyMs,
    };
  }

  /**
   * Cria uma sessão de streaming WebSocket com o Deepgram Nova-2 para transcrição em tempo real.
   */
  public createStreamingSession(
    options: STTOptions & { onPartial?: (partialText: string) => void } = {}
  ): DeepgramStreamSession {
    const startTime = Date.now();
    const language = options.language || 'pt';
    const wsUrl = `${this.wsBaseUrl}/listen?model=${encodeURIComponent(this.model)}&language=${encodeURIComponent(language)}&smart_format=true&encoding=linear16&sample_rate=16000&channels=1`;

    let totalAudioBytes = 0;
    let finalTranscript = '';
    let isClosed = false;

    // Constrói cliente WebSocket para Deepgram
    // Usando a API global WebSocket do Node.js ou mock de teste
    const WSClass = typeof WebSocket !== 'undefined' ? WebSocket : (globalThis as any).WebSocket;
    if (!WSClass) {
      throw new Error('Ambiente de execução não possui suporte a WebSocket nativo.');
    }

    const ws = new WSClass(wsUrl, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    const pendingChunks: Buffer[] = [];
    let isSocketOpen = false;

    ws.onopen = () => {
      isSocketOpen = true;
      while (pendingChunks.length > 0) {
        const c = pendingChunks.shift();
        if (c) ws.send(c);
      }
    };

    ws.onmessage = (event: any) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0];
          const text = alt?.transcript || '';
          if (text) {
            if (msg.is_final) {
              finalTranscript += (finalTranscript ? ' ' : '') + text.trim();
            }
            if (options.onPartial) {
              options.onPartial(text.trim());
            }
          }
        }
      } catch {}
    };

    return {
      sendChunk: (pcmChunk: Buffer) => {
        if (isClosed) return;
        totalAudioBytes += pcmChunk.length;
        if (isSocketOpen && ws.readyState === 1 /* OPEN */) {
          ws.send(pcmChunk);
        } else {
          pendingChunks.push(pcmChunk);
        }
      },
      finish: async (): Promise<STTResult> => {
        if (isClosed) {
          return {
            text: finalTranscript.trim(),
            durationSeconds: totalAudioBytes / (16000 * 2),
            provider: this.name,
            latencyMs: Date.now() - startTime,
          };
        }
        isClosed = true;

        return new Promise<STTResult>((resolve) => {
          const timeout = setTimeout(() => {
            try { ws.close(); } catch {}
            resolve({
              text: finalTranscript.trim(),
              durationSeconds: totalAudioBytes / (16000 * 2),
              provider: this.name,
              latencyMs: Date.now() - startTime,
            });
          }, 800); // 800ms max timeout para finalização de transcrição

          // Envia frame vazio informando fim de stream ao Deepgram
          try {
            if (ws.readyState === 1 /* OPEN */) {
              ws.send(new Uint8Array(0));
            }
          } catch {}

          const checkClose = setInterval(() => {
            if (ws.readyState === 3 /* CLOSED */ || ws.readyState === 2 /* CLOSING */) {
              clearInterval(checkClose);
              clearTimeout(timeout);
              resolve({
                text: finalTranscript.trim(),
                durationSeconds: totalAudioBytes / (16000 * 2),
                provider: this.name,
                latencyMs: Date.now() - startTime,
              });
            }
          }, 20);
        });
      },
      cancel: () => {
        isClosed = true;
        try { ws.close(); } catch {}
      },
    };
  }

  public async isHealthy(): Promise<boolean> {
    return true;
  }
}

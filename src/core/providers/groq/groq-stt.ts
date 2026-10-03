import { STTProvider, STTOptions, STTResult } from '../types';

export interface GroqSTTOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class GroqSTTProvider implements STTProvider {
  public readonly name = 'groq:whisper';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: GroqSTTOptions) {
    if (!options.apiKey) {
      throw new Error('GroqSTTProvider requer uma apiKey válida.');
    }
    this.apiKey = options.apiKey;
    this.model = options.model || 'whisper-large-v3-turbo';
    this.baseUrl = (options.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  }

  public async transcribe(audioBuffer: Buffer, options: STTOptions = {}): Promise<STTResult> {
    const startTime = Date.now();

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' });
    formData.append('file', blob, 'audio.wav');
    formData.append('model', this.model);
    formData.append('language', options.language || 'pt');
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', '0.0');

    const promptContext = options.prompt || 'EVA, assistente virtual inteligente em português do Brasil. Comandos de voz, perguntas rápidas e conversas.';
    formData.append('prompt', promptContext);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[GroqSTTProvider] Erro na transcrição (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    const latencyMs = Date.now() - startTime;
    const durationSeconds = typeof data.duration === 'number' ? data.duration : (audioBuffer.length / (16000 * 2));

    return {
      text: (data.text || '').trim(),
      durationSeconds,
      provider: this.name,
      latencyMs,
    };
  }

  public async isHealthy(): Promise<boolean> {
    return true;
  }

  public async prewarm(): Promise<number> {
    const start = Date.now();
    try {
      await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch {}
    return Date.now() - start;
  }
}

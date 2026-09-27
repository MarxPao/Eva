import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { TTSProvider, TTSOptions, TTSResult } from '../types';

export interface EdgeTTSProviderOptions {
  voice?: string;
  outputFormat?: any;
}

export class EdgeTTSProvider implements TTSProvider {
  public readonly name = 'edge-tts';
  private readonly voice: string;
  private readonly outputFormat: any;
  private ttsInstance: MsEdgeTTS | null = null;
  private initPromise: Promise<MsEdgeTTS> | null = null;
  private queueTail: Promise<any> = Promise.resolve();

  constructor(options: EdgeTTSProviderOptions = {}) {
    this.voice = options.voice || 'pt-BR-FranciscaNeural';
    this.outputFormat = options.outputFormat || OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
  }

  private async ensureInitialized(): Promise<MsEdgeTTS> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const instance = new MsEdgeTTS();
        await instance.setMetadata(this.voice, this.outputFormat);
        this.ttsInstance = instance;
        return instance;
      })();
    }
    return this.initPromise;
  }

  public async synthesize(text: string, _options: TTSOptions = {}): Promise<TTSResult> {
    const startTime = Date.now();

    const executeSynthesis = async (): Promise<TTSResult> => {
      const tts = await this.ensureInitialized();
      const streamResult = tts.toStream(text);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        streamResult.audioStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        streamResult.audioStream.on('end', () => {
          resolve();
        });
        streamResult.audioStream.on('error', (err: any) => {
          reject(err);
        });
      });

      const audioBuffer = Buffer.concat(chunks);
      const latencyMs = Date.now() - startTime;

      return {
        audioBuffer,
        characterCount: text.length,
        provider: this.name,
        latencyMs,
      };
    };

    const currentTask = this.queueTail.then(executeSynthesis, executeSynthesis);
    this.queueTail = currentTask.catch(() => {});
    return currentTask;
  }

  private keepAliveTimer: any = null;

  /**
   * Pré-aquece a conexão WebSocket e o handshake TLS com os servidores Edge-TTS.
   * Garante que a primeira interação do usuário encontre o socket pronto (0ms de handshake).
   */
  public async prewarm(): Promise<number> {
    const start = Date.now();
    await this.ensureInitialized();
    this.startKeepAlive();
    return Date.now() - start;
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(async () => {
      try {
        const tts = this.ttsInstance as any;
        if (!tts || !tts._ws || tts._ws.readyState !== 1 /* OPEN */) {
          this.initPromise = null;
          await this.ensureInitialized();
        }
      } catch {}
    }, 45000);
  }

  public stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  public async isHealthy(): Promise<boolean> {
    return true;
  }
}

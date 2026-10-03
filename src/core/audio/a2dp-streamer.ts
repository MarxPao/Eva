import { MPEGDecoder } from 'mpg123-decoder';

export interface A2DPStreamerOptions {
  chunkSize?: number; // bytes por chunk enviado ao ESP32 (padrão 2048 = 512 frames estéreo = ~11.6ms)
  paceIntervalMs?: number; // intervalo do timer (padrão 23ms para 4096 bytes)
}

/**
 * Converte áudio MP3 (gerado pelo EdgeTTS a 24kHz Mono) para PCM 16-bit estéreo a 44.1kHz
 * e transmite via WebSocket em fluxo contínuo para o ESP32 alimentar o alto-falante Bluetooth via A2DP.
 */
export class A2DPStreamer {
  private decoder: MPEGDecoder | null = null;
  private decoderReadyPromise: Promise<void> | null = null;
  private wsClient: any = null;
  private queue: Buffer[] = [];
  private pacerTimer: NodeJS.Timeout | null = null;
  private activeInteractionId: string | null = null;
  private isStreamActive = false;
  private readonly chunkSize: number;

  constructor(options: A2DPStreamerOptions = {}) {
    this.chunkSize = options.chunkSize || 2048;
    this.initDecoder();
  }

  private initDecoder() {
    this.decoder = new MPEGDecoder();
    this.decoderReadyPromise = this.decoder.ready;
  }

  public setWsClient(client: any) {
    this.wsClient = client;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public isPlaying(): boolean {
    return this.isStreamActive || this.queue.length > 0;
  }

  /**
   * Converte canal float32 (24kHz Mono) para PCM 16-bit estéreo a 44.1kHz.
   */
  public static resample24kTo44kStereo(src: Float32Array): Buffer {
    const outSamples = Math.floor((src.length * 44100) / 24000);
    const pcmBuf = Buffer.alloc(outSamples * 4); // 2 canais * 2 bytes = 4 bytes por frame
    const ratio = 24000 / 44100;

    for (let i = 0; i < outSamples; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s1 = src[idx] || 0;
      const s2 = idx + 1 < src.length ? src[idx + 1] : s1;
      const smp = s1 + frac * (s2 - s1);
      const val = Math.max(-32768, Math.min(32767, Math.round(smp * 32767)));

      // Canal 1 (Left)
      pcmBuf.writeInt16LE(val, i * 4);
      // Canal 2 (Right)
      pcmBuf.writeInt16LE(val, i * 4 + 2);
    }

    return pcmBuf;
  }

  /**
   * Processa uma sentença sintetizada (em formato MP3) e enfileira os chunks PCM para streaming.
   */
  public async streamSentence(
    interactionId: string,
    sentenceIndex: number,
    mp3Buffer: Buffer
  ): Promise<void> {
    if (this.activeInteractionId !== interactionId) {
      this.stop();
      this.activeInteractionId = interactionId;
      if (this.wsClient && this.wsClient.readyState === 1 /* OPEN */) {
        try {
          this.wsClient.send(JSON.stringify({ cmd: 'tts_start', interactionId, sentenceIndex }));
        } catch {}
      }
    }

    if (!this.decoder) {
      this.initDecoder();
    }
    await this.decoderReadyPromise;

    try {
      const { channelData } = this.decoder!.decode(mp3Buffer);
      await this.decoder!.reset();

      if (!channelData || channelData.length === 0 || channelData[0].length === 0) {
        return;
      }

      const pcmBuffer = A2DPStreamer.resample24kTo44kStereo(channelData[0]);

      // Segmenta o buffer em chunks dimensionados para o Ring Buffer do ESP32
      for (let offset = 0; offset < pcmBuffer.length; offset += this.chunkSize) {
        const end = Math.min(offset + this.chunkSize, pcmBuffer.length);
        this.queue.push(pcmBuffer.subarray(offset, end));
      }

      if (!this.isStreamActive) {
        this.startPacer();
      }
    } catch (err) {
      console.error('[A2DPStreamer] Erro ao decodificar/resamplear sentença:', err);
    }
  }

  private startPacer() {
    this.isStreamActive = true;

    // Burst inicial (pre-roll de ~12KB = 6 chunks de 2KB = ~70ms) para amortecer latência do Wi-Fi
    const initialBurstCount = 6;
    for (let i = 0; i < initialBurstCount && this.queue.length > 0; i++) {
      const chunk = this.queue.shift()!;
      this.sendChunk(chunk);
    }

    // Pacer temporizado: a cada 23ms envia 2 chunks (4096 bytes = ~23.2ms de áudio a 44.1kHz estéreo)
    this.pacerTimer = setInterval(() => {
      if (this.queue.length === 0) {
        return;
      }

      for (let i = 0; i < 2 && this.queue.length > 0; i++) {
        const chunk = this.queue.shift()!;
        this.sendChunk(chunk);
      }
    }, 23);
  }

  private sendChunk(chunk: Buffer) {
    if (this.wsClient && this.wsClient.readyState === 1 /* OPEN */) {
      try {
        this.wsClient.send(chunk);
      } catch (err) {
        console.warn('[A2DPStreamer] Falha ao enviar chunk via WS:', err);
      }
    }
  }

  /**
   * Interrompe imediatamente qualquer reprodução em curso (Barge-in),
   * limpa a fila de transmissão e notifica o ESP32 para limpar seu buffer.
   */
  public stop() {
    if (this.pacerTimer) {
      clearInterval(this.pacerTimer);
      this.pacerTimer = null;
    }
    this.queue = [];
    this.isStreamActive = false;
    this.activeInteractionId = null;

    if (this.wsClient && this.wsClient.readyState === 1 /* OPEN */) {
      try {
        this.wsClient.send(JSON.stringify({ cmd: 'interrupt' }));
      } catch {}
    }
  }

  public finish() {
    if (this.wsClient && this.wsClient.readyState === 1 /* OPEN */) {
      try {
        this.wsClient.send(JSON.stringify({ cmd: 'tts_end' }));
      } catch {}
    }
  }
}

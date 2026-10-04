import { MPEGDecoder } from 'mpg123-decoder';

export interface A2DPStreamerOptions {
  chunkSize?: number; // bytes por chunk enviado ao ESP32 (padrão 1024 = 512 samples mono = ~11.6ms)
  paceIntervalMs?: number; // intervalo do timer (padrão 20ms)
}

/**
 * Converte áudio MP3 (gerado pelo EdgeTTS a 24kHz Mono) para PCM 16-bit mono a 44.1kHz
 * e transmite via WebSocket com controle de fluxo para o ESP32 alimentar o alto-falante Bluetooth via A2DP.
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
  private remoteFreeBytes: number = 7168; // Estimativa conservadora inicial (~7KB livre no buffer de 8KB)
  private readonly maxRemoteBuffer: number = 8192;

  constructor(options: A2DPStreamerOptions = {}) {
    this.chunkSize = options.chunkSize || 1024;
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

  public getRemoteFreeBytes(): number {
    return this.remoteFreeBytes;
  }

  /**
   * Atualiza a janela de controle de fluxo informada pelo hardware ESP32.
   */
  public updateFlowControl(freeBytes: number): void {
    this.remoteFreeBytes = Math.min(this.maxRemoteBuffer, Math.max(0, freeBytes));
    this.processQueue();
  }

  /**
   * Converte canal float32 (24kHz Mono) para PCM 16-bit mono a 44.1kHz.
   * Reduz a largura de banda de transmissão via Wi-Fi pela metade (88.2 KB/s).
   */
  public static resample24kTo44kMono(src: Float32Array): Buffer {
    const outSamples = Math.floor((src.length * 44100) / 24000);
    const pcmBuf = Buffer.alloc(outSamples * 2); // 1 canal * 2 bytes = 2 bytes por sample
    const ratio = 24000 / 44100;

    for (let i = 0; i < outSamples; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s1 = src[idx] || 0;
      const s2 = idx + 1 < src.length ? src[idx + 1] : s1;
      const smp = s1 + frac * (s2 - s1);
      const val = Math.max(-32768, Math.min(32767, Math.round(smp * 32767)));

      pcmBuf.writeInt16LE(val, i * 2);
    }

    return pcmBuf;
  }

  /**
   * Converte canal float32 (24kHz Mono) para PCM 16-bit estéreo a 44.1kHz (compatibilidade).
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
   * Processa uma sentença sintetizada (em formato MP3) e enfileira os chunks PCM para streaming sob controle de fluxo.
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

      const pcmBuffer = A2DPStreamer.resample24kTo44kMono(channelData[0]);

      // Segmenta o buffer em chunks dimensionados para o Ring Buffer do ESP32 (1024 bytes cada)
      for (let offset = 0; offset < pcmBuffer.length; offset += this.chunkSize) {
        const end = Math.min(offset + this.chunkSize, pcmBuffer.length);
        this.queue.push(pcmBuffer.subarray(offset, end));
      }

      this.processQueue();
    } catch (err) {
      console.error('[A2DPStreamer] Erro ao decodificar/resamplear sentença:', err);
    }
  }

  /**
   * Processa a fila de transmissão respeitando a janela livre de controle de fluxo do ESP32 (sem bursts).
   */
  private processQueue() {
    if (!this.isStreamActive && this.queue.length > 0) {
      this.isStreamActive = true;
      this.startPacer();
    }

    // Envia chunks estritamente enquanto houver espaço livre confirmado no ESP32
    while (this.queue.length > 0 && this.remoteFreeBytes >= this.chunkSize) {
      const chunk = this.queue.shift()!;
      this.sendChunk(chunk);
      this.remoteFreeBytes -= chunk.length;
    }
  }

  private startPacer() {
    this.isStreamActive = true;
    this.processQueue();

    if (!this.pacerTimer) {
      this.pacerTimer = setInterval(() => {
        if (this.queue.length === 0) {
          return;
        }

        // Se houver chunks na fila mas o ACK estiver atrasado, realiza avanço seguro
        // correspondente ao consumo contínuo do A2DP (88.2 bytes/ms = ~1764 bytes a cada 20ms)
        this.remoteFreeBytes = Math.min(this.maxRemoteBuffer, this.remoteFreeBytes + 1764);
        this.processQueue();
      }, 20);
    }
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
    this.remoteFreeBytes = 7168;

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

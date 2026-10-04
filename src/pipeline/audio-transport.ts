/**
 * Módulo de Transporte de Áudio e Montagem de Chunks (Phase 2 - T1)
 * Suporta agregação incremental de chunks recebidos via WebSocket do ESP32.
 */

export function addWavHeader(
  pcmBuffer: Buffer,
  sampleRate: number = 16000,
  channels: number = 1,
  bitsPerSample: number = 16
): Buffer {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 para PCM)
  header.writeUInt16LE(1, 20);  // Formato de áudio 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28); // ByteRate
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);              // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);                               // BitsPerSample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Normaliza dinamicamente o buffer PCM 16-bit (Soft AGC) para o volume ideal de transcrição do Whisper.
 * - Detecta o pico máximo de amplitude.
 * - Se a fala foi distante ou baixa, eleva suavemente até ~27.800 (-1.4 dBFS).
 * - Limita o ganho máximo a 5.5x (+15 dB) para não amplificar o piso de ruído se for quase silêncio.
 * - Remove qualquer DC offset residual.
 */
export function normalizePcmBuffer(
  pcmBuffer: Buffer,
  targetPeakRatio: number = 0.85,
  maxGain: number = 5.5
): Buffer {
  if (!pcmBuffer || pcmBuffer.length < 4) {
    return pcmBuffer;
  }

  const numSamples = Math.floor(pcmBuffer.length / 2);
  let maxAbs = 0;
  let sum = 0;

  for (let i = 0; i < numSamples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    sum += sample;
    const abs = Math.abs(sample);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }

  // Se o buffer for ruído residual muito baixo (< 120 de pico), ou já estiver em nível ideal (>= 29.000), não mexe
  if (maxAbs < 120 || maxAbs >= 29000) {
    return pcmBuffer;
  }

  const dcOffset = Math.round(sum / numSamples);
  const targetPeak = Math.round(32767 * targetPeakRatio); // ~27.850 (-1.4 dBFS)
  const calculatedGain = targetPeak / maxAbs;
  const gain = Math.min(Math.max(calculatedGain, 1.0), maxGain);

  if (gain <= 1.05 && Math.abs(dcOffset) < 50) {
    return pcmBuffer;
  }

  const normalized = Buffer.alloc(pcmBuffer.length);
  for (let i = 0; i < numSamples; i++) {
    const raw = pcmBuffer.readInt16LE(i * 2) - dcOffset;
    let amplified = Math.round(raw * gain);
    if (amplified > 32767) amplified = 32767;
    else if (amplified < -32768) amplified = -32768;
    normalized.writeInt16LE(amplified, i * 2);
  }

  return normalized;
}

export interface WsAudioChunkEvent {
  type: 'audio_stream_start' | 'audio_stream_end';
  sampleRate?: number;
  format?: string;
  channels?: number;
  t0?: number;
  t_first_chunk_sent?: number;
  t_upload_complete?: number;
  totalChunks?: number;
  droppedChunks?: number;
}

/**
 * Configuração de Silêncio do VAD (In-Flight VAD)
 * Cada chunk tem 1024 amostras / 16kHz = 64ms.
 * 700ms / 64ms = 11 chunks (~704ms de silêncio pós-fala)
 */
export const VAD_SILENCE_TIMEOUT_MS = 700; // Tempo de silêncio pós-fala padrão (600-800ms)
export const VAD_SILENCE_CHUNKS_THRESHOLD = Math.round(VAD_SILENCE_TIMEOUT_MS / 64); // 11 chunks (~704ms)

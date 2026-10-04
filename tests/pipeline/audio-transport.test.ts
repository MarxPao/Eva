import { describe, it, expect } from 'vitest';
import { addWavHeader, normalizePcmBuffer } from '../../src/pipeline/audio-transport';

describe('audio-transport (T1 — Transporte e Montagem de Chunks)', () => {
  it('deve adicionar cabeçalho WAV canônico de 44 bytes ao buffer PCM', () => {
    const pcm = Buffer.alloc(3200); // 100ms de áudio PCM16 a 16kHz
    const wav = addWavHeader(pcm, 16000, 1, 16);

    expect(wav.length).toBe(44 + 3200);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt32LE(24)).toBe(16000); // Sample rate
    expect(wav.readUInt16LE(22)).toBe(1);     // Mono
    expect(wav.readUInt16LE(34)).toBe(16);    // 16 bits
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(3200);  // Data size
  });

  it('deve preservar amostras de múltiplos chunks agregados incrementalmente', () => {
    const chunk1 = Buffer.alloc(1600, 0x11);
    const chunk2 = Buffer.alloc(1600, 0x22);
    const pcm = Buffer.concat([chunk1, chunk2]);
    const wav = addWavHeader(pcm, 16000, 1, 16);

    expect(wav.length).toBe(44 + 3200);
    expect(wav.readUInt32LE(40)).toBe(3200);
    expect(wav[44]).toBe(0x11);
    expect(wav[44 + 1600]).toBe(0x22);
  });

  describe('normalizePcmBuffer (Soft AGC & Normalização Dinâmica)', () => {
    it('deve amplificar áudio com amplitude baixa para o nível ótimo do Whisper (~27.850)', () => {
      const samples = 1000;
      const lowPcm = Buffer.alloc(samples * 2);
      // Simula uma fala distante com pico de 5000 (apenas ~15% de escala)
      for (let i = 0; i < samples; i++) {
        const val = Math.round(5000 * Math.sin((i / 50) * Math.PI));
        lowPcm.writeInt16LE(val, i * 2);
      }

      const normalized = normalizePcmBuffer(lowPcm);
      expect(normalized.length).toBe(lowPcm.length);

      let maxNormalized = 0;
      for (let i = 0; i < samples; i++) {
        const val = Math.abs(normalized.readInt16LE(i * 2));
        if (val > maxNormalized) maxNormalized = val;
      }

      // Deve ter sido amplificado para próximo de 27.850 sem estourar 32.767
      expect(maxNormalized).toBeGreaterThan(25000);
      expect(maxNormalized).toBeLessThanOrEqual(32767);
    });

    it('não deve alterar áudio de silêncio absoluto (< 120) para não amplificar piso de ruído', () => {
      const silentPcm = Buffer.alloc(1000);
      for (let i = 0; i < 500; i++) {
        silentPcm.writeInt16LE(20, i * 2);
      }

      const result = normalizePcmBuffer(silentPcm);
      expect(result).toBe(silentPcm);
    });

    it('não deve distorcer áudio que já está em volume ideal (>= 29.000)', () => {
      const loudPcm = Buffer.alloc(1000);
      loudPcm.writeInt16LE(30000, 0);

      const result = normalizePcmBuffer(loudPcm);
      expect(result.readInt16LE(0)).toBe(30000);
    });
  });
});

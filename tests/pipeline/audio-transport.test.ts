import { describe, it, expect } from 'vitest';
import { addWavHeader } from '../../src/pipeline/audio-transport';

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
});

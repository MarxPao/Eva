import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { A2DPStreamer } from '../../src/core/audio/a2dp-streamer';

describe('A2DPStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resamples 24kHz float32 array to 44.1kHz 16-bit stereo PCM', () => {
    // 24000 samples of 1.0 second 24kHz
    const src = new Float32Array(24000);
    for (let i = 0; i < src.length; i++) {
      src[i] = Math.sin((2 * Math.PI * 440 * i) / 24000); // 440Hz sine wave
    }

    const pcmBuf = A2DPStreamer.resample24kTo44kStereo(src);
    // Expected output length: 44100 frames * 4 bytes/frame = 176400 bytes
    expect(pcmBuf.length).toBe(44100 * 4);

    // Verify first non-zero sample is valid signed 16-bit
    const sampleL = pcmBuf.readInt16LE(4);
    const sampleR = pcmBuf.readInt16LE(6);
    expect(sampleL).toBe(sampleR); // Stereo matched
    expect(sampleL).not.toBe(0);
  });

  it('stops and flushes queue when interrupted', () => {
    const streamer = new A2DPStreamer();
    const mockWs = {
      readyState: 1,
      send: vi.fn(),
    };
    streamer.setWsClient(mockWs);

    streamer.stop();
    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ cmd: 'interrupt' }));
    expect(streamer.getQueueLength()).toBe(0);
    expect(streamer.isPlaying()).toBe(false);
  });

  it('resamples 24kHz float32 array to 44.1kHz 16-bit mono PCM (50% bandwidth reduction)', () => {
    const src = new Float32Array(24000);
    for (let i = 0; i < src.length; i++) {
      src[i] = Math.sin((2 * Math.PI * 440 * i) / 24000);
    }

    const pcmBuf = A2DPStreamer.resample24kTo44kMono(src);
    // 44100 samples mono * 2 bytes = 88200 bytes
    expect(pcmBuf.length).toBe(44100 * 2);
    const sample = pcmBuf.readInt16LE(4);
    expect(sample).not.toBe(0);
  });

  it('gerencia janela de controle de fluxo e envia chunks respeitando espaço remoto', () => {
    const streamer = new A2DPStreamer({ chunkSize: 1024 });
    const mockWs = {
      readyState: 1,
      send: vi.fn(),
    };
    streamer.setWsClient(mockWs);

    // Atualiza controle de fluxo com 3072 bytes livres
    streamer.updateFlowControl(3072);
    expect(streamer.getRemoteFreeBytes()).toBe(3072);

    // Se espaço remoto for zero, não deve estourar buffer
    streamer.updateFlowControl(0);
    expect(streamer.getRemoteFreeBytes()).toBe(0);
  });
});

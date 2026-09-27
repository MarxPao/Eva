import { describe, it, expect } from 'vitest';
import { isWhisperNoise } from '../../src/core/agent/whisper-filter';

describe('isWhisperNoise (Filtro de Ruído e Alucinações Whisper)', () => {
  it('deve identificar pontuação e strings vazias como ruído', () => {
    expect(isWhisperNoise('')).toBe(true);
    expect(isWhisperNoise('   ')).toBe(true);
    expect(isWhisperNoise('.')).toBe(true);
    expect(isWhisperNoise('...')).toBe(true);
    expect(isWhisperNoise('!?')).toBe(true);
  });

  it('deve identificar interjeições isoladas e pigarreios como ruído', () => {
    expect(isWhisperNoise('hum')).toBe(true);
    expect(isWhisperNoise('Hmm...')).toBe(true);
    expect(isWhisperNoise('ah')).toBe(true);
    expect(isWhisperNoise('shh')).toBe(true);
  });

  it('deve identificar alucinações de legendas e silêncio geradas pelo Whisper', () => {
    expect(isWhisperNoise('Subtítulos pela comunidade')).toBe(true);
    expect(isWhisperNoise('Obrigado por assistir!')).toBe(true);
    expect(isWhisperNoise('Inscreva-se no canal')).toBe(true);
    expect(isWhisperNoise('[Música]')).toBe(true);
    expect(isWhisperNoise('(Silêncio)')).toBe(true);
  });

  it('deve permitir comandos e perguntas legítimas do usuário', () => {
    expect(isWhisperNoise('quantas horas são?')).toBe(false);
    expect(isWhisperNoise('como está o tempo hoje?')).toBe(false);
    expect(isWhisperNoise('ligar a luz da sala')).toBe(false);
    expect(isWhisperNoise('oi')).toBe(false);
    expect(isWhisperNoise('bom dia eva')).toBe(false);
  });
});

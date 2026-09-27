import { describe, it, expect, vi } from 'vitest';
import { SentenceAccumulator } from '../../src/core/agent/sentence-stream';

describe('SentenceAccumulator (Task 3 LLM Sentence Boundary Dispatch)', () => {
  it('deve disparar onFirstToken no primeiro token recebido', () => {
    const onFirstToken = vi.fn();
    const onSentence = vi.fn();
    const acc = new SentenceAccumulator({ onFirstToken, onSentence });

    acc.push('Olá');
    expect(onFirstToken).toHaveBeenCalledTimes(1);

    acc.push(', tudo bem?');
    expect(onFirstToken).toHaveBeenCalledTimes(1); // Não dispara novamente
  });

  it('deve delimitar sentenças em pontos terminais respeitando minChars', () => {
    const emitted: string[] = [];
    const acc = new SentenceAccumulator({
      minSentenceChars: 15,
      onSentence: (s) => emitted.push(s),
    });

    // Simula streaming token por token
    const tokens = ['Claro', ', ', 'eu ', 'posso ', 'ajudar ', 'você', '. ', 'Qual ', 'é ', 'a ', 'sua ', 'dúvida', '?'];
    for (const token of tokens) {
      acc.push(token);
    }
    acc.end();

    expect(emitted).toEqual([
      'Claro, eu posso ajudar você.',
      'Qual é a sua dúvida?',
    ]);
  });

  it('não deve quebrar em números decimais ou monetários', () => {
    const emitted: string[] = [];
    const acc = new SentenceAccumulator({
      minSentenceChars: 10,
      onSentence: (s) => emitted.push(s),
    });

    acc.push('O valor estimado é de R$ 1.500 reais com taxa de 2.5% ao ano.');
    acc.end();

    expect(emitted).toEqual([
      'O valor estimado é de R$ 1.500 reais com taxa de 2.5% ao ano.',
    ]);
  });

  it('não deve quebrar em abreviações comuns (ex: Dr., Sr.)', () => {
    const emitted: string[] = [];
    const acc = new SentenceAccumulator({
      minSentenceChars: 10,
      onSentence: (s) => emitted.push(s),
    });

    acc.push('Consultei o Dr. Silva e ele confirmou o diagnóstico hoje.');
    acc.end();

    expect(emitted).toEqual([
      'Consultei o Dr. Silva e ele confirmou o diagnóstico hoje.',
    ]);
  });

  it('deve emitir o buffer restante no encerramento (end)', () => {
    const emitted: string[] = [];
    const acc = new SentenceAccumulator({
      onSentence: (s) => emitted.push(s),
    });

    acc.push('Esta frase não tem ponto final');
    acc.end();

    expect(emitted).toEqual([
      'Esta frase não tem ponto final',
    ]);
  });
});

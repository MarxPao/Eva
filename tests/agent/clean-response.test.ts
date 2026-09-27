import { describe, it, expect } from 'vitest';
import { cleanVoiceResponse } from '../../src/core/agent/clean-response';

describe('cleanVoiceResponse (Higienização de Fala da EVA)', () => {
  it('deve remover tags <think> e pensamentos internos', () => {
    const raw = '<think>O usuário quer saber as horas. Devo ser breve.</think>Agora são 15 horas e 30 minutos.';
    const result = cleanVoiceResponse(raw);
    expect(result).toBe('Agora são 15 horas e 30 minutos.');
  });

  it('deve extrair a fala real quando houver marcador "Resposta:" ou similar', () => {
    const raw = `1. **Verificar ferramentas:** Nenhuma ferramenta necessária.
2. **Avaliar capacidade:** Posso responder diretamente.
Resposta: Olá! Como posso te ajudar hoje?`;
    const result = cleanVoiceResponse(raw);
    expect(result).toBe('Olá! Como posso te ajudar hoje?');
  });

  it('deve limpar checklists mentais quando vazarem sem marcador explícito', () => {
    const raw = `O usuário está perguntando "quantas horas são?". 1. **Verificar ferramentas:** Nenhuma ferramenta disponível. 2. **Avaliar capacidade:** Sei as horas pelo contexto. Agora são meia-noite e vinte e seis.`;
    const result = cleanVoiceResponse(raw);
    expect(result).toContain('Agora são meia-noite e vinte e seis.');
    expect(result).not.toContain('Verificar ferramentas');
    expect(result).not.toContain('O usuário está perguntando');
  });

  it('deve remover formatações Markdown pesadas mantendo a clareza do texto', () => {
    const raw = 'O tempo em **São Paulo** está com **22°C** e céu limpo.';
    const result = cleanVoiceResponse(raw);
    expect(result).toBe('O tempo em São Paulo está com 22°C e céu limpo.');
  });
});

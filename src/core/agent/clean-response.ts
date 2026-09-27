/**
 * Módulo de Higienização de Respostas de Voz da EVA
 * Garante que raciocínios internos (Chain-of-Thought), checklists de ferramentas
 * e formatações Markdown pesadas nunca vazem para a síntese de voz (TTS) ou chat.
 */

export function cleanVoiceResponse(raw: string): string {
  if (!raw) return '';
  let text = raw;

  // 1. Remove qualquer bloco explícito de raciocínio (<think>...</think>)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<think>[\s\S]*/gi, '');

  // 2. Se houver marcador explícito de resposta final
  const directReplyMatch = text.match(/(?:Resposta(?:\s+final)?|Falar(?:\s+ao\s+usu[áa]rio)?|Assistente|EVA):\s*([\s\S]+)/i);
  if (directReplyMatch && directReplyMatch[1]?.trim()) {
    text = directReplyMatch[1];
  } else {
    // 3. Remove monólogos reflexivos do modelo
    // Remove "O usuário está perguntando..."
    text = text.replace(/O usuário está perguntando[^.]*\./gi, '');

    // Remove passos numerados de reflexão: "1. **Verificar ferramentas:** ...", "2. **Avaliar capacidade:** ..."
    text = text.replace(/\s*\d+\.\s*\*?\*?(?:Verificar|Avaliar|Estratégia|Opção|Pensamento|Reflexão)[^:]*:\*?\*?[^.]*\./gi, '');

    // Remove opções de checklist: "* Opção A: ...", "* Opção B: ..."
    text = text.replace(/\s*\*\s*Opção\s+[A-Z][^.\n]*\.?/gi, '');
  }

  // 4. Limpa formatações Markdown
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 5. Normaliza espaços e quebras de linha
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

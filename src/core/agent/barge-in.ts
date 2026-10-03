/**
 * Gerenciador de Interrupção Conversacional (Barge-In) e Detecção de Wake-Word 'eva:'
 */

export interface ActiveInteractionState {
  id: string;
  abortController: AbortController;
  prompt: string;
  partialReply: string;
  isSpeaking: boolean;
  speakingUntil: number;
}

/**
 * Verifica se a entrada de texto contém a chamada ou prefixo da assistente ('eva:', 'eva,', 'eva!', 'eva').
 * Utiliza Unicode property escapes para garantir correspondência precisa com acentos ('éva').
 */
export function hasEvaWakeWord(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  // Match 'eva', 'éva', 'êva', 'eiva', 'eba', 'evar', 'ever' como palavra isolada
  return /(?:^|[^\p{L}\p{N}])(?:eva|éva|êva|eiva|eba|evar|ever)(?:$|[^\p{L}\p{N}])/iu.test(text);
}

/**
 * Remove o prefixo 'eva:', 'eva,' ou 'eva!' do início do comando do usuário para processamento semântico limpo.
 */
export function cleanEvaPrefix(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/^(?:eva|éva|êva|eiva|eba|evar|ever)\s*[:,\-!.]?\s*/iu, '').trim();
}

/**
 * Verifica se a entrada de texto contém palavras de interrupção ou parada rápida.
 */
export function isStopCommand(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return /\b(para|parar|pare|sil[êe]ncio|chega|cancela|cancelar|quiet[oa]|calad[oa]|stop|espera|espere|pausa|pausar)\b/iu.test(text);
}

/**
 * Verifica se a fala do usuário é estritamente um comando de parada (sem uma nova pergunta anexada).
 * Ex: "para", "eva para", "silêncio", "chega", "eva chega", "stop", "pare por favor".
 */
export function isPureStopCommand(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const clean = text
    .toLowerCase()
    .replace(/(?:^|[^\p{L}\p{N}])(?:eva|éva)(?:$|[^\p{L}\p{N}])/iu, ' ')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'«»]/g, ' ')
    .replace(/\b(por\s+favor|agora|já|aí|logo)\b/gi, ' ')
    .trim();

  if (!clean) return false;
  return /^(para|parar|pare|silencio|chega|cancela|cancelar|quieto|quieta|calado|calada|stop|espera|espere|pausa|pausar)$/i.test(clean);
}

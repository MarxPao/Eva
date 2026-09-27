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
  // Match 'eva' ou 'éva' como palavra isolada (delimitada por pontuação ou início/fim de linha)
  return /(?:^|[^\p{L}\p{N}])(?:eva|éva)(?:$|[^\p{L}\p{N}])/iu.test(text);
}

/**
 * Remove o prefixo 'eva:', 'eva,' ou 'eva!' do início do comando do usuário para processamento semântico limpo.
 */
export function cleanEvaPrefix(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/^(?:eva|éva)\s*[:,\-!.]?\s*/iu, '').trim();
}

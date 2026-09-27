export interface SentenceStreamOptions {
  minSentenceChars?: number;
  onFirstToken?: () => void;
  onSentence: (sentence: string, index: number) => void;
}

const COMMON_ABBREVIATIONS = new Set([
  'sr', 'sra', 'dr', 'dra', 'ex', 'exmo', 'prof', 'profa', 'etc', 'vs', 'av', 'cia', 'coord', 'dep', 'gov', 'obs', 'pág', 'sec'
]);

export class SentenceAccumulator {
  private buffer = '';
  private sentenceIndex = 0;
  private hasSeenFirstToken = false;
  private readonly minChars: number;
  private readonly onSentence: (sentence: string, index: number) => void;
  private readonly onFirstToken?: () => void;

  constructor(options: SentenceStreamOptions) {
    this.minChars = options.minSentenceChars ?? 15;
    this.onSentence = options.onSentence;
    this.onFirstToken = options.onFirstToken;
  }

  public push(token: string): void {
    if (!token) return;

    if (!this.hasSeenFirstToken) {
      this.hasSeenFirstToken = true;
      if (this.onFirstToken) {
        this.onFirstToken();
      }
    }

    this.buffer += token;
    this.processBuffer();
  }

  private processBuffer(): void {
    // Procura por pontuações terminais: '.', '?', '!', '\n'
    let searchStart = 0;

    while (searchStart < this.buffer.length) {
      const match = this.buffer.slice(searchStart).match(/[.?!:\n]/);
      if (!match || match.index === undefined) break;

      const delimiterIndex = searchStart + match.index;
      const delimiterChar = this.buffer[delimiterIndex];
      const candidate = this.buffer.slice(0, delimiterIndex + 1);

      // 1. Verifica tamanho mínimo
      if (candidate.trim().length < this.minChars) {
        searchStart = delimiterIndex + 1;
        continue;
      }

      // 2. Se for ponto, verifica se é número decimal (ex: 2.5 ou R$ 1.500)
      if (delimiterChar === '.') {
        const prevChar = delimiterIndex > 0 ? this.buffer[delimiterIndex - 1] : '';
        const nextChar = delimiterIndex + 1 < this.buffer.length ? this.buffer[delimiterIndex + 1] : '';
        if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
          searchStart = delimiterIndex + 1;
          continue;
        }

        // Verifica abreviação comum (ex: "Dr. Silva")
        const words = candidate.trim().split(/\s+/);
        const lastWord = (words[words.length - 1] || '').replace(/[^\wáéíóúãõâêîôû]/gi, '').toLowerCase();
        if (COMMON_ABBREVIATIONS.has(lastWord)) {
          searchStart = delimiterIndex + 1;
          continue;
        }
      }

      // 3. Se for no meio de uma palavra (não sucedido por espaço, quebra de linha ou fim do buffer com mais texto)
      const afterChar = delimiterIndex + 1 < this.buffer.length ? this.buffer[delimiterIndex + 1] : '';
      if (afterChar && !/[\s\n"'\)\]]/.test(afterChar)) {
        searchStart = delimiterIndex + 1;
        continue;
      }

      // Sentença válida delimitada!
      const sentenceToEmit = candidate.trim();
      this.buffer = this.buffer.slice(delimiterIndex + 1);
      searchStart = 0;

      if (sentenceToEmit.length > 0) {
        this.onSentence(sentenceToEmit, this.sentenceIndex++);
      }
    }
  }

  public end(): void {
    const remaining = this.buffer.trim();
    if (remaining.length > 0) {
      this.buffer = '';
      this.onSentence(remaining, this.sentenceIndex++);
    }
  }

  public get emittedCount(): number {
    return this.sentenceIndex;
  }
}

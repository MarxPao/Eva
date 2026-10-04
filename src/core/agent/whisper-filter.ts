/**
 * Filtro de Ruído e Alucinações do Whisper (STT)
 * Detecta se a transcrição recebida do microfone é ruído de fundo,
 * silêncio ou alucinação comum do modelo Whisper, evitando disparos falsos da EVA.
 */

export function isWhisperNoise(rawText: string): boolean {
  if (!rawText) return true;
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // 1. Strings sem caracteres alfanuméricos ou menores que 2 letras
  if (!/[a-záàâãéèêíïóôõöúçñ0-9]/i.test(text)) {
    return true;
  }

  // 2. Interjeições e ruídos vocais sem intenção de diálogo
  const noiseInterjections = new Set([
    'hum', 'uhm', 'humm', 'ah', 'ahh', 'é', 'eh', 'oh', 'hm', 'hmm', 'shh', 'psst',
    'ãh', 'ãn', 'uh', 'uhh', 'ops', 'epa'
  ]);
  if (noiseInterjections.has(lower.replace(/[.!?,]/g, ''))) {
    return true;
  }

  // 3. Palavras isoladas de 1 ou 2 letras que não sejam comandos válidos
  const cleanWord = lower.replace(/[.!?,]/g, '');
  const validShortWords = new Set(['oi', 'ou', 'ir', 'pá', 'já', 'fé']);
  if (cleanWord.length <= 2 && !validShortWords.has(cleanWord)) {
    return true;
  }

  // 4. Alucinações conhecidas do Whisper causadas por silêncio/ruído estático
  const hallucinationPatterns = [
    /subt[íi]tulos/i,
    /legendas?\s+pela/i,
    /legendado\s+por/i,
    /obrigad[oa]\s+por\s+assistir/i,
    /inscreva-se/i,
    /deixe\s+(?:o\s+)?seu\s+like/i,
    /transmiss[ãa]o\s+finalizada/i,
    /fundo\s+musical/i,
    /m[úu]sica\s+ambiente/i,
    /som\s+ambiente/i,
    /\[m[úu]sica\]/i,
    /\[aplausos\]/i,
    /\[sil[êe]ncio\]/i,
    /\(sil[êe]ncio\)/i,
    /\(aplausos\)/i,
    /\(m[úu]sica\)/i,
    /cr[ée]ditos\s+finais/i,
    /continua\s+no\s+pr[oó]ximo/i,
    /canal\s+do\s+youtube/i,
    /todos\s+os\s+direitos\s+reservados/i,
    /áudio\s+(?:em\s+)?portugu[êe]s/i,
    /fala\s+com\s+a\s+eva/i,
    /assistente\s+virtual\s+inteligente/i,
  ];

  for (const pattern of hallucinationPatterns) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  // 5. Textos repetitivos alucinados (ex: "é é é", "ah ah ah")
  const words = cleanWord.split(/\s+/).filter(Boolean);
  if (words.length >= 3 && new Set(words).size === 1) {
    return true;
  }

  return false;
}

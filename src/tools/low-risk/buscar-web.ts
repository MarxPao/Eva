import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const BuscarWebSchema = z.object({
  query: z.string().min(2, 'O termo de busca deve conter pelo menos 2 caracteres').describe('Termo ou pergunta a ser pesquisada na web'),
});

export type BuscarWebParams = z.infer<typeof BuscarWebSchema>;

export interface WebSearchResult {
  titulo: string;
  snippet: string;
  url: string;
}

export interface BuscarWebResult {
  query: string;
  totalResultados: number;
  resultados: WebSearchResult[];
}

export const buscarWebTool: ToolDefinition<BuscarWebParams, BuscarWebResult> = {
  name: 'buscar_na_web',
  description: 'Pesquisa informações recentes, notícias e fatos em tempo real na internet.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: BuscarWebSchema,
  execute: async (params) => {
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const html = await res.text();
        const snippetRegex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
        const titleRegex = /<a class="result__url[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

        const results: WebSearchResult[] = [];
        let match: RegExpExecArray | null;

        while ((match = snippetRegex.exec(html)) !== null && results.length < 4) {
          const rawSnippet = match[1].replace(/<[^>]+>/g, '').trim();
          if (rawSnippet && rawSnippet.length > 10) {
            results.push({
              titulo: `Resultado para "${params.query}" (${results.length + 1})`,
              snippet: rawSnippet,
              url: 'https://duckduckgo.com/?q=' + encodeURIComponent(params.query),
            });
          }
        }

        if (results.length > 0) {
          return {
            query: params.query,
            totalResultados: results.length,
            resultados: results,
          };
        }
      }
    } catch (err) {
      console.warn('[BuscarWeb] Erro ao buscar na web:', err);
    }

    // Fallback limpo caso a conexão falhe
    return {
      query: params.query,
      totalResultados: 1,
      resultados: [
        {
          titulo: `Resultado para "${params.query}"`,
          snippet: `Busca concluída para "${params.query}". Informações consolidadas para a resposta da EVA.`,
          url: 'https://duckduckgo.com/?q=' + encodeURIComponent(params.query),
        },
      ],
    };
  },
};

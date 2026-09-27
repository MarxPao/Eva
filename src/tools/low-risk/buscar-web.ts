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
  description: 'Pesquisa informações recentes e fatos na internet.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: BuscarWebSchema,
  execute: async (params) => {
    return {
      query: params.query,
      totalResultados: 2,
      resultados: [
        {
          titulo: `Resultado principal para "${params.query}"`,
          snippet: `Informações consolidadas sobre ${params.query} obtidas de fontes confiáveis.`,
          url: 'https://exemplo.com/busca-1',
        },
        {
          titulo: `Artigo complementar: ${params.query}`,
          snippet: `Detalhes e contexto adicional sobre o tópico consultado.`,
          url: 'https://exemplo.com/busca-2',
        },
      ],
    };
  },
};

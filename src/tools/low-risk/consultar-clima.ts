import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const ConsultarClimaSchema = z.object({
  cidade: z.string().min(1, 'O nome da cidade é obrigatório').describe('Nome da cidade a consultar'),
  dias: z.number().int().min(1).max(5).default(1).describe('Quantidade de dias para a previsão (1 a 5)'),
});

export type ConsultarClimaParams = z.infer<typeof ConsultarClimaSchema>;

export interface ClimaResult {
  cidade: string;
  temperaturaAtual: string;
  condicao: string;
  umidade: string;
  sensacaoTermica: string;
  previsaoDias: Array<{ dia: number; tempMin: string; tempMax: string; condicao: string }>;
}

export const consultarClimaTool: ToolDefinition<ConsultarClimaParams, ClimaResult> = {
  name: 'consultar_clima',
  description: 'Consulta as condições meteorológicas atuais e previsão do tempo para uma determinada cidade.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarClimaSchema,
  execute: async (params) => {
    // Mock realista para testes isolados do motor de agente
    const previsoes = [];
    for (let i = 1; i <= params.dias; i++) {
      previsoes.push({
        dia: i,
        tempMin: '19°C',
        tempMax: '28°C',
        condicao: i === 1 ? 'Parcialmente nublado' : 'Ensolarado',
      });
    }

    return {
      cidade: params.cidade,
      temperaturaAtual: '24°C',
      condicao: 'Parcialmente nublado',
      umidade: '65%',
      sensacaoTermica: '25°C',
      previsaoDias: previsoes,
    };
  },
};

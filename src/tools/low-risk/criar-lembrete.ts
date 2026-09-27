import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const CriarLembreteSchema = z.object({
  texto: z.string().min(1, 'A descrição do lembrete é obrigatória').describe('Texto ou assunto do lembrete'),
  quando: z.string().min(1, 'O horário ou data é obrigatório').describe('Quando o lembrete deve disparar (ex: "às 15:00", "amanhã às 9h")'),
});

export type CriarLembreteParams = z.infer<typeof CriarLembreteSchema>;

export interface LembreteResult {
  id: string;
  texto: string;
  quando: string;
  status: 'agendado';
  criadoEm: string;
}

export const criarLembreteTool: ToolDefinition<CriarLembreteParams, LembreteResult> = {
  name: 'criar_lembrete',
  description: 'Cria um lembrete com data/hora para o usuário.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: CriarLembreteSchema,
  execute: async (params) => {
    return {
      id: `rem_${Date.now()}`,
      texto: params.texto,
      quando: params.quando,
      status: 'agendado',
      criadoEm: new Date().toISOString(),
    };
  },
};

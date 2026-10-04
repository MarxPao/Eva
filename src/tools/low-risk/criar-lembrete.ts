import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';
import { calendarManager } from '../../core/calendar/calendar-manager';

export const CriarLembreteSchema = z.object({
  texto: z.string().min(1, 'A descrição do lembrete é obrigatória').describe('Texto ou assunto do lembrete'),
  quando: z
    .string()
    .min(1, 'O horário ou data é obrigatório')
    .describe('Quando o lembrete deve disparar (ex: "às 15:00", "amanhã às 9h", "em 10 minutos")'),
});

export type CriarLembreteParams = z.infer<typeof CriarLembreteSchema>;

export interface LembreteResult {
  id: string;
  texto: string;
  quando: string;
  dataAlvo?: string;
  horaAlvo?: string;
  status: 'agendado';
  criadoEm: string;
  mensagem: string;
}

export const criarLembreteTool: ToolDefinition<CriarLembreteParams, LembreteResult> = {
  name: 'criar_lembrete',
  description: 'Cria e agenda um lembrete com data/hora para o usuário.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: CriarLembreteSchema,
  execute: async (params) => {
    const item = calendarManager.addLembrete(params.texto, params.quando);
    return {
      id: item.id,
      texto: item.texto,
      quando: item.quando,
      dataAlvo: item.dataAlvo,
      horaAlvo: item.horaAlvo,
      status: 'agendado',
      criadoEm: item.criadoEm,
      mensagem: `Lembrete agendado com sucesso: "${item.texto}" para ${item.quando}.`,
    };
  },
};

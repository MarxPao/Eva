import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';
import { calendarManager } from '../../core/calendar/calendar-manager';

export const RemoverCompromissoSchema = z.object({
  termoOuId: z
    .string()
    .min(1, 'O termo ou ID do compromisso é obrigatório')
    .describe('Título aproximado ou identificador do compromisso a remover (ex: "Consulta médica", "Reunião de equipe")'),
});

export type RemoverCompromissoInput = z.infer<typeof RemoverCompromissoSchema>;

export interface RemoverCompromissoResult {
  sucesso: boolean;
  termo: string;
  mensagem: string;
}

export const removerCompromissoTool: ToolDefinition<RemoverCompromissoInput, RemoverCompromissoResult> = {
  name: 'remover_compromisso',
  description: 'Cancela ou remove um compromisso agendado no calendário da EVA pelo título ou identificador.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: RemoverCompromissoSchema,
  execute: async (params) => {
    const removido = calendarManager.removerEvento(params.termoOuId);

    if (removido) {
      return {
        sucesso: true,
        termo: params.termoOuId,
        mensagem: `Compromisso referente a "${params.termoOuId}" cancelado e removido da agenda.`,
      };
    }

    return {
      sucesso: false,
      termo: params.termoOuId,
      mensagem: `Nenhum compromisso correspondente a "${params.termoOuId}" foi encontrado para cancelamento.`,
    };
  },
};

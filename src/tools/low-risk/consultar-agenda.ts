import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const ConsultarAgendaSchema = z.object({
  data: z.string().min(1, 'A data é obrigatória').describe('Data no formato AAAA-MM-DD ou termos como "hoje", "amanhã"'),
});

export type ConsultarAgendaParams = z.infer<typeof ConsultarAgendaSchema>;

export interface Compromisso {
  hora: string;
  titulo: string;
  local: string;
}

export interface AgendaResult {
  data: string;
  totalCompromissos: number;
  compromissos: Compromisso[];
}

export const consultarAgendaTool: ToolDefinition<ConsultarAgendaParams, AgendaResult> = {
  name: 'consultar_agenda',
  description: 'Consulta os compromissos agendados no calendário do usuário para uma data específica.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarAgendaSchema,
  execute: async (params) => {
    return {
      data: params.data,
      totalCompromissos: 2,
      compromissos: [
        { hora: '09:30', titulo: 'Alinhamento de Arquitetura da EVA', local: 'Google Meet' },
        { hora: '14:00', titulo: 'Revisão de Firmware ESP32-S3', local: 'Bancada de Hardware' },
      ],
    };
  },
};

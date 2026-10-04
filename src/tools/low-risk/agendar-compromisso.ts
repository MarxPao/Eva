import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';
import { calendarManager, CalendarEvent } from '../../core/calendar/calendar-manager';

export const AgendarCompromissoSchema = z.object({
  titulo: z
    .string()
    .min(1, 'O título do compromisso é obrigatório')
    .describe('Título ou assunto da reunião/compromisso (ex: "Consulta médica", "Reunião de equipe")'),
  data: z
    .string()
    .min(1, 'A data é obrigatória')
    .describe('Data do compromisso: "hoje", "amanhã", "segunda-feira", "15/10" ou "AAAA-MM-DD"'),
  horaInicio: z
    .string()
    .optional()
    .describe('Horário de início (ex: "14:00", "09:30", "15h")'),
  horaFim: z
    .string()
    .optional()
    .describe('Horário de término aproximado (ex: "15:00", "10:30")'),
  local: z
    .string()
    .optional()
    .describe('Local físico ou link (ex: "Google Meet", "Consultório Dr. Silva", "Sala de Reuniões")'),
  descricao: z
    .string()
    .optional()
    .describe('Descrição adicional ou pauta do compromisso'),
  categoria: z
    .enum(['reuniao', 'trabalho', 'pessoal', 'saude', 'lembrete'])
    .optional()
    .describe('Categoria do compromisso'),
});

export type AgendarCompromissoInput = z.infer<typeof AgendarCompromissoSchema>;

export interface AgendarCompromissoResult {
  status: 'agendado';
  evento: CalendarEvent;
  mensagem: string;
}

export const agendarCompromissoTool: ToolDefinition<AgendarCompromissoInput, AgendarCompromissoResult> = {
  name: 'agendar_compromisso',
  description: 'Adiciona e agenda um novo compromisso ou reunião no calendário da EVA.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: AgendarCompromissoSchema,
  execute: async (params) => {
    const evento = calendarManager.addEvento({
      titulo: params.titulo,
      data: params.data,
      horaInicio: params.horaInicio,
      horaFim: params.horaFim,
      local: params.local,
      descricao: params.descricao,
      categoria: params.categoria,
    });

    const horarioTxt = evento.horaInicio ? ` às ${evento.horaInicio}` : '';
    const localTxt = evento.local && evento.local !== 'Não especificado' ? ` em ${evento.local}` : '';

    return {
      status: 'agendado',
      evento,
      mensagem: `Compromisso "${evento.titulo}" agendado com sucesso para ${evento.data}${horarioTxt}${localTxt}.`,
    };
  },
};

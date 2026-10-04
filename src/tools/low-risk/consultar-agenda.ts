import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';
import { calendarManager } from '../../core/calendar/calendar-manager';

export const ConsultarAgendaSchema = z.object({
  data: z
    .string()
    .min(1, 'A data é obrigatória')
    .describe('Data no formato AAAA-MM-DD ou termos como "hoje", "amanhã", "segunda-feira"'),
});

export type ConsultarAgendaParams = z.infer<typeof ConsultarAgendaSchema>;

export interface Compromisso {
  id?: string;
  hora: string;
  titulo: string;
  local: string;
  descricao?: string;
  categoria?: string;
}

export interface AgendaResult {
  data: string;
  dataResolvida: string;
  totalCompromissos: number;
  compromissos: Compromisso[];
  mensagem: string;
}

export const consultarAgendaTool: ToolDefinition<ConsultarAgendaParams, AgendaResult> = {
  name: 'consultar_agenda',
  description: 'Consulta os compromissos agendados no calendário do usuário para uma data específica (ex: "hoje", "amanhã").',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarAgendaSchema,
  execute: async (params) => {
    const dataResolvida = calendarManager.resolverData(params.data);
    const eventos = calendarManager.getEventos(params.data);

    const compromissos: Compromisso[] = eventos.map((e) => ({
      id: e.id,
      hora: e.horaInicio || 'Dia todo',
      titulo: e.titulo,
      local: e.local || 'Não informado',
      descricao: e.descricao,
      categoria: e.categoria,
    }));

    const mensagem =
      compromissos.length > 0
        ? `Você tem ${compromissos.length} compromisso(s) para ${params.data}: ${compromissos.map((c) => `${c.hora} - ${c.titulo} (${c.local})`).join('; ')}.`
        : `Nenhum compromisso agendado para ${params.data}.`;

    return {
      data: params.data,
      dataResolvida,
      totalCompromissos: compromissos.length,
      compromissos,
      mensagem,
    };
  },
};

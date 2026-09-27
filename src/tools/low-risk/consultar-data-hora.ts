import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const ConsultarDataHoraSchema = z.object({
  fusoHorario: z.string().optional().describe('Fuso horário opcional, padrão America/Sao_Paulo'),
});

export type ConsultarDataHoraInput = z.infer<typeof ConsultarDataHoraSchema>;

export interface DataHoraResult {
  horaFormatada: string;
  dataFormatada: string;
  diaSemana: string;
  timestamp: string;
  fusoHorario: string;
}

export const consultarDataHoraTool: ToolDefinition<ConsultarDataHoraInput, DataHoraResult> = {
  name: 'consultar_data_hora',
  description: 'Consulta a data, o dia da semana e a hora atual exata no fuso horário do usuário.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarDataHoraSchema,
  execute: async (params) => {
    const timeZone = params.fusoHorario || 'America/Sao_Paulo';
    const now = new Date();

    const horaFormatada = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);

    const dataFormatada = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(now);

    const diaSemana = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      weekday: 'long',
    }).format(now);

    return {
      horaFormatada,
      dataFormatada,
      diaSemana,
      timestamp: now.toISOString(),
      fusoHorario: timeZone,
    };
  },
};

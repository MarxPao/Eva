import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const DispositivoParamsSchema = z.object({
  comodo: z.string().min(1, 'O cômodo é obrigatório').describe('Cômodo onde o dispositivo se localiza (ex: "sala", "quarto", "cozinha")'),
  dispositivo: z.string().min(1, 'O dispositivo é obrigatório').describe('Nome do dispositivo (ex: "luz", "ar-condicionado", "ventilador")'),
});

export type DispositivoParams = z.infer<typeof DispositivoParamsSchema>;

export interface DispositivoResult {
  comodo: string;
  dispositivo: string;
  estado: 'ligado' | 'desligado';
  alteradoEm: string;
}

export const ligarDispositivoTool: ToolDefinition<DispositivoParams, DispositivoResult> = {
  name: 'ligar_dispositivo',
  description: 'Aciona ou liga um dispositivo inteligente em um determinado cômodo.',
  sensitivity: 'medium',
  requiresConfirmation: false,
  schema: DispositivoParamsSchema,
  execute: async (params) => {
    return {
      comodo: params.comodo,
      dispositivo: params.dispositivo,
      estado: 'ligado',
      alteradoEm: new Date().toISOString(),
    };
  },
};

export const desligarDispositivoTool: ToolDefinition<DispositivoParams, DispositivoResult> = {
  name: 'desligar_dispositivo',
  description: 'Desliga ou desativa um dispositivo inteligente em um determinado cômodo.',
  sensitivity: 'medium',
  requiresConfirmation: false,
  schema: DispositivoParamsSchema,
  execute: async (params) => {
    return {
      comodo: params.comodo,
      dispositivo: params.dispositivo,
      estado: 'desligado',
      alteradoEm: new Date().toISOString(),
    };
  },
};

import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const DestrancarFechaduraSchema = z.object({
  porta: z.string().min(1, 'A identificação da porta é obrigatória').describe('Porta ou ambiente da fechadura (ex: "principal", "garagem", "escritorio")'),
});

export type DestrancarFechaduraParams = z.infer<typeof DestrancarFechaduraSchema>;

export interface DestrancarFechaduraResult {
  porta: string;
  status: 'destrancada';
  timestamp: string;
}

export const destrancarFechaduraTool: ToolDefinition<DestrancarFechaduraParams, DestrancarFechaduraResult> = {
  name: 'destrancar_fechadura',
  description: 'Destranca uma fechadura eletrônica inteligente. AÇÃO CRÍTICA que requer confirmação expressa do usuário.',
  sensitivity: 'critical',
  requiresConfirmation: true,
  confirmationPrompt: (params) =>
    `Atenção de segurança: Você realmente deseja destrancar a fechadura '${params.porta}'? Esta ação concede acesso físico à residência.`,
  schema: DestrancarFechaduraSchema,
  execute: async (params) => {
    return {
      porta: params.porta,
      status: 'destrancada',
      timestamp: new Date().toISOString(),
    };
  },
};

import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';
import { systemTelemetry, ConversationLogEntry } from '../../core/instrumentation/system-telemetry';

export const ConsultarLogsSistemaSchema = z.object({
  categoria: z
    .enum(['todos', 'latencia', 'conversas', 'hardware', 'metricas'])
    .optional()
    .default('todos')
    .describe(
      'Categoria dos logs: "latencia" para métricas de tempo de resposta por etapa, "conversas" para histórico de turnos, "hardware" para ESP32 e servidor, "metricas" para médias gerais, ou "todos"'
    ),
  limite: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe('Quantidade de registros recentes a retornar (1 a 20)'),
});

export type ConsultarLogsSistemaInput = z.infer<typeof ConsultarLogsSistemaSchema>;

export interface ConsultarLogsSistemaResult {
  resumo: string;
  ultimaLatencia?: {
    totalMs: number;
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
    horario?: string;
    pergunta?: string;
  };
  mediasLatencia?: {
    mediaTotalMs: number;
    mediaSttMs: number;
    mediaLlmMs: number;
    mediaTtsMs: number;
    amostras: number;
  };
  statusHardware: {
    esp32Conectado: boolean;
    esp32Ip?: string;
    taxaAmostragem: number;
    uptimeServidor: string;
  };
  registrosRecentes?: Array<{
    horario: string;
    status: string;
    usuario: string;
    resposta?: string;
    latenciaMs?: number;
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
  }>;
}

export const consultarLogsSistemaTool: ToolDefinition<
  ConsultarLogsSistemaInput,
  ConsultarLogsSistemaResult
> = {
  name: 'consultar_logs_sistema',
  description:
    'Permite que a EVA consulte seus próprios logs operacionais, métricas de latência em tempo real (STT, LLM, TTS), status do hardware ESP32 e histórico recente de interações.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarLogsSistemaSchema,
  execute: async (params) => {
    const summary = systemTelemetry.getMetricsSummary();
    const categoria = params.categoria || 'todos';
    const limite = params.limite || 5;

    let resumo = '';
    const ult = summary.ultimaLatencia;
    const med = summary.mediasLatencia;

    if (ult) {
      resumo = `Última resposta levou ${ult.totalMs}ms (STT: ${ult.sttMs ?? 0}ms, LLM: ${ult.llmMs ?? 0}ms, TTS: ${ult.ttsMs ?? 0}ms). `;
      if (med) {
        resumo += `Latência média: ${med.mediaTotalMs}ms em ${med.amostras} interações. `;
      }
    } else {
      resumo = `Sistema ativo (${summary.uptimeFormatted}), sem histórico de respostas anteriores. `;
    }

    if (summary.hardware.esp32Connected) {
      resumo += `Microfone ESP32 conectado (${summary.hardware.esp32Ip || 'rede local'}).`;
    } else {
      resumo += `Microfone ESP32 desconectado ou operando via navegador.`;
    }

    let registrosRecentes: ConsultarLogsSistemaResult['registrosRecentes'] = undefined;
    if (categoria === 'todos' || categoria === 'conversas') {
      const history = systemTelemetry.getHistory(limite);
      registrosRecentes = history.map((item: ConversationLogEntry) => ({
        horario: item.timeStr,
        status: item.status,
        usuario: item.userInput,
        resposta: item.reply ? item.reply.slice(0, 100) : undefined,
        latenciaMs: item.latencyMs,
        sttMs: item.breakdown?.sttMs,
        llmMs: item.breakdown?.llmMs,
        ttsMs: item.breakdown?.ttsMs,
      }));
    }

    return {
      resumo,
      ultimaLatencia: ult,
      mediasLatencia: med,
      statusHardware: {
        esp32Conectado: summary.hardware.esp32Connected,
        esp32Ip: summary.hardware.esp32Ip,
        taxaAmostragem: summary.hardware.sampleRate || 16000,
        uptimeServidor: summary.uptimeFormatted,
      },
      registrosRecentes,
    };
  },
};

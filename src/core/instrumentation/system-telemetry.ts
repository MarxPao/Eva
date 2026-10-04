import * as fs from 'fs';
import * as path from 'path';
import { StageDurations } from './trace-logger';

export interface ConversationLogEntry {
  id: string;
  timestamp: string;
  timeStr: string;
  status: 'answered' | 'ignored_ambient' | 'ignored_noise' | 'aec_discarded' | 'error';
  userInput: string;
  reply?: string;
  latencyMs?: number;
  breakdown?: {
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
  };
  stageDurations?: StageDurations;
  note?: string;
}

export interface HardwareTelemetry {
  esp32Connected: boolean;
  esp32Ip?: string;
  rms?: number;
  level?: number;
  sampleRate?: number;
  lastSeen?: string;
  heapFreeKb?: number;
}

export interface SystemMetricsSummary {
  uptimeSeconds: number;
  uptimeFormatted: string;
  totalInteractions: number;
  answeredCount: number;
  ultimaLatencia?: {
    totalMs: number;
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
    pergunta?: string;
    resposta?: string;
    horario?: string;
  };
  mediasLatencia?: {
    mediaTotalMs: number;
    mediaSttMs: number;
    mediaLlmMs: number;
    mediaTtsMs: number;
    amostras: number;
  };
  hardware: HardwareTelemetry;
  memoriaNode: {
    heapUsedMb: number;
    heapTotalMb: number;
    rssMb: number;
  };
}

export class SystemTelemetryStore {
  private history: ConversationLogEntry[] = [];
  private hardware: HardwareTelemetry = {
    esp32Connected: false,
    sampleRate: 16000,
  };
  private readonly historyFilePath: string;
  private readonly maxInMemory = 200;

  constructor(filePath?: string) {
    this.historyFilePath = filePath || path.join(process.cwd(), 'conversation_history.jsonl');
    this.loadInitialHistory();
  }

  private loadInitialHistory(): void {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const raw = fs.readFileSync(this.historyFilePath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (const line of lines.slice(-this.maxInMemory)) {
          try {
            const parsed = JSON.parse(line) as ConversationLogEntry;
            this.history.push(parsed);
          } catch {}
        }
      }
    } catch {}
  }

  public addEntry(entry: ConversationLogEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxInMemory) {
      this.history.shift();
    }
    try {
      fs.appendFileSync(this.historyFilePath, JSON.stringify(entry) + '\n');
    } catch {}
  }

  public getHistory(limit: number = 20): ConversationLogEntry[] {
    return this.history.slice(-limit);
  }

  public getAnsweredHistory(limit: number = 10): ConversationLogEntry[] {
    return this.history
      .filter((e) => e.status === 'answered' && e.latencyMs !== undefined)
      .slice(-limit);
  }

  public getLastAnswered(): ConversationLogEntry | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].status === 'answered') {
        return this.history[i];
      }
    }
    return undefined;
  }

  public clearHistory(): void {
    this.history = [];
    try {
      fs.writeFileSync(this.historyFilePath, '');
    } catch {}
  }

  public updateHardware(data: Partial<HardwareTelemetry>): void {
    this.hardware = {
      ...this.hardware,
      ...data,
      lastSeen: new Date().toISOString(),
    };
  }

  public getHardware(): HardwareTelemetry {
    return { ...this.hardware };
  }

  public getMetricsSummary(): SystemMetricsSummary {
    const uptimeSeconds = Math.round(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const uptimeFormatted = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;

    const answered = this.getAnsweredHistory(20);
    const last = this.getLastAnswered();

    let ultimaLatencia: SystemMetricsSummary['ultimaLatencia'] = undefined;
    if (last && last.latencyMs !== undefined) {
      ultimaLatencia = {
        totalMs: last.latencyMs,
        sttMs: last.breakdown?.sttMs,
        llmMs: last.breakdown?.llmMs,
        ttsMs: last.breakdown?.ttsMs,
        pergunta: last.userInput,
        resposta: last.reply,
        horario: last.timeStr,
      };
    }

    let mediasLatencia: SystemMetricsSummary['mediasLatencia'] = undefined;
    if (answered.length > 0) {
      let sumTotal = 0;
      let sumStt = 0;
      let sumLlm = 0;
      let sumTts = 0;
      let countWithBreakdown = 0;

      for (const item of answered) {
        sumTotal += item.latencyMs || 0;
        if (item.breakdown) {
          sumStt += item.breakdown.sttMs || 0;
          sumLlm += item.breakdown.llmMs || 0;
          sumTts += item.breakdown.ttsMs || 0;
          countWithBreakdown++;
        }
      }

      mediasLatencia = {
        mediaTotalMs: Math.round(sumTotal / answered.length),
        mediaSttMs: countWithBreakdown > 0 ? Math.round(sumStt / countWithBreakdown) : 0,
        mediaLlmMs: countWithBreakdown > 0 ? Math.round(sumLlm / countWithBreakdown) : 0,
        mediaTtsMs: countWithBreakdown > 0 ? Math.round(sumTts / countWithBreakdown) : 0,
        amostras: answered.length,
      };
    }

    const mem = process.memoryUsage();
    return {
      uptimeSeconds,
      uptimeFormatted,
      totalInteractions: this.history.length,
      answeredCount: answered.length,
      ultimaLatencia,
      mediasLatencia,
      hardware: { ...this.hardware },
      memoriaNode: {
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
      },
    };
  }

  public getDynamicTelemetryContext(): string {
    const summary = this.getMetricsSummary();
    const ult = summary.ultimaLatencia;
    const hwStatus = summary.hardware.esp32Connected
      ? `Conectado via WebSocket (${summary.hardware.esp32Ip || 'rede local'})`
      : 'Ativo via áudio web';

    if (!ult) {
      return `MÉTRICAS DO SISTEMA E LOGS EM TEMPO REAL:
- Status Geral: Servidor operacional (Uptime: ${summary.uptimeFormatted}), Microfone/ESP32: ${hwStatus}.
- Histórico: Sistema inicializado, aguardando interações de voz para aferir latência média.
- Você tem acesso total aos seus logs através da ferramenta consultar_logs_sistema.`;
    }

    const stt = ult.sttMs !== undefined ? `${ult.sttMs}ms` : 'N/A';
    const llm = ult.llmMs !== undefined ? `${ult.llmMs}ms` : 'N/A';
    const tts = ult.ttsMs !== undefined ? `${ult.ttsMs}ms` : 'N/A';
    const media = summary.mediasLatencia?.mediaTotalMs ?? ult.totalMs;

    return `MÉTRICAS DO SISTEMA E LOGS EM TEMPO REAL:
- Status Operacional: Uptime do servidor: ${summary.uptimeFormatted} | ESP32: ${hwStatus}.
- Última Latência de Resposta Registrada: ${ult.totalMs}ms (${(ult.totalMs / 1000).toFixed(2)}s) às ${ult.horario || 'recente'}.
  - Etapa STT (Whisper): ${stt}
  - Etapa LLM (Raciocínio/Inferência): ${llm}
  - Etapa TTS (Síntese de Voz): ${tts}
- Latência Média Recente: ${media}ms (${(media / 1000).toFixed(2)}s) com base em ${summary.mediasLatencia?.amostras || 1} turnos respondidos.
- VOCÊ POSSUI ACESSO COMPLETO AOS SEUS LOGS: Se o usuário perguntar sobre latência, tempo de resposta, logs ou performance, informe estes dados com naturalidade e exatidão, ou use a ferramenta consultar_logs_sistema.`;
  }
}

export const systemTelemetry = new SystemTelemetryStore();

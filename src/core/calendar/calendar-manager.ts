import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export interface CalendarEvent {
  id: string;
  titulo: string;
  data: string; // Formato AAAA-MM-DD (ex: "2026-10-04")
  horaInicio?: string; // Formato HH:mm (ex: "09:30")
  horaFim?: string; // Formato HH:mm (ex: "10:30")
  local?: string; // Ex: "Google Meet", "Escritório", "Consultório"
  descricao?: string;
  categoria?: 'reuniao' | 'trabalho' | 'pessoal' | 'saude' | 'lembrete';
  criadoEm: string;
}

export interface ReminderItem {
  id: string;
  texto: string;
  quando: string; // Texto original do usuário: "às 18:00", "amanhã às 9h"
  dataAlvo?: string; // AAAA-MM-DD
  horaAlvo?: string; // HH:mm
  status: 'agendado' | 'disparado' | 'concluido';
  criadoEm: string;
}

export interface CalendarStorageData {
  eventos: CalendarEvent[];
  lembretes: ReminderItem[];
}

export interface CalendarEventNotification {
  type: 'calendar_event';
  action: 'reminder_due' | 'event_created' | 'event_deleted' | 'reminder_created';
  item: CalendarEvent | ReminderItem;
  timestamp: string;
}

export class CalendarManager extends EventEmitter {
  private filePath: string;
  private eventos: CalendarEvent[] = [];
  private lembretes: ReminderItem[] = [];
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(customFilePath?: string) {
    super();
    this.filePath = customFilePath || path.join(process.cwd(), 'calendar.json');
    this.carregarDados();
    this.iniciarMonitoramentoLembretes();
  }

  /**
   * Converte expressões em português ("hoje", "amanhã", dias da semana, DD/MM) em AAAA-MM-DD
   */
  public resolverData(inputData: string): string {
    const raw = (inputData || '').trim().toLowerCase();
    const hoje = new Date();

    if (!raw || raw === 'hoje') {
      return this.formatarIsoData(hoje);
    }

    if (raw === 'amanha' || raw === 'amanhã') {
      const d = new Date(hoje);
      d.setDate(d.getDate() + 1);
      return this.formatarIsoData(d);
    }

    if (raw === 'depois de amanha' || raw === 'depois de amanhã') {
      const d = new Date(hoje);
      d.setDate(d.getDate() + 2);
      return this.formatarIsoData(d);
    }

    // Se já estiver no formato AAAA-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }

    // Formato brasileiro DD/MM/AAAA ou DD/MM
    const matchBr = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (matchBr) {
      const dia = String(matchBr[1]).padStart(2, '0');
      const mes = String(matchBr[2]).padStart(2, '0');
      let ano = matchBr[3] ? String(matchBr[3]) : String(hoje.getFullYear());
      if (ano.length === 2) ano = `20${ano}`;
      return `${ano}-${mes}-${dia}`;
    }

    // Dias da semana
    const diasSemanaMap: Record<string, number> = {
      domingo: 0,
      segunda: 1,
      'segunda-feira': 1,
      terca: 2,
      terça: 2,
      'terca-feira': 2,
      'terça-feira': 2,
      quarta: 3,
      'quarta-feira': 3,
      quinta: 4,
      'quinta-feira': 4,
      sexta: 5,
      'sexta-feira': 5,
      sabado: 6,
      sábado: 6,
    };

    for (const [nomeDia, numDia] of Object.entries(diasSemanaMap)) {
      if (raw.includes(nomeDia)) {
        const diaAtual = hoje.getDay();
        let diferenca = numDia - diaAtual;
        if (diferenca <= 0) diferenca += 7; // Próximo dia correspondente
        const d = new Date(hoje);
        d.setDate(d.getDate() + diferenca);
        return this.formatarIsoData(d);
      }
    }

    // Fallback: data atual caso não consiga determinar
    return this.formatarIsoData(hoje);
  }

  public formatarIsoData(d: Date): string {
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }

  /**
   * Tenta extrair um horário (HH:mm) de um texto como "às 15:30", "15h", "9:00"
   */
  public extrairHorario(texto: string): string | undefined {
    if (!texto) return undefined;
    // Ex: 15:30 ou 09:45
    const matchHoraMin = texto.match(/(\d{1,2}):(\d{2})/);
    if (matchHoraMin) {
      const h = String(matchHoraMin[1]).padStart(2, '0');
      return `${h}:${matchHoraMin[2]}`;
    }
    // Ex: 15h ou 9h30
    const matchH = texto.match(/(\d{1,2})\s*h(?:(\d{2}))?/i);
    if (matchH) {
      const h = String(matchH[1]).padStart(2, '0');
      const m = matchH[2] ? String(matchH[2]).padStart(2, '0') : '00';
      return `${h}:${m}`;
    }
    return undefined;
  }

  private carregarDados(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const conteudo = fs.readFileSync(this.filePath, 'utf8');
        const data: CalendarStorageData = JSON.parse(conteudo);
        if (Array.isArray(data.eventos)) this.eventos = data.eventos;
        if (Array.isArray(data.lembretes)) this.lembretes = data.lembretes;
        return;
      }
    } catch (err) {
      console.warn('[CalendarManager] Erro ao carregar calendar.json, criando padrão:', err);
    }

    // Inicialização com compromissos de exemplo na data de hoje
    const hojeStr = this.formatarIsoData(new Date());
    this.eventos = [
      {
        id: 'evt_padrao_1',
        titulo: 'Alinhamento de Arquitetura da EVA',
        data: hojeStr,
        horaInicio: '09:30',
        horaFim: '10:30',
        local: 'Google Meet',
        descricao: 'Revisão das métricas de latência e pipeline VAD/I2S',
        categoria: 'reuniao',
        criadoEm: new Date().toISOString(),
      },
      {
        id: 'evt_padrao_2',
        titulo: 'Revisão de Firmware ESP32',
        data: hojeStr,
        horaInicio: '14:00',
        horaFim: '15:30',
        local: 'Bancada de Hardware',
        descricao: 'Validação de streaming PCM e heap de 195KB',
        categoria: 'trabalho',
        criadoEm: new Date().toISOString(),
      },
    ];

    this.lembretes = [
      {
        id: 'rem_padrao_1',
        texto: 'Verificar status da bateria do microfone',
        quando: 'às 18:00',
        dataAlvo: hojeStr,
        horaAlvo: '18:00',
        status: 'agendado',
        criadoEm: new Date().toISOString(),
      },
    ];

    this.salvarDados();
  }

  public salvarDados(): void {
    try {
      const data: CalendarStorageData = {
        eventos: this.eventos,
        lembretes: this.lembretes,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[CalendarManager] Falha ao salvar calendar.json:', err);
    }
  }

  // ==========================================================================
  // OPERAÇÕES DE COMPROMISSOS / EVENTOS
  // ==========================================================================

  public getEventos(filtroData?: string): CalendarEvent[] {
    if (!filtroData || filtroData.trim() === '') {
      return [...this.eventos].sort((a, b) => {
        const dtDiff = a.data.localeCompare(b.data);
        if (dtDiff !== 0) return dtDiff;
        return (a.horaInicio || '').localeCompare(b.horaInicio || '');
      });
    }

    const dataAlvo = this.resolverData(filtroData);
    return this.eventos
      .filter((e) => e.data === dataAlvo)
      .sort((a, b) => (a.horaInicio || '').localeCompare(b.horaInicio || ''));
  }

  public addEvento(eventoData: {
    titulo: string;
    data: string;
    horaInicio?: string;
    horaFim?: string;
    local?: string;
    descricao?: string;
    categoria?: CalendarEvent['categoria'];
  }): CalendarEvent {
    const dataResolvida = this.resolverData(eventoData.data);
    const novoEvento: CalendarEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      titulo: eventoData.titulo.trim(),
      data: dataResolvida,
      horaInicio: eventoData.horaInicio?.trim(),
      horaFim: eventoData.horaFim?.trim(),
      local: eventoData.local?.trim() || 'Não especificado',
      descricao: eventoData.descricao?.trim(),
      categoria: eventoData.categoria || 'reuniao',
      criadoEm: new Date().toISOString(),
    };

    this.eventos.push(novoEvento);
    this.salvarDados();

    this.emit('calendar', {
      type: 'calendar_event',
      action: 'event_created',
      item: novoEvento,
      timestamp: new Date().toISOString(),
    });

    return novoEvento;
  }

  public removerEvento(idOuTitulo: string): boolean {
    const query = idOuTitulo.trim().toLowerCase();
    const lenInicial = this.eventos.length;

    // Busca por ID ou por título aproximado
    const idx = this.eventos.findIndex(
      (e) => e.id === idOuTitulo || e.titulo.toLowerCase().includes(query)
    );

    if (idx !== -1) {
      const removido = this.eventos.splice(idx, 1)[0];
      this.salvarDados();

      this.emit('calendar', {
        type: 'calendar_event',
        action: 'event_deleted',
        item: removido,
        timestamp: new Date().toISOString(),
      });

      return true;
    }

    return false;
  }

  // ==========================================================================
  // OPERAÇÕES DE LEMBRETES
  // ==========================================================================

  public getLembretes(status?: ReminderItem['status']): ReminderItem[] {
    if (status) {
      return this.lembretes.filter((l) => l.status === status);
    }
    return [...this.lembretes];
  }

  public addLembrete(texto: string, quando: string): ReminderItem {
    const dataAlvo = this.resolverData(quando);
    const horaAlvo = this.extrairHorario(quando);

    const novoLembrete: ReminderItem = {
      id: `rem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      texto: texto.trim(),
      quando: quando.trim(),
      dataAlvo,
      horaAlvo,
      status: 'agendado',
      criadoEm: new Date().toISOString(),
    };

    this.lembretes.push(novoLembrete);
    this.salvarDados();

    this.emit('calendar', {
      type: 'calendar_event',
      action: 'reminder_created',
      item: novoLembrete,
      timestamp: new Date().toISOString(),
    });

    return novoLembrete;
  }

  public concluirLembrete(id: string): boolean {
    const lembrete = this.lembretes.find((l) => l.id === id);
    if (lembrete) {
      lembrete.status = 'concluido';
      this.salvarDados();
      return true;
    }
    return false;
  }

  public removerLembrete(id: string): boolean {
    const lenInicial = this.lembretes.length;
    this.lembretes = this.lembretes.filter((l) => l.id !== id);
    if (this.lembretes.length !== lenInicial) {
      this.salvarDados();
      return true;
    }
    return false;
  }

  // ==========================================================================
  // VERIFICAÇÃO AUTOMÁTICA DE HORÁRIO / ALARME DE LEMBRETES
  // ==========================================================================

  private iniciarMonitoramentoLembretes(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);

    // Checa a cada 20 segundos se algum lembrete agendado atingiu o horário
    this.checkInterval = setInterval(() => {
      this.verificarLembretesVencidos();
    }, 20000);
  }

  public verificarLembretesVencidos(): void {
    const agora = new Date();
    const dataHoje = this.formatarIsoData(agora);
    const horaAgora = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

    for (const l of this.lembretes) {
      if (l.status === 'agendado' && l.dataAlvo === dataHoje && l.horaAlvo) {
        if (l.horaAlvo <= horaAgora) {
          l.status = 'disparado';
          this.salvarDados();

          this.emit('reminder_due', {
            type: 'calendar_event',
            action: 'reminder_due',
            item: l,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }

  public destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

export const calendarManager = new CalendarManager();

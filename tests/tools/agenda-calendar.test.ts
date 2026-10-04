import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CalendarManager } from '../../src/core/calendar/calendar-manager';
import { consultarAgendaTool } from '../../src/tools/low-risk/consultar-agenda';
import { agendarCompromissoTool } from '../../src/tools/low-risk/agendar-compromisso';
import { removerCompromissoTool } from '../../src/tools/low-risk/remover-compromisso';
import { criarLembreteTool } from '../../src/tools/low-risk/criar-lembrete';
import { ToolExecutionContext } from '../../src/core/tools/types';

describe('Módulo de Agenda de Compromissos, Calendário e Lembretes da EVA', () => {
  const testCalendarPath = path.join(process.cwd(), 'calendar-test-temp.json');
  let testManager: CalendarManager;

  const mockContext: ToolExecutionContext = {
    interactionId: 'test-calendar-interaction',
    timestamp: new Date(),
  };

  beforeEach(() => {
    if (fs.existsSync(testCalendarPath)) {
      try {
        fs.unlinkSync(testCalendarPath);
      } catch {}
    }
    testManager = new CalendarManager(testCalendarPath);
  });

  afterEach(() => {
    testManager.destroy();
    if (fs.existsSync(testCalendarPath)) {
      try {
        fs.unlinkSync(testCalendarPath);
      } catch {}
    }
  });

  describe('CalendarManager (Lógica de Datas e Horários em pt-BR)', () => {
    it('deve resolver "hoje", "amanhã" e "depois de amanhã" para datas ISO', () => {
      const hoje = new Date();
      const hojeStr = testManager.formatarIsoData(hoje);
      expect(testManager.resolverData('hoje')).toBe(hojeStr);

      const amanha = new Date(hoje);
      amanha.setDate(amanha.getDate() + 1);
      expect(testManager.resolverData('amanhã')).toBe(testManager.formatarIsoData(amanha));
      expect(testManager.resolverData('amanha')).toBe(testManager.formatarIsoData(amanha));

      const depoisAmanha = new Date(hoje);
      depoisAmanha.setDate(depoisAmanha.getDate() + 2);
      expect(testManager.resolverData('depois de amanhã')).toBe(testManager.formatarIsoData(depoisAmanha));
    });

    it('deve resolver datas no formato DD/MM/AAAA ou DD/MM', () => {
      expect(testManager.resolverData('25/12/2026')).toBe('2026-12-25');
      const esteAno = new Date().getFullYear();
      expect(testManager.resolverData('05/08')).toBe(`${esteAno}-08-05`);
    });

    it('deve extrair horários de expressões em linguagem natural', () => {
      expect(testManager.extrairHorario('reunião às 14:30')).toBe('14:30');
      expect(testManager.extrairHorario('dentista às 9:00')).toBe('09:00');
      expect(testManager.extrairHorario('almoço às 12h')).toBe('12:00');
      expect(testManager.extrairHorario('café às 16h45')).toBe('16:45');
      expect(testManager.extrairHorario('sem horário definido')).toBeUndefined();
    });

    it('deve adicionar, listar e remover eventos', () => {
      const evento = testManager.addEvento({
        titulo: 'Consulta Médica de Rotina',
        data: 'amanhã',
        horaInicio: '10:00',
        horaFim: '11:00',
        local: 'Clínica Saúde',
        categoria: 'saude',
      });

      expect(evento.id).toBeDefined();
      expect(evento.titulo).toBe('Consulta Médica de Rotina');

      const eventosAmanha = testManager.getEventos('amanhã');
      expect(eventosAmanha.some((e) => e.titulo === 'Consulta Médica de Rotina')).toBe(true);

      const removido = testManager.removerEvento('Consulta Médica');
      expect(removido).toBe(true);

      const eventosAposRemocao = testManager.getEventos('amanhã');
      expect(eventosAposRemocao.some((e) => e.titulo === 'Consulta Médica de Rotina')).toBe(false);
    });

    it('deve criar e concluir lembretes', () => {
      const lembrete = testManager.addLembrete('Tomar vitamina C', 'às 08:00');
      expect(lembrete.status).toBe('agendado');
      expect(lembrete.texto).toBe('Tomar vitamina C');
      expect(lembrete.horaAlvo).toBe('08:00');

      const todos = testManager.getLembretes();
      expect(todos.some((l) => l.texto === 'Tomar vitamina C')).toBe(true);

      const concluido = testManager.concluirLembrete(lembrete.id);
      expect(concluido).toBe(true);

      const ativos = testManager.getLembretes('agendado');
      expect(ativos.some((l) => l.id === lembrete.id)).toBe(false);
    });

    it('deve emitir evento reminder_due quando um lembrete estiver no horário', () => {
      const spy = vi.fn();
      testManager.on('reminder_due', spy);

      const agora = new Date();
      const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

      // Cria lembrete para agora
      testManager.addLembrete('Alarme de Teste Imediato', `às ${horaAtual}`);
      testManager.verificarLembretesVencidos();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'calendar_event',
          action: 'reminder_due',
          item: expect.objectContaining({
            texto: 'Alarme de Teste Imediato',
          }),
        })
      );
    });
  });

  describe('Ferramentas Registradas do Agente EVA', () => {
    it('consultarAgendaTool deve retornar compromissos reais de hoje', async () => {
      const res = await consultarAgendaTool.execute({ data: 'hoje' }, mockContext);
      expect(res.data).toBe('hoje');
      expect(res.dataResolvida).toBeDefined();
      expect(res.totalCompromissos).toBeGreaterThanOrEqual(1);
      expect(res.compromissos[0].titulo).toBeDefined();
      expect(res.mensagem).toContain('compromisso');
    });

    it('agendarCompromissoTool deve criar novo compromisso com sucesso', async () => {
      const res = await agendarCompromissoTool.execute(
        {
          titulo: 'Apresentação do Projeto EVA',
          data: 'amanhã',
          horaInicio: '16:00',
          horaFim: '17:00',
          local: 'Auditório Principal',
          categoria: 'trabalho',
        },
        mockContext
      );

      expect(res.status).toBe('agendado');
      expect(res.evento.titulo).toBe('Apresentação do Projeto EVA');
      expect(res.mensagem).toContain('Apresentação do Projeto EVA');

      // Limpeza
      removerCompromissoTool.execute({ termoOuId: res.evento.id }, mockContext);
    });

    it('removerCompromissoTool deve cancelar um compromisso existente', async () => {
      const novo = await agendarCompromissoTool.execute(
        {
          titulo: 'Reunião Temporária Para Exclusão',
          data: 'hoje',
          horaInicio: '11:00',
        },
        mockContext
      );

      const resRemocao = await removerCompromissoTool.execute(
        { termoOuId: 'Reunião Temporária' },
        mockContext
      );

      expect(resRemocao.sucesso).toBe(true);
      expect(resRemocao.mensagem).toContain('cancelado');
    });

    it('criarLembreteTool deve agendar um novo lembrete com identificador rem_', async () => {
      const res = await criarLembreteTool.execute(
        {
          texto: 'Comprar pilhas recarregáveis',
          quando: 'às 19:30',
        },
        mockContext
      );

      expect(res.status).toBe('agendado');
      expect(res.id).toMatch(/^rem_/);
      expect(res.texto).toBe('Comprar pilhas recarregáveis');
      expect(res.quando).toBe('às 19:30');
      expect(res.horaAlvo).toBe('19:30');
      expect(res.mensagem).toContain('Lembrete agendado');
    });
  });
});

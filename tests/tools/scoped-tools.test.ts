import { describe, it, expect, beforeEach } from 'vitest';
import { createDefaultToolRegistry } from '../../src/tools';
import { ToolExecutor } from '../../src/core/tools/tool-executor';
import { ToolExecutionContext } from '../../src/core/tools/types';
import { ClimaResult } from '../../src/tools/low-risk/consultar-clima';
import { LembreteResult } from '../../src/tools/low-risk/criar-lembrete';
import { AgendaResult } from '../../src/tools/low-risk/consultar-agenda';
import { BuscarWebResult } from '../../src/tools/low-risk/buscar-web';
import { DispositivoResult } from '../../src/tools/sensitive/dispositivos';

describe('Scoped Tools (Ciclo de Teste 1)', () => {
  let registry: ReturnType<typeof createDefaultToolRegistry>;
  let executor: ToolExecutor;

  const context: ToolExecutionContext = {
    interactionId: 'test-cycle-1',
    timestamp: new Date(),
  };

  beforeEach(() => {
    registry = createDefaultToolRegistry();
    executor = new ToolExecutor(registry);
  });

  describe('consultar_clima', () => {
    it('deve retornar a previsão climática para a cidade solicitada', async () => {
      const res = await executor.execute<ClimaResult>('consultar_clima', { cidade: 'São Paulo', dias: 3 }, context);

      expect(res.status).toBe('success');
      expect(res.data?.cidade).toBe('São Paulo');
      expect(res.data?.temperaturaAtual).toBeDefined();
      expect(res.data?.previsaoDias).toHaveLength(3);
    });

    it('deve falhar se o nome da cidade estiver vazio', async () => {
      const res = await executor.execute('consultar_clima', { cidade: '' }, context);

      expect(res.status).toBe('failure');
      expect(res.error).toContain('cidade');
    });
  });

  describe('criar_lembrete', () => {
    it('deve criar um lembrete com horário e texto', async () => {
      const res = await executor.execute<LembreteResult>(
        'criar_lembrete',
        { texto: 'Comprar pilhas para o controle', quando: 'às 18:00' },
        context
      );

      expect(res.status).toBe('success');
      expect(res.data?.id).toMatch(/^rem_/);
      expect(res.data?.texto).toBe('Comprar pilhas para o controle');
      expect(res.data?.quando).toBe('às 18:00');
      expect(res.data?.status).toBe('agendado');
    });

    it('deve falhar se o texto do lembrete estiver ausente', async () => {
      const res = await executor.execute('criar_lembrete', { quando: 'às 18:00' }, context);

      expect(res.status).toBe('failure');
      expect(res.error).toBeDefined();
    });
  });

  describe('consultar_agenda', () => {
    it('deve listar compromissos para uma data', async () => {
      const res = await executor.execute<AgendaResult>(
        'consultar_agenda',
        { data: 'hoje' },
        context
      );

      expect(res.status).toBe('success');
      expect(res.data?.data).toBe('hoje');
      expect(res.data?.compromissos.length).toBeGreaterThan(0);
    });
  });

  describe('buscar_na_web', () => {
    it('deve retornar resultados para uma busca válida', async () => {
      const res = await executor.execute<BuscarWebResult>(
        'buscar_na_web',
        { query: 'clima amanhã em curitiba' },
        context
      );

      expect(res.status).toBe('success');
      expect(res.data?.query).toBe('clima amanhã em curitiba');
      expect(res.data?.resultados.length).toBeGreaterThan(0);
    });

    it('deve rejeitar query menor que 2 caracteres', async () => {
      const res = await executor.execute('buscar_na_web', { query: 'a' }, context);

      expect(res.status).toBe('failure');
      expect(res.error).toContain('query');
    });
  });

  describe('destrancar_fechadura (Ação Crítica com Confirmação Obrigatória)', () => {
    it('deve interceptar e exigir confirmação quando chamado sem confirmed: true', async () => {
      const res = await executor.execute('destrancar_fechadura', { porta: 'principal' }, context);

      expect(res.status).toBe('confirmation_required');
      expect(res.confirmation?.toolName).toBe('destrancar_fechadura');
      expect(res.confirmation?.prompt).toContain("Você realmente deseja destrancar a fechadura 'principal'?");
    });

    it('deve executar e destrancar a fechadura quando confirmado expressamente pelo usuário', async () => {
      const confirmedCtx: ToolExecutionContext = { ...context, confirmed: true };
      const res = await executor.execute<{ porta: string; status: string }>(
        'destrancar_fechadura',
        { porta: 'principal' },
        confirmedCtx
      );

      expect(res.status).toBe('success');
      expect(res.data?.porta).toBe('principal');
      expect(res.data?.status).toBe('destrancada');
    });
  });

  describe('ligar_dispositivo e desligar_dispositivo', () => {
    it('deve ligar um dispositivo inteligente', async () => {
      const res = await executor.execute<DispositivoResult>(
        'ligar_dispositivo',
        { comodo: 'sala', dispositivo: 'luz de teto' },
        context
      );

      expect(res.status).toBe('success');
      expect(res.data?.estado).toBe('ligado');
      expect(res.data?.comodo).toBe('sala');
    });

    it('deve desligar um dispositivo inteligente', async () => {
      const res = await executor.execute<DispositivoResult>(
        'desligar_dispositivo',
        { comodo: 'quarto', dispositivo: 'ventilador' },
        context
      );

      expect(res.status).toBe('success');
      expect(res.data?.estado).toBe('desligado');
      expect(res.data?.dispositivo).toBe('ventilador');
    });
  });
});

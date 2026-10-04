import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { ContactsManager, Contact, contactsManager } from '../../src/core/telephony/contacts-manager';
import { PhoneDialer } from '../../src/core/telephony/phone-dialer';
import {
  fazerLigacaoTool,
  enviarMensagemWhatsappTool,
  consultarContatosTool,
  adicionarContatoTool,
} from '../../src/tools/low-risk/telefonia';
import { ToolExecutionContext } from '../../src/core/tools/types';

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, callback?: any) => {
    if (callback) callback(null, '', '');
    return {} as any;
  }),
}));

describe('Módulo de Telefonia e Contatos da EVA', () => {
  const testContactsPath = path.join(process.cwd(), 'contacts-test-temp.json');
  let testContactsManager: ContactsManager;
  let testPhoneDialer: PhoneDialer;

  const mockContext: ToolExecutionContext = {
    interactionId: 'test-telephony-interaction',
    timestamp: new Date(),
  };

  beforeEach(() => {
    if (fs.existsSync(testContactsPath)) {
      try {
        fs.unlinkSync(testContactsPath);
      } catch {}
    }
    testContactsManager = new ContactsManager(testContactsPath);
    testPhoneDialer = new PhoneDialer();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(testContactsPath)) {
      try {
        fs.unlinkSync(testContactsPath);
      } catch {}
    }
  });

  describe('ContactsManager', () => {
    it('deve sanitizar números de telefone corretamente', () => {
      expect(testContactsManager.sanitizePhone('+5532999991234')).toBe('+5532999991234');
      expect(testContactsManager.sanitizePhone('32999991234')).toBe('+5532999991234');
      expect(testContactsManager.sanitizePhone('3232323232')).toBe('+553232323232');
      expect(testContactsManager.sanitizePhone('5532999991234')).toBe('+5532999991234');
      expect(testContactsManager.sanitizePhone('(32) 99999-1234')).toBe('+5532999991234');
      expect(testContactsManager.sanitizePhone('')).toBe('');
    });

    it('deve inicializar com contatos padrão caso não haja arquivo salvo', () => {
      const contacts = testContactsManager.getContacts();
      expect(contacts.length).toBeGreaterThanOrEqual(3);
      expect(contacts.some((c) => c.name === 'Mãe')).toBe(true);
      expect(contacts.some((c) => c.name === 'Pai')).toBe(true);
      expect(contacts.some((c) => c.name === 'Rafael')).toBe(true);
    });

    it('deve buscar contato por nome ignorando acentos e caixa alta/baixa', () => {
      const c1 = testContactsManager.findContact('mãe');
      expect(c1).toBeDefined();
      expect(c1?.name).toBe('Mãe');

      const c2 = testContactsManager.findContact('MAE');
      expect(c2).toBeDefined();
      expect(c2?.name).toBe('Mãe');
    });

    it('deve buscar contato por apelido (alias) e parentesco', () => {
      const c1 = testContactsManager.findContact('mamãe');
      expect(c1).toBeDefined();
      expect(c1?.name).toBe('Mãe');

      const c2 = testContactsManager.findContact('papai');
      expect(c2).toBeDefined();
      expect(c2?.name).toBe('Pai');

      const c3 = testContactsManager.findContact('rafa');
      expect(c3).toBeDefined();
      expect(c3?.name).toBe('Rafael');
    });

    it('deve adicionar, atualizar e deletar um contato', () => {
      const novo = testContactsManager.addContact({
        name: 'Doutor Silva',
        phone: '32988887777',
        aliases: ['médico', 'silva'],
        relationship: 'médico',
      });

      expect(novo.id).toBeDefined();
      expect(novo.phone).toBe('+5532988887777');

      const encontrado = testContactsManager.findContact('médico');
      expect(encontrado?.name).toBe('Doutor Silva');

      // Atualizar
      const atualizado = testContactsManager.updateContact(novo.id, {
        notes: 'Clínica geral nas terças',
      });
      expect(atualizado?.notes).toBe('Clínica geral nas terças');

      // Deletar
      const deletado = testContactsManager.deleteContact(novo.id);
      expect(deletado).toBe(true);
      expect(testContactsManager.findContact('médico')).toBeUndefined();
    });
  });

  describe('PhoneDialer', () => {
    it('deve formatar número para exibição legível', () => {
      expect(testPhoneDialer.formatDisplayPhone('+5532999991234')).toBe('+55 (32) 99999-1234');
      expect(testPhoneDialer.formatDisplayPhone('+553232323232')).toBe('+55 (32) 3232-3232');
    });

    it('deve realizar discagem telefônica e emitir evento call', async () => {
      const eventSpy = vi.fn();
      testPhoneDialer.on('call', eventSpy);

      const res = await testPhoneDialer.dial('mãe');
      expect(res.success).toBe(true);
      expect(res.phone).toBe('+5532999990001');
      expect(res.contact?.name).toBe('Mãe');
      expect(res.message).toContain('Ligando para Mãe');

      expect(childProcess.exec).toHaveBeenCalled();
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'telephony_event',
          action: 'call_started',
          target: expect.objectContaining({
            name: 'Mãe',
            phone: '+5532999990001',
          }),
        })
      );

      const active = testPhoneDialer.getActiveCall();
      expect(active).not.toBeNull();
      expect(active?.phone).toBe('+5532999990001');

      // Encerrar chamada
      const endRes = testPhoneDialer.endCall();
      expect(endRes.success).toBe(true);
      expect(testPhoneDialer.getActiveCall()).toBeNull();
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'telephony_event',
          action: 'call_ended',
        })
      );
    });

    it('deve abrir o WhatsApp com mensagem codificada na URL', async () => {
      const eventSpy = vi.fn();
      testPhoneDialer.on('call', eventSpy);

      const res = await testPhoneDialer.openWhatsApp('Pai', 'Oi pai, tudo bem?');
      expect(res.success).toBe(true);
      expect(res.phone).toBe('+5532999990002');
      expect(res.message).toContain('Mensagem do WhatsApp');

      expect(childProcess.exec).toHaveBeenCalledWith(
        expect.stringContaining('https://wa.me/5532999990002?text=Oi%20pai%2C%20tudo%20bem%3F')
      );

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'telephony_event',
          action: 'whatsapp_opened',
          details: 'Mensagem: "Oi pai, tudo bem?"',
        })
      );
    });
  });

  describe('Ferramentas Registradas da EVA', () => {
    it('fazerLigacaoTool deve acionar discagem', async () => {
      const res = await fazerLigacaoTool.execute({ contatoOuNumero: 'Mãe' }, mockContext);
      expect(res.status).toBe('ligando');
      expect(res.nome).toBe('Mãe');
      expect(res.telefone).toBe('+5532999990001');
      expect(res.telefoneFormatado).toBe('+55 (32) 99999-0001');
      expect(res.mensagem).toContain('Ligando para Mãe');
    });

    it('enviarMensagemWhatsappTool deve acionar WhatsApp', async () => {
      const res = await enviarMensagemWhatsappTool.execute(
        { contatoOuNumero: 'Pai', mensagem: 'Chego em 10 minutos' },
        mockContext
      );
      expect(res.status).toBe('enviando');
      expect(res.nome).toBe('Pai');
      expect(res.telefone).toBe('+5532999990002');
      expect(res.mensagem).toContain('Chego em 10 minutos');
    });

    it('consultarContatosTool deve listar e filtrar contatos', async () => {
      const listRes = await consultarContatosTool.execute({}, mockContext);
      expect(listRes.total).toBeGreaterThanOrEqual(3);
      expect(listRes.contatos.some((c) => c.nome === 'Mãe')).toBe(true);

      const filterRes = await consultarContatosTool.execute({ busca: 'Rafael' }, mockContext);
      expect(filterRes.total).toBe(1);
      expect(filterRes.contatos[0].nome).toBe('Rafael');
    });

    it('adicionarContatoTool deve cadastrar novo contato', async () => {
      const addRes = await adicionarContatoTool.execute(
        {
          nome: 'Clínica Odonto',
          telefone: '3232112233',
          apelidos: ['dentista'],
          parentesco: 'saúde',
        },
        mockContext
      );

      expect(addRes.status).toBe('sucesso');
      expect(addRes.contato.name).toBe('Clínica Odonto');
      expect(addRes.contato.phone).toBe('+553232112233');
      expect(addRes.mensagem).toContain('cadastrado com sucesso');

      // Limpeza para não poluir contacts.json
      contactsManager.deleteContact(addRes.contato.id);
    });
  });
});

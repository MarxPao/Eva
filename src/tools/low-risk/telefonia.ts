import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';
import { contactsManager, Contact } from '../../core/telephony/contacts-manager';
import { phoneDialer } from '../../core/telephony/phone-dialer';

// ============================================================================
// 1. Fazer Ligação Telefônica
// ============================================================================
export const FazerLigacaoSchema = z.object({
  contatoOuNumero: z
    .string()
    .min(1, 'O nome do contato, apelido ou número de telefone é obrigatório.')
    .describe('Nome da pessoa, apelido (ex: "mãe", "pai", "Rafael", "amor") ou número de telefone completo.'),
});

export type FazerLigacaoInput = z.infer<typeof FazerLigacaoSchema>;

export interface FazerLigacaoResult {
  status: 'ligando';
  nome?: string;
  telefone: string;
  telefoneFormatado: string;
  mensagem: string;
}

export const fazerLigacaoTool: ToolDefinition<FazerLigacaoInput, FazerLigacaoResult> = {
  name: 'fazer_ligacao',
  description:
    'Inicia uma chamada telefônica no celular conectado através do viva-voz do computador. Pode discar para um contato cadastrado (ex: "mãe", "Rafael") ou número direto.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: FazerLigacaoSchema,
  execute: async (params) => {
    const dialRes = await phoneDialer.dial(params.contatoOuNumero);
    return {
      status: 'ligando',
      nome: dialRes.contact?.name,
      telefone: dialRes.phone,
      telefoneFormatado: phoneDialer.formatDisplayPhone(dialRes.phone),
      mensagem: dialRes.message,
    };
  },
};

// ============================================================================
// 2. Enviar Mensagem via WhatsApp
// ============================================================================
export const EnviarMensagemWhatsappSchema = z.object({
  contatoOuNumero: z
    .string()
    .min(1, 'O nome do contato ou número é obrigatório.')
    .describe('Nome do contato, apelido ou número de telefone.'),
  mensagem: z
    .string()
    .min(1, 'O texto da mensagem é obrigatório.')
    .describe('Texto que será enviado pelo WhatsApp.'),
});

export type EnviarMensagemWhatsappInput = z.infer<typeof EnviarMensagemWhatsappSchema>;

export interface EnviarMensagemWhatsappResult {
  status: 'enviando';
  nome?: string;
  telefone: string;
  mensagem: string;
}

export const enviarMensagemWhatsappTool: ToolDefinition<
  EnviarMensagemWhatsappInput,
  EnviarMensagemWhatsappResult
> = {
  name: 'enviar_mensagem_whatsapp',
  description:
    'Envia ou prepara o envio de uma mensagem de texto pelo WhatsApp para um contato ou número de telefone.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: EnviarMensagemWhatsappSchema,
  execute: async (params) => {
    const waRes = await phoneDialer.openWhatsApp(params.contatoOuNumero, params.mensagem);
    return {
      status: 'enviando',
      nome: waRes.contact?.name,
      telefone: waRes.phone,
      mensagem: waRes.message,
    };
  },
};

// ============================================================================
// 3. Consultar Contatos da Agenda
// ============================================================================
export const ConsultarContatosSchema = z.object({
  busca: z
    .string()
    .optional()
    .describe('Termo de busca opcional (nome, apelido ou número). Se omitido, lista os contatos.'),
});

export type ConsultarContatosInput = z.infer<typeof ConsultarContatosSchema>;

export interface ConsultarContatosResult {
  total: number;
  contatos: Array<{
    id: string;
    nome: string;
    telefoneFormatado: string;
    apelidos: string[];
    parentesco?: string;
  }>;
  mensagem: string;
}

export const consultarContatosTool: ToolDefinition<
  ConsultarContatosInput,
  ConsultarContatosResult
> = {
  name: 'consultar_contatos',
  description: 'Consulta a agenda de contatos da EVA para verificar números e apelidos cadastrados.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarContatosSchema,
  execute: async (params) => {
    const all = contactsManager.getContacts();
    let filtered = all;

    if (params.busca && params.busca.trim()) {
      const match = contactsManager.findContact(params.busca);
      filtered = match ? [match] : [];
    }

    const mapped = filtered.map((c) => ({
      id: c.id,
      nome: c.name,
      telefoneFormatado: phoneDialer.formatDisplayPhone(c.phone),
      apelidos: c.aliases || [],
      parentesco: c.relationship,
    }));

    return {
      total: mapped.length,
      contatos: mapped,
      mensagem:
        mapped.length > 0
          ? `Encontrado(s) ${mapped.length} contato(s) na agenda.`
          : 'Nenhum contato encontrado na agenda.',
    };
  },
};

// ============================================================================
// 4. Adicionar Novo Contato à Agenda
// ============================================================================
export const AdicionarContatoSchema = z.object({
  nome: z.string().min(1, 'Nome do contato é obrigatório').describe('Nome completo ou de exibição do contato'),
  telefone: z
    .string()
    .min(8, 'Número de telefone é obrigatório')
    .describe('Número de telefone (ex: "+5532999991234" ou com DDD "32999991234")'),
  apelidos: z
    .array(z.string())
    .optional()
    .describe('Lista de apelidos ou nomes alternativos (ex: ["mãe", "mamãe"])'),
  parentesco: z.string().optional().describe('Grau de parentesco ou relação (ex: "mãe", "esposa", "amigo")'),
});

export type AdicionarContatoInput = z.infer<typeof AdicionarContatoSchema>;

export interface AdicionarContatoResult {
  status: 'sucesso';
  contato: Contact;
  mensagem: string;
}

export const adicionarContatoTool: ToolDefinition<AdicionarContatoInput, AdicionarContatoResult> = {
  name: 'adicionar_contato',
  description: 'Adiciona um novo contato com nome, telefone e apelidos à agenda telefônica da EVA.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: AdicionarContatoSchema,
  execute: async (params) => {
    const created = contactsManager.addContact({
      name: params.nome,
      phone: params.telefone,
      aliases: params.apelidos || [],
      relationship: params.parentesco,
    });

    return {
      status: 'sucesso',
      contato: created,
      mensagem: `Contato ${created.name} (${phoneDialer.formatDisplayPhone(created.phone)}) cadastrado com sucesso na agenda.`,
    };
  },
};

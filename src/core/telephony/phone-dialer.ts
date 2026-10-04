import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { Contact, contactsManager } from './contacts-manager';

export interface TelephonyCallEvent {
  type: 'telephony_event';
  action: 'call_started' | 'call_ended' | 'whatsapp_opened';
  target: {
    name?: string;
    phone: string;
    formattedPhone: string;
  };
  details?: string;
  timestamp: string;
}

export class PhoneDialer extends EventEmitter {
  private activeCall: {
    phone: string;
    name?: string;
    startTime: Date;
  } | null = null;

  public getActiveCall() {
    return this.activeCall ? { ...this.activeCall } : null;
  }

  /**
   * Executa a discagem telefônica usando o protocolo nativo do sistema operacional (Phone Link / Windows)
   */
  public async dial(target: string): Promise<{ success: boolean; contact?: Contact; phone: string; message: string }> {
    let resolvedContact = contactsManager.findContact(target);
    let rawPhone = resolvedContact ? resolvedContact.phone : target;
    const sanitizedPhone = contactsManager.sanitizePhone(rawPhone);

    if (!sanitizedPhone) {
      throw new Error(`Número de telefone inválido ou contato não encontrado para "${target}".`);
    }

    const displayName = resolvedContact ? resolvedContact.name : sanitizedPhone;

    // Dispara a chamada usando o protocolo nativo tel: no Windows
    try {
      if (process.platform === 'win32') {
        // No Windows, 'start tel:...' aciona o aplicativo padrão (Vincular ao Celular / Phone Link ou Discador)
        exec(`start tel:${sanitizedPhone}`);
      } else if (process.platform === 'darwin') {
        exec(`open "tel:${sanitizedPhone}"`);
      } else {
        exec(`xdg-open "tel:${sanitizedPhone}"`);
      }
    } catch (err: any) {
      console.warn('[PhoneDialer] Aviso ao abrir protocolo tel:', err.message);
    }

    this.activeCall = {
      phone: sanitizedPhone,
      name: resolvedContact?.name,
      startTime: new Date(),
    };

    const event: TelephonyCallEvent = {
      type: 'telephony_event',
      action: 'call_started',
      target: {
        name: resolvedContact?.name,
        phone: sanitizedPhone,
        formattedPhone: this.formatDisplayPhone(sanitizedPhone),
      },
      details: `Chamada iniciada para ${displayName}`,
      timestamp: new Date().toISOString(),
    };

    this.emit('call', event);

    return {
      success: true,
      contact: resolvedContact,
      phone: sanitizedPhone,
      message: `Ligando para ${displayName} (${this.formatDisplayPhone(sanitizedPhone)})...`,
    };
  }

  /**
   * Abre o WhatsApp para envio de mensagem ou chamada
   */
  public async openWhatsApp(
    target: string,
    messageText?: string
  ): Promise<{ success: boolean; contact?: Contact; phone: string; message: string }> {
    let resolvedContact = contactsManager.findContact(target);
    let rawPhone = resolvedContact ? resolvedContact.phone : target;
    const sanitizedPhone = contactsManager.sanitizePhone(rawPhone);

    if (!sanitizedPhone) {
      throw new Error(`Número de telefone inválido ou contato não encontrado para "${target}".`);
    }

    const digitsOnly = sanitizedPhone.replace(/\D/g, '');
    const displayName = resolvedContact ? resolvedContact.name : sanitizedPhone;
    const textParam = messageText ? encodeURIComponent(messageText) : '';
    const waUrl = textParam ? `https://wa.me/${digitsOnly}?text=${textParam}` : `https://wa.me/${digitsOnly}`;

    try {
      if (process.platform === 'win32') {
        exec(`start "" "${waUrl}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${waUrl}"`);
      } else {
        exec(`xdg-open "${waUrl}"`);
      }
    } catch (err: any) {
      console.warn('[PhoneDialer] Aviso ao abrir WhatsApp URL:', err.message);
    }

    const event: TelephonyCallEvent = {
      type: 'telephony_event',
      action: 'whatsapp_opened',
      target: {
        name: resolvedContact?.name,
        phone: sanitizedPhone,
        formattedPhone: this.formatDisplayPhone(sanitizedPhone),
      },
      details: messageText ? `Mensagem: "${messageText}"` : 'Conversa aberta',
      timestamp: new Date().toISOString(),
    };

    this.emit('call', event);

    return {
      success: true,
      contact: resolvedContact,
      phone: sanitizedPhone,
      message: messageText
        ? `Mensagem do WhatsApp preparada para ${displayName}: "${messageText}".`
        : `Abrindo WhatsApp para ${displayName}...`,
    };
  }

  public endCall(): { success: boolean; message: string } {
    if (!this.activeCall) {
      return { success: true, message: 'Nenhuma chamada ativa no momento.' };
    }

    const endedCall = { ...this.activeCall };
    this.activeCall = null;

    const event: TelephonyCallEvent = {
      type: 'telephony_event',
      action: 'call_ended',
      target: {
        name: endedCall.name,
        phone: endedCall.phone,
        formattedPhone: this.formatDisplayPhone(endedCall.phone),
      },
      details: 'Chamada encerrada',
      timestamp: new Date().toISOString(),
    };

    this.emit('call', event);

    return {
      success: true,
      message: 'Chamada finalizada.',
    };
  }

  public formatDisplayPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('55')) {
      // +55 (32) 9XXXX-XXXX
      return `+55 (${digits.substring(2, 4)}) ${digits.substring(4, 9)}-${digits.substring(9)}`;
    }
    if (digits.length === 12 && digits.startsWith('55')) {
      // +55 (32) XXXX-XXXX
      return `+55 (${digits.substring(2, 4)}) ${digits.substring(4, 8)}-${digits.substring(8)}`;
    }
    if (digits.length === 11) {
      // (32) 9XXXX-XXXX
      return `(${digits.substring(0, 2)}) ${digits.substring(2, 7)}-${digits.substring(7)}`;
    }
    return phone;
  }
}

export const phoneDialer = new PhoneDialer();

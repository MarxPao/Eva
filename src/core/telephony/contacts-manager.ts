import fs from 'fs';
import path from 'path';

export interface Contact {
  id: string;
  name: string;
  phone: string; // Ex: "+5532999991234"
  aliases: string[]; // Ex: ["mãe", "mae", "dona maria"]
  relationship?: string; // Ex: "mãe", "pai", "esposa", "amigo"
  notes?: string;
}

export class ContactsManager {
  private contactsFile: string;
  private contacts: Contact[] = [];

  constructor(filePath?: string) {
    this.contactsFile = filePath || path.join(process.cwd(), 'contacts.json');
    this.loadContacts();
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  public sanitizePhone(phone: string): string {
    // Mantém o prefixo + se houver e apenas dígitos
    const hasPlus = phone.trim().startsWith('+');
    const digitsOnly = phone.replace(/\D/g, '');
    if (!digitsOnly) return '';

    if (hasPlus) {
      return `+${digitsOnly}`;
    }

    // Se tiver 10 ou 11 dígitos (DDD + número no Brasil), adiciona +55 por padrão
    if (digitsOnly.length === 10 || digitsOnly.length === 11) {
      return `+55${digitsOnly}`;
    }

    // Se já tiver 12 ou 13 dígitos começando com 55
    if (digitsOnly.length >= 12 && digitsOnly.startsWith('55')) {
      return `+${digitsOnly}`;
    }

    return `+${digitsOnly}`;
  }

  private loadContacts(): void {
    try {
      if (fs.existsSync(this.contactsFile)) {
        const raw = fs.readFileSync(this.contactsFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.contacts = data;
          return;
        }
      }
    } catch (err) {
      console.warn('[ContactsManager] Erro ao carregar contatos, usando lista padrão:', err);
    }

    // Contatos iniciais de exemplo caso não exista arquivo
    this.contacts = [
      {
        id: 'c_mae',
        name: 'Mãe',
        phone: '+5532999990001',
        aliases: ['mãe', 'mae', 'mamãe', 'mamae'],
        relationship: 'mãe',
      },
      {
        id: 'c_pai',
        name: 'Pai',
        phone: '+5532999990002',
        aliases: ['pai', 'papai'],
        relationship: 'pai',
      },
      {
        id: 'c_rafael',
        name: 'Rafael',
        phone: '+5532999990003',
        aliases: ['rafa', 'eu', 'rafael'],
        relationship: 'eu',
      },
    ];
    this.saveContacts();
  }

  public saveContacts(): void {
    try {
      fs.writeFileSync(this.contactsFile, JSON.stringify(this.contacts, null, 2), 'utf8');
    } catch (err) {
      console.error('[ContactsManager] Erro ao salvar contatos:', err);
    }
  }

  public getContacts(): Contact[] {
    return [...this.contacts];
  }

  public findContact(query: string): Contact | undefined {
    if (!query || !query.trim()) return undefined;
    const cleanQuery = this.normalizeText(query);
    const digitsQuery = query.replace(/\D/g, '');

    // 1. Busca por correspondência exata de telefone
    if (digitsQuery.length >= 8) {
      const matchPhone = this.contacts.find((c) => c.phone.replace(/\D/g, '').includes(digitsQuery));
      if (matchPhone) return matchPhone;
    }

    // 2. Busca exata por nome
    const exactName = this.contacts.find((c) => this.normalizeText(c.name) === cleanQuery);
    if (exactName) return exactName;

    // 3. Busca exata por apelido (alias) ou parentesco
    const exactAlias = this.contacts.find(
      (c) =>
        (c.aliases && c.aliases.some((a) => this.normalizeText(a) === cleanQuery)) ||
        (c.relationship && this.normalizeText(c.relationship) === cleanQuery)
    );
    if (exactAlias) return exactAlias;

    // 4. Busca por contém no nome
    const containsName = this.contacts.find((c) => this.normalizeText(c.name).includes(cleanQuery));
    if (containsName) return containsName;

    // 5. Busca por contém em apelidos
    return this.contacts.find(
      (c) => c.aliases && c.aliases.some((a) => this.normalizeText(a).includes(cleanQuery))
    );
  }

  public addContact(contactData: Omit<Contact, 'id'>): Contact {
    const newContact: Contact = {
      id: `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: contactData.name.trim(),
      phone: this.sanitizePhone(contactData.phone),
      aliases: (contactData.aliases || []).map((a) => a.trim()).filter(Boolean),
      relationship: contactData.relationship?.trim(),
      notes: contactData.notes?.trim(),
    };

    this.contacts.push(newContact);
    this.saveContacts();
    return newContact;
  }

  public updateContact(id: string, partial: Partial<Omit<Contact, 'id'>>): Contact | undefined {
    const idx = this.contacts.findIndex((c) => c.id === id);
    if (idx === -1) return undefined;

    const existing = this.contacts[idx];
    const updated: Contact = {
      ...existing,
      ...partial,
      phone: partial.phone ? this.sanitizePhone(partial.phone) : existing.phone,
      aliases: partial.aliases ? partial.aliases.map((a) => a.trim()).filter(Boolean) : existing.aliases,
    };

    this.contacts[idx] = updated;
    this.saveContacts();
    return updated;
  }

  public deleteContact(id: string): boolean {
    const initialLen = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    const changed = this.contacts.length !== initialLen;
    if (changed) {
      this.saveContacts();
    }
    return changed;
  }
}

export const contactsManager = new ContactsManager();

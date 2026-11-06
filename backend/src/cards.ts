import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'unknown';

export interface Card {
  id: string;
  libelle: string;
  titulaire: string;
  numero: string;
  expiration: string;
  cvv: string;
  brand: CardBrand;
  accountId?: string;
  createdAt: number;
  updatedAt: number;
}

export type CardInput = Omit<Card, 'id' | 'brand' | 'createdAt' | 'updatedAt'>;

const DEFAULT_PATH = resolve(process.cwd(), '..', 'data', 'cards.json');

function detectBrand(numero: string): CardBrand {
  const digits = numero.replace(/\D/g, '');
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  return 'unknown';
}

function normalizeNumero(numero: string): string {
  return numero.replace(/\s+/g, '').trim();
}

function normalizeExpiration(exp: string): string {
  const cleaned = exp.replace(/\s+/g, '').trim();
  const m = cleaned.match(/^(\d{1,2})\s*\/?\s*(\d{2,4})$/);
  if (!m) return cleaned;
  const month = m[1].padStart(2, '0');
  const year = m[2].length === 4 ? m[2].slice(2) : m[2];
  return `${month}/${year}`;
}

class CardsStore {
  private path = process.env.CARDS_FILE ?? DEFAULT_PATH;
  private cards: Card[] = [];

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) {
      this.cards = [];
      return;
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.cards = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cards = [];
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.cards, null, 2), 'utf8');
  }

  list(): Card[] {
    return [...this.cards].sort((a, b) => a.createdAt - b.createdAt);
  }

  create(input: CardInput): Card {
    const now = Date.now();
    const numero = normalizeNumero(input.numero);
    const card: Card = {
      id: randomUUID(),
      libelle: input.libelle.trim(),
      titulaire: input.titulaire.trim(),
      numero,
      expiration: normalizeExpiration(input.expiration),
      cvv: input.cvv.trim(),
      brand: detectBrand(numero),
      accountId: input.accountId?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.cards.push(card);
    this.persist();
    return card;
  }

  update(id: string, patch: Partial<CardInput>): Card | undefined {
    const idx = this.cards.findIndex((c) => c.id === id);
    if (idx === -1) return undefined;
    const current = this.cards[idx];
    const numero = patch.numero !== undefined ? normalizeNumero(patch.numero) : current.numero;
    const next: Card = {
      ...current,
      libelle: patch.libelle?.trim() ?? current.libelle,
      titulaire: patch.titulaire?.trim() ?? current.titulaire,
      numero,
      expiration:
        patch.expiration !== undefined ? normalizeExpiration(patch.expiration) : current.expiration,
      cvv: patch.cvv?.trim() ?? current.cvv,
      brand: detectBrand(numero),
      accountId: patch.accountId === undefined ? current.accountId : patch.accountId?.trim() || undefined,
      updatedAt: Date.now(),
    };
    this.cards[idx] = next;
    this.persist();
    return next;
  }

  delete(id: string): boolean {
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => c.id !== id);
    if (this.cards.length === before) return false;
    this.persist();
    return true;
  }
}

export const cardsStore = new CardsStore();

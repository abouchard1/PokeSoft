const PRENOMS = [
  'Marc', 'Lucas', 'Hugo', 'Léo', 'Nathan', 'Théo', 'Mathis', 'Maxime', 'Antoine', 'Julien',
  'Pierre', 'Romain', 'Adrien', 'Quentin', 'Florian', 'Bastien', 'Damien', 'Yann', 'Vincent', 'Olivier',
  'Emma', 'Léa', 'Chloé', 'Manon', 'Camille', 'Sarah', 'Anaïs', 'Marine', 'Justine', 'Pauline',
  'Charlotte', 'Élise', 'Mathilde', 'Clara', 'Inès', 'Margaux', 'Audrey', 'Sophie', 'Julie', 'Claire',
];

const NOMS = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau',
  'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier',
  'Morel', 'Girard', 'André', 'Mercier', 'Dupont', 'Lambert', 'Bonnet', 'François', 'Martinez', 'Legrand',
  'Garnier', 'Faure', 'Rousseau', 'Blanc', 'Guerin', 'Muller', 'Henry', 'Roussel', 'Nicolas', 'Perrin',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function makeEmail(prenom: string, nom: string, domain = 'a-bouchard.com'): string {
  const norm = (s: string) =>
    stripAccents(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  return `${norm(prenom)}.${norm(nom)}@${domain}`;
}

interface ParsedAddress {
  numero: string;
  voieType: string;
  voieName: string;
  cp: string;
  ville: string;
}

const DIACRITICS: Record<string, string[]> = {
  a: ['à', 'â', 'ä'],
  e: ['é', 'è', 'ê', 'ë'],
  i: ['î', 'ï'],
  o: ['ô', 'ö'],
  u: ['ù', 'û', 'ü'],
  c: ['ç'],
};

const REVERSE_DIACRITICS: Record<string, string> = {};
for (const [base, variants] of Object.entries(DIACRITICS)) {
  for (const v of variants) {
    REVERSE_DIACRITICS[v] = base;
    REVERSE_DIACRITICS[v.toUpperCase()] = base.toUpperCase();
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function jiggLetters(input: string, minSubs = 1, maxSubs = 3): string {
  const chars = [...input];
  const candidates: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (REVERSE_DIACRITICS[ch] || DIACRITICS[ch.toLowerCase()]) candidates.push(i);
  }
  if (candidates.length === 0) return input;

  const target = Math.min(
    candidates.length,
    minSubs + Math.floor(Math.random() * Math.max(1, maxSubs - minSubs + 1))
  );
  shuffle(candidates);

  for (const pos of candidates.slice(0, target)) {
    const ch = chars[pos];
    if (REVERSE_DIACRITICS[ch]) {
      chars[pos] = REVERSE_DIACRITICS[ch];
    } else {
      const lower = ch.toLowerCase();
      const variants = DIACRITICS[lower];
      if (!variants) continue;
      const pick = variants[Math.floor(Math.random() * variants.length)];
      chars[pos] = ch === lower ? pick : pick.toUpperCase();
    }
  }
  return chars.join('');
}

function parseAddress(raw: string): ParsedAddress | null {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  const m = cleaned.match(/^(\d+(?:\s?bis|\s?ter)?)\s+(\S+)\s+(.+?)\s+(\d{5})\s+(.+)$/i);
  if (!m) return null;
  const [, numero, voieType, voieName, cp, ville] = m;
  return { numero, voieType, voieName, cp, ville };
}

function jigNumero(num: string): string {
  return pick([num, `n°${num}`]);
}

export function jigAddress(raw: string): string {
  const parsed = parseAddress(raw);
  if (!parsed) return jiggLetters(raw);

  const prefix = `${jigNumero(parsed.numero)} ${parsed.voieType}`;
  const rest = `${parsed.voieName} ${parsed.cp} ${parsed.ville}`.replace(/\s+/g, ' ').trim();

  return `${prefix} ${jiggLetters(rest)}`;
}

export interface GeneratedAccount {
  prenom: string;
  nom: string;
  email: string;
  adresse: string;
  password: string;
}

export interface GenerateOptions {
  count?: number;
  baseAddress?: string;
  emailDomain?: string;
  /** Emails/addresses/passwords already in the carnet — never re-generate these,
   *  so no two accounts share an identical value. */
  excludeEmails?: string[];
  excludeAddresses?: string[];
  excludePasswords?: string[];
}

const PW_SETS = [
  'abcdefghijkmnpqrstuvwxyz',
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  '23456789',
  '!@#$%^&*',
];

/** Generate an 8-char password matching the existing convention: at least one
 *  lowercase, uppercase, digit and special char, shuffled. */
export function genPassword(): string {
  const all = PW_SETS.join('');
  const chars = PW_SETS.map((s) => s[Math.floor(Math.random() * s.length)]);
  while (chars.length < 8) chars.push(all[Math.floor(Math.random() * all.length)]);
  return shuffle(chars).join('');
}

const DEFAULT_BASE = '17 Allée Edith Piaf 35000 Rennes';

/** Dedup key for addresses: trim + collapse whitespace, but KEEP case/accents —
 *  the jiggle deliberately produces accent/case variants that must stay distinct. */
const normAddr = (s: string) => s.trim().replace(/\s+/g, ' ');

export function generateAccounts(opts: GenerateOptions = {}): GeneratedAccount[] {
  const count = Math.min(Math.max(opts.count ?? 1, 1), 100);
  const base = opts.baseAddress?.trim() || DEFAULT_BASE;
  const domain = opts.emailDomain?.trim() || 'a-bouchard.com';

  const out: GeneratedAccount[] = [];
  const seenEmails = new Set<string>((opts.excludeEmails ?? []).map((e) => e.trim().toLowerCase()));
  const seenAddresses = new Set<string>((opts.excludeAddresses ?? []).map(normAddr));
  const seenPasswords = new Set<string>(opts.excludePasswords ?? []);
  let attempts = 0;

  while (out.length < count && attempts < count * 40) {
    attempts++;
    const prenom = pick(PRENOMS);
    const nom = pick(NOMS);
    const email = makeEmail(prenom, nom, domain);
    if (seenEmails.has(email.toLowerCase())) continue;
    const adresse = jigAddress(base);
    if (seenAddresses.has(normAddr(adresse))) continue;
    let password = genPassword();
    let pwTries = 0;
    while (seenPasswords.has(password) && pwTries++ < 50) password = genPassword();
    seenEmails.add(email.toLowerCase());
    seenAddresses.add(normAddr(adresse));
    seenPasswords.add(password);
    out.push({ prenom, nom, email, adresse, password });
  }

  return out;
}

/** Generate `count` unique address variations of `base`, excluding any in
 *  `exclude` (and each other). Used to backfill accounts missing an address. */
export function generateUniqueAddresses(
  count: number,
  baseAddress?: string,
  exclude: string[] = []
): string[] {
  const base = baseAddress?.trim() || DEFAULT_BASE;
  const seen = new Set<string>(exclude.map(normAddr));
  const out: string[] = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 60) {
    attempts++;
    const adr = jigAddress(base);
    const key = normAddr(adr);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(adr);
  }
  return out;
}

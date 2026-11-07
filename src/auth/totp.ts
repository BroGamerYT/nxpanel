import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP nach RFC 6238 (SHA-1, 6 Stellen, 30 Sekunden) - das, was Google
 * Authenticator, Aegis, 2FAS, Bitwarden und Co. erwarten. Bewusst selbst
 * geschrieben: es sind 40 Zeilen, und eine Fremdbibliothek waere mehr
 * Angriffsflaeche als Nutzen.
 */
const STEP_S = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Ungueltiges Base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_S);
}

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return bin.toString().padStart(DIGITS, '0');
}

/**
 * Prueft einen Code. Erlaubt einen Schritt Abweichung (Uhr am Handy geht
 * etwas vor oder nach). Gibt den getroffenen Schritt zurueck - der muss
 * groesser sein als der zuletzt benutzte, sonst koennte ein mitgelesener
 * Code innerhalb seiner 30 Sekunden ein zweites Mal verwendet werden.
 */
export function verifyTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'NexusPanel'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_S) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Wiederherstellungscode im Format abcd-efgh-ijkl (leicht abzutippen, ~60 Bit). */
export function generateRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // ohne 0/o, 1/l/i
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

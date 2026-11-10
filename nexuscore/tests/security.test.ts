import { describe, expect, it } from 'vitest';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { validateRequestToken, createPairingPin, validatePairingPin, tokenFingerprint } =
  await import('../src/protocol/security.js');

describe('Security', () => {
  it('lehnt fehlende und falsche Tokens ab', () => {
    expect(validateRequestToken(undefined).valid).toBe(false);
    expect(validateRequestToken('Bearer falsch').valid).toBe(false);
  });

  it('akzeptiert das konfigurierte Token mit und ohne Bearer-Praefix', () => {
    expect(validateRequestToken('Bearer test-token-0123456789abcdefghij').valid).toBe(true);
    expect(validateRequestToken('test-token-0123456789abcdefghij').valid).toBe(true);
  });

  it('gibt nur einen Fingerabdruck des Tokens preis', () => {
    const fingerprint = tokenFingerprint();
    expect(fingerprint).not.toContain('test-token');
    expect(fingerprint).toHaveLength(12);
  });

  it('erzeugt eine PIN, die gueltig ist', () => {
    const pin = createPairingPin();
    expect(pin).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(validatePairingPin(pin)).toBe(true);
  });

  it('verbraucht die PIN nach der Kopplung', () => {
    const pin = createPairingPin();
    expect(validatePairingPin(pin)).toBe(true);
    expect(validatePairingPin(pin)).toBe(false);
  });

  it('lehnt eine falsche PIN ab', () => {
    createPairingPin();
    expect(validatePairingPin('ZZZ-ZZZ')).toBe(false);
  });
});

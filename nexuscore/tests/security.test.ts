import { describe, expect, it } from 'vitest';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const {
  validateRequestToken,
  createPairingPin,
  validatePairingPin,
  tokenFingerprint,
  normalizeRequestPath,
  isPublicRoute,
  createSessionToken,
  revokeSessionToken,
  isValidSessionToken,
} = await import('../src/protocol/security.js');

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

  describe('normalizeRequestPath & Traversal-Schutz (Block A1)', () => {
    it('normalisiert einfache Pfade und entfernt Query-Parameter', () => {
      expect(normalizeRequestPath('/core/v1/servers?foo=bar')).toBe('/core/v1/servers');
      expect(normalizeRequestPath('//core//v1///info')).toBe('/core/v1/info');
    });

    it('neutralisiert Path Traversal Versuche mit .. und Backslashes', () => {
      expect(normalizeRequestPath('/core/v1/../../api/panel/servers')).toBe('/api/panel/servers');
      expect(normalizeRequestPath('\\core\\v1\\info')).toBe('/core/v1/info');
    });

    it('dekodiert URL-Encodings inklusive mehrfacher Kodierung', () => {
      expect(normalizeRequestPath('/core/v1/%2e%2e/%2e%2e/api/panel/servers')).toBe('/api/panel/servers');
      expect(normalizeRequestPath('/core/v1/%252e%252e/api/panel/servers')).toBe('/core/api/panel/servers');
    });
  });

  describe('isPublicRoute Allowlist (Block A1)', () => {
    it('erlaubt genau gelistete oeffentliche Endpunkte', () => {
      expect(isPublicRoute('GET', '/core/v1/info')).toBe(true);
      expect(isPublicRoute('POST', '/core/v1/pair')).toBe(true);
      expect(isPublicRoute('POST', '/api/v1/auth/login')).toBe(true);
      expect(isPublicRoute('POST', '/api/v1/auth/refresh')).toBe(true);
      expect(isPublicRoute('GET', '/')).toBe(true);
      expect(isPublicRoute('GET', '/assets/index.js')).toBe(true);
      expect(isPublicRoute('GET', '/neu')).toBe(true);
    });

    it('blockiert geschuetzte Core- und API-Endpunkte ohne Token', () => {
      expect(isPublicRoute('GET', '/core/v1/servers')).toBe(false);
      expect(isPublicRoute('POST', '/core/v1/servers')).toBe(false);
      expect(isPublicRoute('GET', '/api/v1/servers')).toBe(false);
      expect(isPublicRoute('POST', '/api/v1/servers')).toBe(false);
      expect(isPublicRoute('GET', '/api/panel/servers')).toBe(false);
      expect(isPublicRoute('POST', '/api/panel/servers')).toBe(false);
      expect(isPublicRoute('GET', '/api/v1/auth/me')).toBe(false);
    });
  });

  describe('Sitzungs-Tokens (Standalone-Modus)', () => {
    it('erzeugt und validiert sichere Session-Tokens', () => {
      const token = createSessionToken();
      expect(token).toMatch(/^nxp_[a-f0-9]{48}$/);
      expect(isValidSessionToken(token)).toBe(true);
      expect(validateRequestToken(`Bearer ${token}`).valid).toBe(true);

      revokeSessionToken(token);
      expect(isValidSessionToken(token)).toBe(false);
      expect(validateRequestToken(`Bearer ${token}`).valid).toBe(false);
    });
  });
});

import { config } from '../config/index.js';

export interface AuthValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateRequestToken(headerToken?: string): AuthValidationResult {
  if (config.mode === 'test' && (!headerToken || headerToken === 'bearer-test-token')) {
    return { valid: true };
  }

  if (!headerToken) {
    return { valid: false, reason: 'Fehlender Authentifizierungs-Token.' };
  }

  const token = headerToken.replace(/^Bearer\s+/i, '');
  if (token === config.secretToken) {
    return { valid: true };
  }

  return { valid: false, reason: 'Ungültiger Authentifizierungs-Token.' };
}

export function validatePairingPin(pin: string): boolean {
  return pin === config.pairingPin;
}

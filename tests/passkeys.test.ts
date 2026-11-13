import { describe, it, expect } from 'vitest';
import { getRpInfo, getExpectedOrigins } from '../src/auth/passkeys.js';

describe('Passkeys & WebAuthn', () => {
  it('correctly resolves rpID and rpName', () => {
    const localhost = getRpInfo('localhost:8080');
    expect(localhost.rpID).toBe('localhost');
    expect(localhost.rpName).toBe('NexusPanel');

    const domain = getRpInfo('panel.example.com');
    expect(domain.rpID).toBe('panel.example.com');

    const ip = getRpInfo('192.0.2.10:8080');
    expect(ip.rpID).toBe('192.0.2.10');
  });

  it('includes configured origin and host origins', () => {
    const origins = getExpectedOrigins('panel.example.com');
    expect(origins).toContain('https://panel.example.com');
    expect(origins).toContain('http://panel.example.com');
    expect(origins).toContain('http://localhost:8080');
  });
});

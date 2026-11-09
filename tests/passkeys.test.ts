import { describe, it, expect } from 'vitest';
import { getRpInfo, getExpectedOrigins } from '../src/auth/passkeys.js';

describe('Passkeys & WebAuthn', () => {
  it('correctly resolves rpID and rpName', () => {
    const localhost = getRpInfo('localhost:8080');
    expect(localhost.rpID).toBe('localhost');
    expect(localhost.rpName).toBe('NexusPanel');

    const domain = getRpInfo('nxp.brogameryt.de');
    expect(domain.rpID).toBe('nxp.brogameryt.de');

    const ip = getRpInfo('10.0.0.120:8080');
    expect(ip.rpID).toBe('10.0.0.120');
  });

  it('includes configured origin and host origins', () => {
    const origins = getExpectedOrigins('nxp.brogameryt.de');
    expect(origins).toContain('https://nxp.brogameryt.de');
    expect(origins).toContain('http://nxp.brogameryt.de');
    expect(origins).toContain('http://localhost:8080');
  });
});

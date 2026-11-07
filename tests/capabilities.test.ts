import { describe, it, expect } from 'vitest';
import { filterCapabilities, sanitizeDataPath } from '../src/eggs/capabilities.js';

describe('Capabilities aus Eggs', () => {
  it('laesst die Rechte durch, die itzg braucht', () => {
    const r = filterCapabilities(['CHOWN', 'SETUID', 'SETGID']);
    expect(r.granted).toEqual(['CHOWN', 'SETUID', 'SETGID']);
    expect(r.rejected).toEqual([]);
  });

  it('verwirft gefaehrliche Rechte, egal was im Egg steht', () => {
    // Eggs kommen aus dem Internet. SYS_ADMIN in einem Spielserver ist
    // ein halber Ausbruch aus dem Container.
    const r = filterCapabilities(['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'CHOWN']);
    expect(r.granted).toEqual(['CHOWN']);
    expect(r.rejected).toEqual(['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE']);
  });

  it('versteht die Schreibweise mit CAP_ und in Kleinbuchstaben', () => {
    expect(filterCapabilities(['cap_chown', 'setuid']).granted).toEqual(['CHOWN', 'SETUID']);
  });

  it('nimmt Doppelte nur einmal', () => {
    expect(filterCapabilities(['CHOWN', 'chown']).granted).toEqual(['CHOWN']);
  });

  it('vertraegt Unsinn ohne zu werfen', () => {
    expect(filterCapabilities('CHOWN').granted).toEqual([]);
    expect(filterCapabilities(null).granted).toEqual([]);
    expect(filterCapabilities([42, {}, 'CHOWN']).granted).toEqual(['CHOWN']);
  });
});

describe('Datenpfad aus Eggs', () => {
  it('nimmt /data fuer itzg', () => {
    expect(sanitizeDataPath('/data')).toBe('/data');
  });

  it('faellt ohne Angabe auf die Pterodactyl-Konvention zurueck', () => {
    expect(sanitizeDataPath(undefined)).toBe('/home/container');
  });

  it('verweigert Systempfade', () => {
    // Ein Mount auf /etc wuerde die Dateien des Images ueberdecken.
    for (const p of ['/etc', '/usr/bin', '/root', '/', '/proc/self']) {
      expect(sanitizeDataPath(p)).toBe('/home/container');
    }
  });

  it('verweigert relative Pfade und Ausbrueche', () => {
    expect(sanitizeDataPath('data')).toBe('/home/container');
    expect(sanitizeDataPath('/data/../etc')).toBe('/home/container');
  });

  it('entfernt Schraegstriche am Ende', () => {
    expect(sanitizeDataPath('/data/')).toBe('/data');
  });
});

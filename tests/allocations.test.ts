import { describe, it, expect } from 'vitest';
import { findPortGroup, isBlocked, type EggPorts } from '../src/servers/allocations.js';

const minecraft: EggPorts = {
  primary: { ref: 'game', start: 25565, end: 25664, protocol: 'tcp' },
  secondary: [{ ref: 'rcon', offset: 10, protocol: 'tcp' }],
};

describe('Portvergabe', () => {
  it('gibt dem ersten Server 25565', () => {
    const g = findPortGroup(minecraft, new Set());
    expect(g?.[0]?.port).toBe(25565);
    expect(g?.[1]?.port).toBe(25575);
  });

  it('gibt dem zweiten Server 25566', () => {
    const g = findPortGroup(minecraft, new Set([25565, 25575]));
    expect(g?.[0]?.port).toBe(25566);
  });

  it('nimmt eine Luecke, statt immer hochzuzaehlen', () => {
    // Wird der zweite Server geloescht, soll der naechste wieder 25566
    // bekommen - sonst laufen die Nummern mit der Zeit auseinander.
    const g = findPortGroup(minecraft, new Set([25565, 25575, 25567, 25577]));
    expect(g?.[0]?.port).toBe(25566);
  });

  it('ueberspringt eine Gruppe, wenn der Nebenport belegt ist', () => {
    // Ein halb belegtes Portpaar bringt nichts.
    const g = findPortGroup(minecraft, new Set([25575]));
    expect(g?.[0]?.port).toBe(25566);
    expect(g?.[1]?.port).toBe(25576);
  });

  it('beachtet, was der Host schon belegt', () => {
    const g = findPortGroup(minecraft, new Set(), (p) => p !== 25565 && p !== 25566);
    expect(g?.[0]?.port).toBe(25567);
  });

  it('gibt null zurueck, wenn der Bereich voll ist', () => {
    const eng: EggPorts = { primary: { ref: 'game', start: 25565, end: 25566, protocol: 'tcp' } };
    expect(findPortGroup(eng, new Set([25565, 25566]))).toBeNull();
  });

  it('laesst optionale Nebenports aus, statt aufzugeben', () => {
    const spec: EggPorts = {
      primary: { ref: 'web', start: 8081, end: 8090, protocol: 'tcp' },
      secondary: [{ ref: 'tls', offset: 363, protocol: 'tcp', optional: true }],
    };
    const g = findPortGroup(spec, new Set(), (p) => p < 8444);
    expect(g?.[0]?.port).toBe(8081);
    expect(g).toHaveLength(1);
  });

  it('vergibt denselben Port nicht zweimal in einer Gruppe', () => {
    const spec: EggPorts = {
      primary: { ref: 'game', start: 7777, end: 7800, protocol: 'udp' },
      secondary: [{ ref: 'query', start: 7777, end: 7800, protocol: 'udp' }],
    };
    const g = findPortGroup(spec, new Set());
    expect(g?.[0]?.port).not.toBe(g?.[1]?.port);
  });
});

describe('Gesperrte Ports', () => {
  it('vergibt nichts unter 1024', () => {
    expect(isBlocked(80)).toBe(true);
    expect(isBlocked(1023)).toBe(true);
  });

  it('haelt bekannte Dienste frei', () => {
    for (const p of [3306, 5432, 6379, 8080]) expect(isBlocked(p)).toBe(true);
  });

  it('erlaubt gewoehnliche Spielports', () => {
    for (const p of [25565, 7777, 27015]) expect(isBlocked(p)).toBe(false);
  });

  it('vergibt keinen gesperrten Port, auch wenn er im Bereich liegt', () => {
    const spec: EggPorts = { primary: { ref: 'web', start: 8078, end: 8085, protocol: 'tcp' } };
    const g = findPortGroup(spec, new Set());
    expect(g?.[0]?.port).toBe(8078);
    const voll = findPortGroup(spec, new Set([8078, 8079]));
    expect(voll?.[0]?.port).toBe(8081); // 8080 wird uebersprungen
  });
});

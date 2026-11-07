import { describe, it, expect } from 'vitest';
import {
  can, canSee, canDeleteServer, canCreateServer, canGrant, effectiveFlags, PRESETS, SERVER_FLAGS,
  FLAG_LABELS, type Actor,
} from '../src/auth/permissions.js';

const owner: Actor = { id: 'o', role: 'user', canCreateServers: true };
const stranger: Actor = { id: 'x', role: 'user', canCreateServers: false };
const mod: Actor = { id: 'm', role: 'moderator', canCreateServers: false };
const admin: Actor = { id: 'a', role: 'admin', canCreateServers: false };
const sub: Actor = { id: 's', role: 'user', canCreateServers: false };

const plain = { ownerId: 'o', subuserFlags: null };
const asSub = (flags: readonly string[]) => ({ ownerId: 'o', subuserFlags: flags });

describe('Rechte', () => {
  it('jedes Flag hat eine Beschriftung', () => {
    for (const f of SERVER_FLAGS) expect(FLAG_LABELS[f]).toBeTruthy();
  });

  it('Besitzer, Admin und Moderator haben alle Flags', () => {
    for (const a of [owner, admin, mod]) expect(effectiveFlags(a, plain)).toHaveLength(SERVER_FLAGS.length);
  });

  it('Fremde sehen den Server nicht und duerfen nichts', () => {
    expect(canSee(stranger, plain)).toBe(false);
    expect(can(stranger, plain, 'control.start')).toBe(false);
  });

  it('Mitnutzer hat genau seine Flags, unbekannte werden ignoriert', () => {
    const access = asSub(['control.console', 'gibt.es.nicht']);
    expect(canSee(sub, access)).toBe(true);
    expect(effectiveFlags(sub, access)).toEqual(['control.console']);
    expect(can(sub, access, 'control.start')).toBe(false);
  });

  it('Mitnutzer ohne Flags ist unsichtbar', () => {
    expect(canSee(sub, asSub([]))).toBe(false);
  });

  it('Loeschen: nur Admin und Besitzer, nicht Moderator, nicht Co-Admin', () => {
    expect(canDeleteServer(admin, plain)).toBe(true);
    expect(canDeleteServer(owner, plain)).toBe(true);
    expect(canDeleteServer(mod, plain)).toBe(false);
    expect(canDeleteServer(sub, asSub(PRESETS['co-admin'].flags))).toBe(false);
  });

  it('server.create: Admin immer, sonst nur mit ausdruecklichem Recht', () => {
    expect(canCreateServer(admin)).toBe(true);
    expect(canCreateServer(owner)).toBe(true);
    expect(canCreateServer(stranger)).toBe(false);
    expect(canCreateServer(mod)).toBe(false);
  });

  it('Presets bauen aufeinander auf', () => {
    const z = new Set(PRESETS.zuschauer.flags);
    const o = new Set(PRESETS.operator.flags);
    const v = new Set(PRESETS.verwalter.flags);
    const c = new Set(PRESETS['co-admin'].flags);
    for (const f of z) expect(o.has(f)).toBe(true);
    for (const f of o) expect(v.has(f)).toBe(true);
    for (const f of v) expect(c.has(f)).toBe(true);
    expect(o.has('control.start')).toBe(true);
    expect(z.has('control.start')).toBe(false);
    // file.write ist faktisch Vollzugriff - gehoert in kein harmloses Preset
    expect(o.has('file.write')).toBe(false);
    expect(v.has('file.write')).toBe(true);
    // Neuinstallation loescht Daten: in keinem Preset
    expect(c.has('settings.reinstall')).toBe(false);
  });

  it('Niemand vergibt mehr, als er selbst hat', () => {
    const coAdmin = asSub(PRESETS['co-admin'].flags);
    expect(canGrant(sub, coAdmin, ['control.start', 'file.read']).ok).toBe(true);
    const r = canGrant(sub, coAdmin, ['control.kill', 'settings.reinstall', 'quatsch']);
    expect(r.ok).toBe(false);
    expect(r.denied).toEqual(['control.kill', 'settings.reinstall', 'quatsch']);
    expect(canGrant(owner, plain, ['settings.reinstall']).ok).toBe(true);
  });

  it('allowedEggs beschraenkt Spielauswahl beim Server-Erstellen', () => {
    const limitedUser: Actor = { id: 'u1', role: 'user', canCreateServers: true, allowedEggs: ['minecraft-paper', 'sons-of-the-forest'] };
    expect(canCreateServer(limitedUser, 'minecraft-paper')).toBe(true);
    expect(canCreateServer(limitedUser, 'sons-of-the-forest')).toBe(true);
    expect(canCreateServer(limitedUser, 'palworld')).toBe(false);

    // Admin darf immer alles
    expect(canCreateServer(admin, 'palworld')).toBe(true);

    // Nutzer mit allowedEggs = null darf alles
    const openUser: Actor = { id: 'u2', role: 'user', canCreateServers: true, allowedEggs: null };
    expect(canCreateServer(openUser, 'palworld')).toBe(true);
  });
});

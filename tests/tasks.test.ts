import { describe, it, expect } from 'vitest';
import { activeGameUpdates } from '../src/http/routes/servers.js';

describe('Hintergrund-Aufgaben & Task-Tracking', () => {
  it('activeGameUpdates speichert und aktualisiert Schritte eines 1-Klick-Updates', () => {
    const serverId = 'test-server-123';
    activeGameUpdates.set(serverId, {
      serverId,
      step: 'backup',
      backupId: 'b-999',
      startedAt: Date.now(),
    });

    const active = activeGameUpdates.get(serverId);
    expect(active).toBeDefined();
    expect(active?.step).toBe('backup');
    expect(active?.backupId).toBe('b-999');

    // Schritt aktualisieren
    activeGameUpdates.set(serverId, {
      ...active!,
      step: 'pulling',
    });
    expect(activeGameUpdates.get(serverId)?.step).toBe('pulling');

    activeGameUpdates.delete(serverId);
    expect(activeGameUpdates.has(serverId)).toBe(false);
  });

  it('berechnet Prozentwerte fuer Zstd-Backups plausibel', () => {
    const totalBytes = 10 * 1024 * 1024 * 1024; // 10 GB
    const targetCompressed = totalBytes * 0.45; // ~4.5 GB

    const bytesWritten = 2.25 * 1024 * 1024 * 1024; // 50% der Zielgroesse
    const progressPercent = Math.min(99, Math.max(5, Math.round((bytesWritten / targetCompressed) * 100)));

    expect(progressPercent).toBe(50);
  });
});

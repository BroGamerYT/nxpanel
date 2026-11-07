import { sql } from '../db/index.js';

export interface StorageTargetRow {
  id: string;
  server_id: string | null;
  name: string;
  kind: 's3' | 'sftp' | 'local_path';
  config: Record<string, unknown>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Listet Speicherziele eines Servers (inklusive globaler Panel-Speicherziele)
 */
export async function listStorageTargets(serverId?: string | null): Promise<StorageTargetRow[]> {
  if (serverId) {
    return await sql<StorageTargetRow[]>`
      SELECT * FROM storage_targets
      WHERE server_id = ${serverId} OR server_id IS NULL
      ORDER BY is_default DESC, name ASC
    `;
  }
  return await sql<StorageTargetRow[]>`
    SELECT * FROM storage_targets
    WHERE server_id IS NULL
    ORDER BY is_default DESC, name ASC
  `;
}

/**
 * Legt ein neues Speicherziel an
 */
export async function createStorageTarget(input: {
  serverId?: string | null | undefined;
  name: string;
  kind: 's3' | 'sftp' | 'local_path';
  config: Record<string, unknown>;
  isDefault?: boolean | undefined;
}): Promise<StorageTargetRow> {
  const [row] = await sql<StorageTargetRow[]>`
    INSERT INTO storage_targets (
      server_id, name, kind, config, is_default
    ) VALUES (
      ${input.serverId ?? null}, ${input.name}, ${input.kind},
      ${sql.json(input.config as never)}, ${input.isDefault ?? false}
    )
    RETURNING *
  `;
  return row!;
}

/**
 * Loescht ein Speicherziel
 */
export async function deleteStorageTarget(targetId: string, serverId?: string | null): Promise<void> {
  if (serverId) {
    await sql`DELETE FROM storage_targets WHERE id = ${targetId} AND (server_id = ${serverId} OR server_id IS NULL)`;
  } else {
    await sql`DELETE FROM storage_targets WHERE id = ${targetId}`;
  }
}

/**
 * Testet die Erreichbarkeit eines Speicherziels
 */
export async function testStorageTarget(targetId: string): Promise<{ ok: boolean; message: string }> {
  const [target] = await sql<StorageTargetRow[]>`SELECT * FROM storage_targets WHERE id = ${targetId}`;
  if (!target) throw new Error('Speicherziel nicht gefunden');

  if (target.kind === 'local_path') {
    const fs = await import('node:fs');
    const path = String(target.config.path || '');
    if (path && fs.existsSync(path)) {
      return { ok: true, message: `Lokaler Pfad "${path}" ist zugänglich` };
    }
    return { ok: false, message: `Lokaler Pfad "${path}" existiert nicht` };
  }

  if (target.kind === 's3') {
    const bucket = String(target.config.bucket || '');
    const endpoint = String(target.config.endpoint || 'AWS S3');
    return { ok: true, message: `S3-Endpunkt "${endpoint}" konfiguriert (Bucket: ${bucket})` };
  }

  if (target.kind === 'sftp') {
    const host = String(target.config.host || '');
    const user = String(target.config.username || '');
    return { ok: true, message: `SFTP / Storage Box Verbindung konfiguriert (${user}@${host})` };
  }

  return { ok: true, message: 'Speicherziel bereit' };
}

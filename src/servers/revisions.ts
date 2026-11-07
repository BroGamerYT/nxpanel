import { sql } from '../db/index.js';
import { safePath, writeFileContent } from './files.js';

export interface FileRevisionRow {
  id: string;
  server_id: string;
  path: string;
  content: string;
  author_id: string | null;
  author_name: string;
  change_summary: string | null;
  bytes: number;
  created_at: string;
}

/**
 * Speichert eine Version/Revision einer bearbeiteten Datei
 */
export async function saveRevision(
  serverId: string,
  path: string,
  content: string,
  actor?: { id: string; username: string },
  summary?: string
): Promise<FileRevisionRow> {
  const bytes = Buffer.byteLength(content, 'utf-8');
  const [row] = await sql<FileRevisionRow[]>`
    INSERT INTO file_revisions (
      server_id, path, content, author_id, author_name, change_summary, bytes
    ) VALUES (
      ${serverId}, ${path}, ${content}, ${actor?.id ?? null},
      ${actor?.username ?? 'System'}, ${summary ?? null}, ${bytes}
    )
    RETURNING *
  `;

  // Auf maximal 25 Versionen pro Datei beschraenken (aelteste loeschen)
  await sql`
    DELETE FROM file_revisions
    WHERE id IN (
      SELECT id FROM file_revisions
      WHERE server_id = ${serverId} AND path = ${path}
      ORDER BY created_at DESC
      OFFSET 25
    )
  `;

  return row!;
}

/**
 * Listet alle Revisionen einer Datei auf (ohne den vollen Inhalt zur Bandbreitenschonung)
 */
export async function listRevisions(
  serverId: string,
  path: string
): Promise<Omit<FileRevisionRow, 'content'>[]> {
  return await sql<Omit<FileRevisionRow, 'content'>[]>`
    SELECT id, server_id, path, author_id, author_name, change_summary, bytes, created_at
    FROM file_revisions
    WHERE server_id = ${serverId} AND path = ${path}
    ORDER BY created_at DESC
  `;
}

/**
 * Holt eine einzelne Revision inklusive des vollstaendigen Inhalts (fuer Diff / Vorschau)
 */
export async function getRevision(
  serverId: string,
  revisionId: string
): Promise<FileRevisionRow> {
  const [row] = await sql<FileRevisionRow[]>`
    SELECT * FROM file_revisions
    WHERE id = ${revisionId} AND server_id = ${serverId}
  `;
  if (!row) throw new Error('Revision nicht gefunden');
  return row;
}

/**
 * Stellt den Inhalt einer Revision wieder her (Rollback)
 */
export async function rollbackRevision(
  serverId: string,
  shortId: string,
  revisionId: string,
  actor?: { id: string; username: string }
): Promise<{ ok: boolean; path: string; restoredBytes: number }> {
  const rev = await getRevision(serverId, revisionId);

  // Zuerst eine Sicherung des aktuellen Stands vor dem Rollback anlegen
  try {
    const { fullPath } = await safePath(shortId, rev.path);
    const fs = await import('node:fs/promises');
    if (await fs.stat(fullPath).then(() => true).catch(() => false)) {
      const currentContent = await fs.readFile(fullPath, 'utf-8');
      await saveRevision(serverId, rev.path, currentContent, actor, `Stand vor Rollback auf Version vom ${new Date(rev.created_at).toLocaleString('de-DE')}`);
    }
  } catch {}

  // Datei mit dem historischen Stand ueberschreiben
  await writeFileContent(shortId, rev.path, rev.content);

  // Neuen Revisions-Eintrag fuer den Rollback selbst anlegen
  await saveRevision(
    serverId,
    rev.path,
    rev.content,
    actor,
    `Wiederhergestellt von Version ${rev.id.slice(0, 8)} (${new Date(rev.created_at).toLocaleString('de-DE')})`
  );

  return { ok: true, path: rev.path, restoredBytes: rev.bytes };
}

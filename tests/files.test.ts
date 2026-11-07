import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  safePath,
  listDirectory,
  writeFileContent,
  readFileContent,
  createDirectory,
  renamePath,
  deletePath,
  compressToZip,
  decompressArchive,
  FilePathSecurityError,
} from '../src/servers/files.js';
import { volumePath } from '../src/docker/client.js';

describe('Dateimanager & Pfadsicherheit', () => {
  const testId = 'test-filemgr-srv';
  const root = volumePath(testId);

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o750 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('erlaubt gueltige relative Pfade und normalisiert Slashes', async () => {
    const p1 = await safePath(testId, 'server.properties');
    expect(p1.relPath).toBe('server.properties');
    expect(p1.fullPath).toBe(resolve(root, 'server.properties'));

    const p2 = await safePath(testId, 'config/settings.json');
    expect(p2.relPath).toBe('config/settings.json');

    const p3 = await safePath(testId, '/config/nested/file.txt');
    expect(p3.relPath).toBe('config/nested/file.txt');
  });

  it('verhindert Directory-Traversal (../)', async () => {
    await expect(safePath(testId, '../outside.txt')).rejects.toThrow(FilePathSecurityError);
    await expect(safePath(testId, 'a/../../outside.txt')).rejects.toThrow(FilePathSecurityError);
    await expect(safePath(testId, '..\\..\\windows.ini')).rejects.toThrow(FilePathSecurityError);
  });

  it('lehnt Null-Bytes und absolute Pfade ab', async () => {
    await expect(safePath(testId, 'test\0file.txt')).rejects.toThrow(FilePathSecurityError);
  });

  it('kann Dateien anlegen, lesen, ueberschreiben und auflisten', async () => {
    await writeFileContent(testId, 'server.properties', 'server-port=25565\nmotd=NexusPanel\n');
    await createDirectory(testId, 'logs');
    await writeFileContent(testId, 'logs/latest.log', '[INFO] Server started\n');

    const { content, size } = await readFileContent(testId, 'server.properties');
    expect(content).toContain('server-port=25565');
    expect(size).toBeGreaterThan(0);

    const listRoot = await listDirectory(testId, '');
    expect(listRoot.entries).toHaveLength(2);
    expect(listRoot.entries[0].name).toBe('logs');
    expect(listRoot.entries[0].is_directory).toBe(true);
    expect(listRoot.entries[1].name).toBe('server.properties');
    expect(listRoot.entries[1].is_directory).toBe(false);

    const listLogs = await listDirectory(testId, 'logs');
    expect(listLogs.entries).toHaveLength(1);
    expect(listLogs.entries[0].name).toBe('latest.log');
  });

  it('kann Dateien und Ordner umbenennen und verschieben', async () => {
    await writeFileContent(testId, 'old_name.txt', 'hello world');
    await createDirectory(testId, 'sub');

    await renamePath(testId, 'old_name.txt', 'sub/new_name.txt');

    expect(existsSync(join(root, 'old_name.txt'))).toBe(false);
    expect(existsSync(join(root, 'sub', 'new_name.txt'))).toBe(true);

    const read = await readFileContent(testId, 'sub/new_name.txt');
    expect(read.content).toBe('hello world');
  });

  it('kann Dateien und Ordner loeschen, verweigert aber das Wurzelverzeichnis', async () => {
    await writeFileContent(testId, 'to_delete.txt', 'temp');
    await createDirectory(testId, 'folder_to_delete');
    await writeFileContent(testId, 'folder_to_delete/sub.txt', 'temp2');

    await deletePath(testId, 'to_delete.txt');
    expect(existsSync(join(root, 'to_delete.txt'))).toBe(false);

    await deletePath(testId, 'folder_to_delete');
    expect(existsSync(join(root, 'folder_to_delete'))).toBe(false);

    await expect(deletePath(testId, '')).rejects.toThrow(FilePathSecurityError);
    await expect(deletePath(testId, '/')).rejects.toThrow(FilePathSecurityError);
  });

  it('kann Dateien packen und wieder entpacken', async () => {
    await writeFileContent(testId, 'file1.txt', 'Content 1');
    await createDirectory(testId, 'data');
    await writeFileContent(testId, 'data/file2.txt', 'Content 2');

    const zipResult = await compressToZip(testId, ['file1.txt', 'data'], 'backup.zip');
    expect(zipResult.path).toBe('backup.zip');
    expect(zipResult.size).toBeGreaterThan(0);
    expect(existsSync(join(root, 'backup.zip'))).toBe(true);

    // In Unterordner entpacken
    await decompressArchive(testId, 'backup.zip', 'extracted');
    expect(existsSync(join(root, 'extracted', 'file1.txt'))).toBe(true);
    expect(existsSync(join(root, 'extracted', 'data', 'file2.txt'))).toBe(true);

    const check = await readFileContent(testId, 'extracted/file1.txt');
    expect(check.content).toBe('Content 1');
  });
});

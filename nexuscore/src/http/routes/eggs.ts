import { installPlanFor } from '../../install/manager.js';
import { loadEggs } from '../../eggs/loader.js';
import { isValidChoice, readCustomCover, saveCustomCover, steamAppId, steamCover } from '../covers.js';
import type { ApiContext } from './api-context.js';

/**
 * Spielekatalog: Eggs, Titelbilder.
 */
export function registerEggRoutes(ctx: ApiContext): void {
  const { server, driver, registry, installs, options, coverDir, storedCover, coverOf } = ctx;

  // 4. Spielekatalog (Eggs)
  server.get('/api/v1/eggs', async () => {
    const eggs = await loadEggs();
    return {
      eggs: eggs.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        author: e.author,
        images: e.images,
        consoleMode: e.consoleMode,
        resources: e.resources,
        servers: 0,
        cover: coverOf(e),
        coverChoice: storedCover(e.id)?.choice ?? 'auto',
        hasSteamCover: steamAppId(e.name, e.raw) !== null,
        // Ohne Installer (Docker, Mock) bleibt alles wie im Panel; sonst nur, was der Core selbst installieren kann
        installable: driver.name === 'docker' ? e.images.length > 0 : !installs || installPlanFor(e.id, e.raw, {}) !== null,
      })),
    };
  });

  // Titelbild eines Spiels. Der Browser schickt das Cookie der Sitzung mit,
  // ein <img> braucht keinen Bearer-Token.
  server.get<{ Params: { id: string } }>('/api/v1/eggs/:id/cover', async (req, reply) => {
    const egg = (await loadEggs()).find((e) => e.id === req.params.id);
    if (!egg) return reply.status(404).send({ error: 'Egg nicht gefunden' });

    const choice = storedCover(egg.id)?.choice ?? 'auto';

    if (choice === 'custom') {
      const custom = await readCustomCover(coverDir, egg.id);
      if (!custom) return reply.status(404).send({ error: 'Kein eigenes Bild vorhanden' });
      return reply.header('Cache-Control', 'private, max-age=86400').type(custom.type).send(custom.data);
    }

    const appId = choice === 'random' || choice.startsWith('branding:') ? null : steamAppId(egg.name, egg.raw);
    if (appId === null) return reply.status(404).send({ error: 'Dieses Spiel hat kein Steam-Bild' });
    const image = await steamCover(appId, coverDir, options.fetchImpl);
    if (!image) {
      // Nicht zwischenspeichern: beim naechsten Versuch ist Steam vielleicht wieder da.
      reply.header('Cache-Control', 'no-store');
      return reply.status(404).send({ error: 'Steam-Bild nicht erreichbar' });
    }
    return reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(image);
  });

  // Admin: Titelbild waehlen (automatisch, Steam, Panel-Motiv) oder eigenes Bild hochladen.
  server.put<{ Params: { id: string }; Body: { choice?: unknown; upload?: unknown } | undefined }>(
    '/api/v1/admin/eggs/:id/cover',
    { bodyLimit: 3 * 1024 * 1024 },
    async (req, reply) => {
      const egg = (await loadEggs()).find((e) => e.id === req.params.id);
      if (!egg) return reply.status(404).send({ error: 'Egg nicht gefunden' });

      const body = req.body ?? {};
      const stamp = String(Date.now());
      try {
        if (typeof body.upload === 'string') {
          await saveCustomCover(coverDir, egg.id, body.upload);
          registry.setSetting(`cover.${egg.id}`, { choice: 'custom', v: stamp });
          registry.audit('egg.cover', null, 'standalone', { egg: egg.id, choice: 'custom' });
        } else if (typeof body.choice === 'string' && isValidChoice(body.choice)) {
          if (body.choice === 'steam' && steamAppId(egg.name, egg.raw) === null) {
            return reply.status(400).send({ error: 'Dieses Spiel hat kein Steam-Bild.' });
          }
          if (body.choice === 'custom' && !(await readCustomCover(coverDir, egg.id))) {
            return reply.status(400).send({ error: 'Es gibt noch kein eigenes Bild.' });
          }
          if (body.choice === 'auto') registry.deleteSetting(`cover.${egg.id}`);
          else registry.setSetting(`cover.${egg.id}`, { choice: body.choice, v: stamp });
          registry.audit('egg.cover', null, 'standalone', { egg: egg.id, choice: body.choice });
        } else {
          return reply.status(400).send({ error: 'Ungueltige Angabe' });
        }
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      return { ok: true };
    },
  );

  server.get<{ Params: { id: string } }>('/api/v1/eggs/:id', async (req, reply) => {
    const eggs = await loadEggs();
    const egg = eggs.find((e) => e.id === req.params.id);
    if (!egg) {
      return reply.status(404).send({ error: 'Egg nicht gefunden' });
    }

    const variables = (egg.raw.variables ?? []).map((v) => ({
      env: v.env_variable,
      label: v.name,
      description: v.description || null,
      default: v.default_value || '',
      secret: false,
      editable: v.user_editable ?? true,
      requires: null,
      widget: 'text',
      required: false,
      type: 'string',
    }));

    return {
      egg: {
        ...egg,
        variables,
        ports: egg.raw.ports ?? {},
      },
    };
  });
}

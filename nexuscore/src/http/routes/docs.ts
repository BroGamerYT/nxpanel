import type { FastifyInstance } from 'fastify';
import { getDoc, listDocs } from '../../docs.js';

/** Hilfe-Seite: Liste der Dokumente und ein einzelnes Dokument (nur angemeldet, nur lesen). */
export function registerDocsRoutes(server: FastifyInstance): void {
  server.get('/api/v1/docs', async () => ({ docs: await listDocs() }));

  server.get<{ Params: { slug: string } }>('/api/v1/docs/:slug', async (req, reply) => {
    // Nur ein einfacher Name: ein Pfad wird nie gelesen, die Auflistung bestimmt, was es gibt
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(req.params.slug)) return reply.status(404).send({ error: 'Dokument nicht gefunden', code: 'not_found' });
    const doc = await getDoc(req.params.slug);
    if (!doc) return reply.status(404).send({ error: 'Dokument nicht gefunden', code: 'not_found' });
    return doc;
  });
}

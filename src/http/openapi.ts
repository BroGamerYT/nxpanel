import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { loginBody, refreshBody, passwordBody, meBody } from './routes/auth.js';
import { createBody, patchBody, powerBody, eventsQuery } from './routes/servers.js';
import { addBody, flagsInput } from './routes/subusers.js';
import { startupBody, resourcesBody, extraPortBody, updatePortBody } from './routes/server-settings.js';
import { importBody, analyzeBody } from './routes/import.js';
import { iconBody, playerActionBody } from './routes/game.js';
import { pruneBody, newUserBody, patchUserBody, auditQuery, patchNodeBody } from './routes/admin.js';

/**
 * API-Dokumentation unter /api/docs, erzeugt aus den Routen selbst.
 *
 * Die Eingaben werden in den Routen mit zod geprueft. Statt jede Route mit
 * einem zweiten, von Hand gepflegten JSON-Schema zu versehen (das frueher
 * oder spaeter vom Code abweicht), werden hier dieselben zod-Schemas in die
 * Doku uebersetzt. Fastify selbst sieht davon nichts - geprueft wird
 * weiterhin nur an einer Stelle.
 */
interface Doc {
  tag: string;
  summary: string;
  description?: string;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  public?: boolean;
}

const totpConfirm = z.object({ password: z.string(), totp: z.string().optional(), recoveryCode: z.string().optional() });

const DOCS: Record<string, Doc> = {
  'GET /api/v1/': { tag: 'System', summary: 'Name und Version', public: true },
  'GET /api/v1/dashboard': { tag: 'System', summary: 'Gesamtlast der sichtbaren Server, live je Server; fuer Admins Grundleistung des Hosts' },
  'GET /api/v1/admin/network/check': { tag: 'Admin', summary: 'Verbindungstest: DNS und HTTPS zu Epic, ausgehende Adresse, Uhrzeit der VM' },
  'GET /api/v1/admin/test-report': { tag: 'Admin', summary: 'Ergebnisse des automatischen Spiele-Testlaufs abrufen' },
  'POST /api/v1/admin/test-games': { tag: 'Admin', summary: 'Automatischen Spiele-Testlauf im Hintergrund starten' },
  'POST /api/v1/admin/test-games/stop': { tag: 'Admin', summary: 'Laufenden Spiele-Testlauf abbrechen' },
  'GET /api/v1/admin/integrations': { tag: 'Admin', summary: 'Konfigurierte Integrationen (Discord Webhook, Playit.gg Tunnel)' },
  'POST /api/v1/admin/integrations/discord': { tag: 'Admin', summary: 'Discord-Webhook URL und Aktivierung einstellen' },
  'POST /api/v1/admin/integrations/discord/test': { tag: 'Admin', summary: 'Testnachricht an Discord Webhook senden' },
  'POST /api/v1/admin/integrations/playit': { tag: 'Admin', summary: 'Playit.gg Tunnel Secret Key einstellen' },
  'GET /api/v1/servers/{id}/logs': { tag: 'Server', summary: 'Logdateien des Servers, neueste zuerst' },
  'GET /api/v1/servers/{id}/logs/file': { tag: 'Server', summary: 'Logdatei lesen (letzte Zeilen) oder mit download=1 herunterladen' },
  'GET /api/v1/servers/{id}/game-status': { tag: 'Server', summary: 'Live aus dem Spiel: Spieler, Version, Antwortzeit, TPS (Minecraft)' },
  'GET /api/v1/servers/{id}/players/lists': { tag: 'Server', summary: 'Bann-, Whitelist- und OP-Liste' },
  'POST /api/v1/servers/{id}/players/action': { tag: 'Server', summary: 'Spieler kicken, bannen (auch auf Zeit), entbannen, OP, Whitelist', body: playerActionBody },
  'GET /api/v1/servers/{id}/mc/icon': { tag: 'Server', summary: 'Minecraft-Servericon' },
  'PUT /api/v1/servers/{id}/mc/icon': { tag: 'Server', summary: 'Minecraft-Servericon setzen (PNG 64x64, base64)', body: iconBody },
  'DELETE /api/v1/servers/{id}/mc/icon': { tag: 'Server', summary: 'Minecraft-Servericon entfernen' },
  'POST /api/v1/admin/docker/prune': { tag: 'Admin', summary: 'Docker aufraeumen: ungenutzte Images und Build-Cache loeschen', body: pruneBody },
  'GET /api/v1/servers/{id}/history': { tag: 'Server', summary: 'Verlauf der letzten Stunde (alle 10 s): CPU, RAM, Download, Upload' },
  'GET /api/v1/about': { tag: 'System', summary: 'Version, Build, Aenderungen (CHANGELOG) und Planung (TODO)' },
  'GET /api/v1/docs': { tag: 'System', summary: 'Alle Dokumentationsdateien (.md) auflisten' },
  'GET /api/v1/docs/{slug}': { tag: 'System', summary: 'Einzelne Dokumentationsdatei (.md) als Markdown abrufen' },
  'GET /healthz': { tag: 'System', summary: 'Prozess lebt', public: true },
  'GET /readyz': { tag: 'System', summary: 'Datenbank und Docker erreichbar', public: true },

  'POST /api/v1/auth/login': { tag: 'Anmeldung', summary: 'Anmelden', public: true, body: loginBody,
    description: 'Mit Benutzername oder E-Mail. Ist 2FA aktiv und fehlt der Code, kommt 401 mit code "totp_required". client "web": Refresh-Token als httpOnly-Cookie; "app": im Body.' },
  'POST /api/v1/auth/refresh': { tag: 'Anmeldung', summary: 'Zugangstoken erneuern (rotiert den Refresh-Token)', public: true, body: refreshBody },
  'POST /api/v1/auth/logout': { tag: 'Anmeldung', summary: 'Dieses Geraet abmelden' },
  'POST /api/v1/auth/logout-all': { tag: 'Anmeldung', summary: 'Alle Geraete abmelden' },
  'GET /api/v1/auth/me': { tag: 'Anmeldung', summary: 'Eigenes Konto und globale Rechte' },
  'PATCH /api/v1/auth/me': { tag: 'Anmeldung', summary: 'Eigene Einstellungen aendern (Sprache)', body: meBody },
  'GET /api/v1/auth/sessions': { tag: 'Anmeldung', summary: 'Angemeldete Geraete' },
  'DELETE /api/v1/auth/sessions/{id}': { tag: 'Anmeldung', summary: 'Ein Geraet abmelden' },
  'POST /api/v1/auth/password': { tag: 'Anmeldung', summary: 'Passwort aendern (beendet alle Sitzungen)', body: passwordBody },
  'GET /api/v1/auth/permissions': { tag: 'Anmeldung', summary: 'Alle Rechte-Flags mit Beschriftung und die Presets' },
  'POST /api/v1/auth/totp/setup': { tag: 'Zwei-Faktor', summary: 'Einrichtung starten: Geheimnis und otpauth-URL fuer den QR-Code' },
  'POST /api/v1/auth/totp/enable': { tag: 'Zwei-Faktor', summary: 'Mit erstem Code aktivieren, liefert einmalig 10 Wiederherstellungscodes',
    body: z.object({ code: z.string() }) },
  'POST /api/v1/auth/totp/disable': { tag: 'Zwei-Faktor', summary: 'Abschalten (Passwort + Code)', body: totpConfirm },
  'POST /api/v1/auth/totp/recovery-codes': { tag: 'Zwei-Faktor', summary: 'Neue Wiederherstellungscodes (alte werden ungueltig)', body: totpConfirm },

  'GET /api/v1/servers': { tag: 'Server', summary: 'Alle sichtbaren Server mit den eigenen Rechten je Server' },
  'POST /api/v1/servers': { tag: 'Server', summary: 'Server anlegen (Recht server.create)', body: createBody,
    description: 'Antwortet sofort mit 201 und Status "installing". Image holen und Installieren laufen im Hintergrund; Fortschritt ueber /events.' },
  'GET /api/v1/servers/{id}': { tag: 'Server', summary: 'Details (UUID oder Kurz-ID)' },
  'PATCH /api/v1/servers/{id}': { tag: 'Server', summary: 'Name, Beschreibung, Auto-Neustart', body: patchBody },
  'DELETE /api/v1/servers/{id}': { tag: 'Server', summary: 'Loeschen (nur Admin und Besitzer)', query: z.object({ force: z.enum(['true']).optional() }) },
  'POST /api/v1/servers/{id}/power': { tag: 'Server', summary: 'Starten, Stoppen, Neustarten, Abwuergen', body: powerBody },
  'POST /api/v1/servers/{id}/reinstall': { tag: 'Server', summary: 'Neu installieren (Recht settings.reinstall)' },
  'POST /api/v1/servers/{id}/ws-ticket': { tag: 'Konsole', summary: 'Einmal-Ticket fuer die Live-Verbindung (60 s)' },
  'GET /api/v1/servers/{id}/ws': { tag: 'Konsole', summary: 'WebSocket: Konsole, Status, Auslastung', public: true,
    description: 'Aufbau mit ?ticket=... aus /ws-ticket. Server sendet hello, log, status, event, stats, error. Client sendet {"type":"command","data":"say hi"} (Recht control.command).',
    query: z.object({ ticket: z.string() }) },
  'GET /api/v1/servers/{id}/allocations': { tag: 'Server', summary: 'Vergebene Ports' },
  'GET /api/v1/servers/{id}/startup': { tag: 'Einstellungen', summary: 'Spiel-Einstellungen als Formular mit aktuellen Werten' },
  'GET /api/v1/servers/{id}/configs': { tag: 'Einstellungen', summary: 'Bekannte Konfigurationsdateien fuer Formular-Bearbeitung abfragen' },
  'PATCH /api/v1/servers/{id}/startup': { tag: 'Einstellungen', summary: 'Variablen und Image aendern (nur gestoppt, Container wird neu angelegt)', body: startupBody },
  'PATCH /api/v1/servers/{id}/resources': { tag: 'Einstellungen', summary: 'RAM, CPU, Speicher (Admin/Besitzer, Budget wird geprueft)', body: resourcesBody },
  'POST /api/v1/servers/{id}/reallocate': { tag: 'Einstellungen', summary: 'Alle Ports neu vergeben (nur gestoppt)' },
  'POST /api/v1/servers/{id}/allocations': { tag: 'Einstellungen', summary: 'Zusaetzlichen Port anlegen, im Container als <REF>_PORT', body: extraPortBody },
  'PATCH /api/v1/servers/{id}/allocations/{port}': { tag: 'Einstellungen', summary: 'Portnummer, Protokoll oder Kennung eines Ports aendern', body: updatePortBody },
  'GET /api/v1/imports': { tag: 'Import', summary: 'Backups, die fuer einen neuen Server bereitliegen' },
  'POST /api/v1/imports/upload': { tag: 'Import', summary: 'Backup hochladen (multipart, Feld "file"), noch ohne Server' },
  'POST /api/v1/imports/analyze': { tag: 'Import', summary: 'Backup untersuchen: Spiel, Version, Einstellungen', body: analyzeBody },
  'DELETE /api/v1/imports/{file}': { tag: 'Import', summary: 'Eigenen Upload verwerfen' },
  'GET /api/v1/servers/{id}/import': { tag: 'Import', summary: 'Was der Import sucht und welche Archive im Import-Ordner liegen' },
  'POST /api/v1/servers/{id}/import': { tag: 'Import', summary: 'Archiv aus dem Import-Ordner uebernehmen (z. B. AMP-Backup)', body: importBody },
  'POST /api/v1/servers/{id}/import/upload': { tag: 'Import', summary: 'Archiv hochladen (multipart, Feld "file") und uebernehmen' },
  'DELETE /api/v1/servers/{id}/allocations/{port}': { tag: 'Einstellungen', summary: 'Zusaetzlichen Port entfernen' },
  'GET /api/v1/servers/{id}/events': { tag: 'Server', summary: 'Zeitachse: Status, Abstuerze, Installation', query: eventsQuery },
  'GET /api/v1/servers/{id}/activity': { tag: 'Server', summary: 'Wer hat was getan', query: eventsQuery },

  'GET /api/v1/servers/{id}/files': { tag: 'Dateien', summary: 'Ordnerinhalt auflisten' },
  'GET /api/v1/servers/{id}/files/content': { tag: 'Dateien', summary: 'Dateiinhalt als Text lesen' },
  'PUT /api/v1/servers/{id}/files/content': { tag: 'Dateien', summary: 'Dateiinhalt speichern' },
  'POST /api/v1/servers/{id}/files/directory': { tag: 'Dateien', summary: 'Neuen Ordner anlegen' },
  'POST /api/v1/servers/{id}/files/rename': { tag: 'Dateien', summary: 'Datei oder Ordner umbenennen / verschieben' },
  'DELETE /api/v1/servers/{id}/files': { tag: 'Dateien', summary: 'Datei oder Verzeichnis löschen' },
  'GET /api/v1/servers/{id}/files/download': { tag: 'Dateien', summary: 'Datei herunterladen' },
  'POST /api/v1/servers/{id}/files/upload': { tag: 'Dateien', summary: 'Datei in das Verzeichnis hochladen (multipart)' },
  'POST /api/v1/servers/{id}/files/compress': { tag: 'Dateien', summary: 'Dateien als Archiv komprimieren' },
  'POST /api/v1/servers/{id}/files/decompress': { tag: 'Dateien', summary: 'Archiv entpacken (.zip, .tar, .tar.zst)' },
  'GET /api/v1/servers/{id}/files/revisions': { tag: 'Dateien', summary: 'Versionshistorie / Revisionen einer Datei abfragen' },
  'GET /api/v1/servers/{id}/files/revisions/{revisionId}': { tag: 'Dateien', summary: 'Einzelne Dateirevision inkl. Inhalt abrufen' },
  'POST /api/v1/servers/{id}/files/revisions/{revisionId}/rollback': { tag: 'Dateien', summary: 'Dateirevision wiederherstellen (Rollback)' },

  'GET /api/v1/servers/{id}/backups': { tag: 'Backups', summary: 'Alle Backups eines Servers' },
  'POST /api/v1/servers/{id}/backups': { tag: 'Backups', summary: 'Neues Backup anlegen (tar.zst)' },
  'POST /api/v1/servers/{id}/backups/{backupId}/restore': { tag: 'Backups', summary: 'Backup wiederherstellen (Server muss gestoppt sein)' },
  'DELETE /api/v1/servers/{id}/backups/{backupId}': { tag: 'Backups', summary: 'Backup löschen' },
  'PATCH /api/v1/servers/{id}/backups/{backupId}': { tag: 'Backups', summary: 'Backup sperren oder entsperren' },
  'GET /api/v1/servers/{id}/backups/{backupId}/download': { tag: 'Backups', summary: 'Backup-Archiv herunterladen' },
  'POST /api/v1/servers/{id}/backups/{backupId}/verify': { tag: 'Backups', summary: 'Backup auf Integrität und Spieldaten prüfen' },
  'POST /api/v1/servers/{id}/backups/{backupId}/sync-nas': { tag: 'Backups', summary: 'Backup auf UGREEN NAS synchronisieren' },
  'GET /api/v1/servers/{id}/backup-schedule': { tag: 'Backups', summary: 'Auto-Backup-Zeitplan und Retention abrufen' },
  'PUT /api/v1/servers/{id}/backup-schedule': { tag: 'Backups', summary: 'Auto-Backup-Zeitplan und Retention aktualisieren' },

  'GET /api/v1/servers/{id}/schedules': { tag: 'Zeitpläne', summary: 'Zeitpläne eines Servers auflisten' },
  'POST /api/v1/servers/{id}/schedules': { tag: 'Zeitpläne', summary: 'Neuen Zeitplan anlegen (Neustart, Backup, Befehl)' },
  'PATCH /api/v1/servers/{id}/schedules/{scheduleId}': { tag: 'Zeitpläne', summary: 'Zeitplan aktualisieren oder umschalten' },
  'DELETE /api/v1/servers/{id}/schedules/{scheduleId}': { tag: 'Zeitpläne', summary: 'Zeitplan löschen' },
  'POST /api/v1/servers/{id}/schedules/{scheduleId}/run': { tag: 'Zeitpläne', summary: 'Zeitplan sofort ausführen' },

  'GET /api/v1/servers/{id}/storage-targets': { tag: 'Speicherziele', summary: 'Speicherziele eines Servers abfragen' },
  'POST /api/v1/servers/{id}/storage-targets': { tag: 'Speicherziele', summary: 'Neues Speicherziel anlegen' },
  'DELETE /api/v1/servers/{id}/storage-targets/{targetId}': { tag: 'Speicherziele', summary: 'Speicherziel entfernen' },
  'POST /api/v1/servers/{id}/storage-targets/{targetId}/test': { tag: 'Speicherziele', summary: 'Speicherziel Verbindungstest' },
  'GET /api/v1/admin/storage-targets': { tag: 'Admin', summary: 'Globale Panel-Speicherziele auflisten' },

  'GET /api/v1/servers/{id}/subusers': { tag: 'Mitnutzer', summary: 'Mitnutzer und ihre Rechte' },
  'GET /api/v1/servers/{id}/subusers/permissions': { tag: 'Mitnutzer', summary: 'Verfuegbare Rechte-Flags und Presets' },
  'POST /api/v1/servers/{id}/subusers': { tag: 'Mitnutzer', summary: 'Mitnutzer hinzufuegen (Preset oder Flags)', body: addBody },
  'PATCH /api/v1/servers/{id}/subusers/{userId}': { tag: 'Mitnutzer', summary: 'Rechte aendern', body: flagsInput },
  'DELETE /api/v1/servers/{id}/subusers/{userId}': { tag: 'Mitnutzer', summary: 'Entfernen oder selbst austreten' },

  'GET /api/v1/eggs': { tag: 'Spielekatalog', summary: 'Alle Eggs' },
  'GET /api/v1/eggs/{id}': { tag: 'Spielekatalog', summary: 'Ein Egg mit Formularbeschreibung der Variablen' },
  'GET /api/v1/eggs/branding': { tag: 'Spielekatalog', summary: 'Panel-Motive fuer Titelbilder' },
  'GET /api/v1/eggs/{id}/cover': { tag: 'Spielekatalog', summary: 'Titelbild (Steam oder eigenes Bild, ohne Anmeldung)' },
  'PUT /api/v1/admin/eggs/{id}/cover': { tag: 'Admin', summary: 'Titelbild waehlen oder eigenes hochladen' },
  'GET /api/v1/modpacks/search': { tag: 'Spielekatalog', summary: 'Modpacks suchen (CurseForge, Modrinth, FTB) mit Vorschlag fuers Minecraft-Egg' },
  'GET /api/v1/modpacks/curseforge': { tag: 'Spielekatalog', summary: 'Ist ein CurseForge-Schluessel hinterlegt?' },
  'PUT /api/v1/admin/modpacks/curseforge': { tag: 'Admin', summary: 'CurseForge-API-Schluessel setzen (wird geprueft und verschluesselt gespeichert)' },
  'DELETE /api/v1/admin/modpacks/curseforge': { tag: 'Admin', summary: 'CurseForge-API-Schluessel entfernen' },
  'GET /api/v1/servers/{id}/modpack': { tag: 'Server', summary: 'Installiertes Modpack, neueste Version, laufendes Update' },
  'POST /api/v1/servers/{id}/modpack/update': { tag: 'Server', summary: 'Modpack mit einem Klick aktualisieren (Backup vorher)' },
  'POST /api/v1/admin/eggs': { tag: 'Admin', summary: 'Egg einspielen (Body = Egg-JSON)' },
  'DELETE /api/v1/admin/eggs/{id}': { tag: 'Admin', summary: 'Egg loeschen (nur ungenutzt)' },
  'GET /api/v1/admin/files': { tag: 'Admin', summary: 'Admin-Dateimanager: verfuegbare Ordner auf der VM' },
  'GET /api/v1/admin/files/{root}': { tag: 'Admin', summary: 'Ordnerinhalt auflisten (?path=)' },
  'DELETE /api/v1/admin/files/{root}': { tag: 'Admin', summary: 'Datei oder Ordner loeschen' },
  'GET /api/v1/admin/files/{root}/usage': { tag: 'Admin', summary: 'Speicherbelegung der Unterordner (groesste zuerst)' },
  'GET /api/v1/admin/files/{root}/content': { tag: 'Admin', summary: 'Datei lesen' },
  'PUT /api/v1/admin/files/{root}/content': { tag: 'Admin', summary: 'Datei speichern' },
  'POST /api/v1/admin/files/{root}/directory': { tag: 'Admin', summary: 'Ordner anlegen' },
  'POST /api/v1/admin/files/{root}/rename': { tag: 'Admin', summary: 'Umbenennen oder verschieben' },
  'GET /api/v1/admin/files/{root}/download': { tag: 'Admin', summary: 'Datei herunterladen' },
  'POST /api/v1/admin/files/{root}/upload': { tag: 'Admin', summary: 'Datei hochladen (multipart, ?path=)' },
  'POST /api/v1/admin/files/{root}/compress': { tag: 'Admin', summary: 'Als Zip packen' },
  'POST /api/v1/admin/files/{root}/decompress': { tag: 'Admin', summary: 'Archiv entpacken' },
  'GET /api/v1/admin/users': { tag: 'Admin', summary: 'Alle Nutzer mit Verbrauch' },
  'POST /api/v1/admin/users': { tag: 'Admin', summary: 'Nutzer anlegen (ohne Passwort: wird erzeugt und einmal zurueckgegeben)', body: newUserBody },
  'PATCH /api/v1/admin/users/{id}': { tag: 'Admin', summary: 'Rolle, Rechte, Sperre, Budgets', body: patchUserBody },
  'POST /api/v1/admin/users/{id}/reset-2fa': { tag: 'Admin', summary: 'Zwei-Faktor eines Nutzers abschalten' },
  'DELETE /api/v1/admin/users/{id}': { tag: 'Admin', summary: 'Nutzer loeschen (nur ohne Server)' },
  'GET /api/v1/admin/users/{id}/servers': { tag: 'Admin', summary: 'Server und Berechtigungen eines Nutzers auflisten' },
  'PUT /api/v1/admin/users/{id}/servers/{serverId}': { tag: 'Admin', summary: 'Server-Zugriff oder Besitz fuer einen Nutzer verwalten' },
  'GET /api/v1/admin/nodes': { tag: 'Admin', summary: 'Hosts mit zugeteiltem RAM, oeffentlicher Adresse und Port-Bereich' },
  'PATCH /api/v1/admin/nodes/{id}': { tag: 'Admin', summary: 'Oeffentliche Adresse und Port-Bereich eines Hosts', body: patchNodeBody },
  'GET /api/v1/admin/allocations': { tag: 'Admin', summary: 'Alle vergebenen Ports (Netzwerk-Uebersicht)' },
  'GET /api/v1/admin/audit': { tag: 'Admin', summary: 'Globales Audit-Log', query: auditQuery },

  'GET /api/v1/steam/accounts': { tag: 'Steam', summary: 'Hinterlegte Steam-Konten mit Guard-Status' },
  'POST /api/v1/steam/accounts': { tag: 'Steam', summary: 'Steam-Konto anlegen oder aktualisieren', body: z.object({
    accountName: z.string().describe('Login-Name des Steam-Kontos'),
    password: z.string().optional().describe('Passwort (wird AES-256-GCM verschlüsselt)'),
    steamId: z.string().optional().describe('Optionale SteamID64'),
  }) },
  'POST /api/v1/steam/accounts/{id}/guard': { tag: 'Steam', summary: 'Steam-Guard-Code übermitteln', body: z.object({
    code: z.string().describe('Steam-Guard-Code (4-10 Zeichen)'),
  }) },
  'DELETE /api/v1/steam/accounts/{id}': { tag: 'Steam', summary: 'Steam-Konto entfernen' },
};

function toJson(schema: ZodTypeAny) {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
  return rest;
}

/** Fastify schreibt :id, OpenAPI {id}. */
function openApiPath(url: string) {
  return url.replace(/:([A-Za-z]+)/g, '{$1}');
}

export async function registerOpenApi(app: FastifyInstance, version: string) {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'NexusPanel API',
        version,
        description: 'Alle Endpunkte ausser den als oeffentlich markierten brauchen `Authorization: Bearer <accessToken>` aus /auth/login.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: ({ schema, url, route }) => {
      const method = (Array.isArray(route.method) ? route.method[0] : route.method) as string;
      const doc = DOCS[`${method} ${openApiPath(url)}`];
      const out: Record<string, unknown> = { ...(schema ?? {}) };
      // Ohne Doku-Eintrag: Doku-Seite selbst und ausgelieferte Dateien der Oberflaeche ausblenden.
      if (!doc) return { schema: { ...out, hide: !url.startsWith('/api/v1') }, url };
      out.tags = [doc.tag];
      out.summary = doc.summary;
      if (doc.description) out.description = doc.description;
      if (doc.body) out.body = toJson(doc.body);
      if (doc.query) out.querystring = toJson(doc.query);
      if (!doc.public) out.security = [{ bearer: [] }];
      return { schema: out as never, url };
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  });

  // Moderner Scalar API-Browser (wie in AMP 3) unter /docs
  app.get('/docs', async (_req, reply) => {
    reply.type('text/html').send(`<!doctype html>
<html>
  <head>
    <title>NexusPanel API Reference (Scalar)</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f59e0b' stroke-width='2'><polygon points='12 2 2 7 12 12 22 7 12 2'></polygon><polyline points='2 17 12 22 22 17'></polyline><polyline points='2 12 12 17 22 12'></polyline></svg>" />
    <style>body { margin: 0; background: #0c0e12; }</style>
  </head>
  <body>
    <script id="api-reference" data-url="/api/docs/json" data-configuration='{"theme":"kepler","darkMode":true,"layout":"modern"}'></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`);
  });
}

/** Welche Routen haben keine Doku? Fuer einen Test, damit neue Routen nicht vergessen werden. */
export function documentedRoutes(): string[] {
  return Object.keys(DOCS);
}

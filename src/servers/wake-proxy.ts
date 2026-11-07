import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { log } from '../log.js';
import { startServer } from './lifecycle.js';
import { writeEvent } from '../events.js';
import { writeAudit } from '../audit.js';
import { notifyServerStatus } from '../notifications/discord.js';

/**
 * Wake-on-Join Standby-Proxy:
 * Lauscht auf dem Port eines schlafenden Spieleservers (z. B. Minecraft 25565).
 * - Zeigt in der Serverliste an: "[Ruhemodus] Zum Aufwecken verbinden"
 * - Sobald ein Spieler verbindet: Sendet eine Aufwach-Meldung und startet
 *   den Server vollautomatisch im Hintergrund hoch!
 */

const activeProxies = new Map<string, { server: NetServer; port: number }>();

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf: Buffer, pos: number): [number, number] | null {
  let n = 0, shift = 0, i = pos;
  while (i < buf.length) {
    const b = buf[i++]!;
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n >>> 0, i];
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

const frame = (payload: Buffer) => Buffer.concat([varint(payload.length), payload]);

function stringPacket(id: number, str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  return frame(Buffer.concat([varint(id), varint(strBuf.length), strBuf]));
}

export function startWakeProxy(serverId: string, port: number, serverName: string): boolean {
  if (activeProxies.has(serverId)) {
    const existing = activeProxies.get(serverId)!;
    if (existing.port === port) return true;
    stopWakeProxy(serverId);
  }

  try {
    const srv = createServer((sock: Socket) => {
      let buf = Buffer.alloc(0);
      let state = 0; // 0 = vor Handshake, 1 = Status, 2 = Login

      const cleanup = () => {
        sock.destroy();
      };
      sock.setTimeout(10_000, cleanup);
      sock.on('error', () => cleanup());

      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);

        for (;;) {
          const len = readVarint(buf, 0);
          if (!len || buf.length < len[1] + len[0]) return;
          const pkt = buf.subarray(len[1], len[1] + len[0]);
          buf = buf.subarray(len[1] + len[0]);

          const pid = readVarint(pkt, 0);
          if (!pid) return;

          if (state === 0 && pid[0] === 0) {
            // Handshake
            const proto = readVarint(pkt, pid[1]);
            if (!proto) return;
            const addrLen = readVarint(pkt, proto[1]);
            if (!addrLen) return;
            const portPos = addrLen[1] + addrLen[0];
            if (pkt.length < portPos + 2) return;
            const nextState = readVarint(pkt, portPos + 2);
            if (!nextState) return;
            state = nextState[0];

            if (state === 2) {
              // Login Start -> Spieler will beitreten -> Server aufwecken!
              const msg = JSON.stringify({
                text: `§e§l[NexusPanel] §6Server wacht auf!\n\n§fDer Server "${serverName}" war im Ruhemodus und startet jetzt automatisch.\n§aBitte in ca. 30–60 Sekunden erneut verbinden!`,
              });
              try {
                sock.write(stringPacket(0, msg), () => {
                  sock.end();
                });
              } catch {}

              log.info({ serverId, serverName, port }, 'Wake-on-Join: Spieler-Verbindung erkannt! Wecke Server auf...');
              stopWakeProxy(serverId);

              void (async () => {
                await writeEvent({
                  serverId,
                  kind: 'server_wake_on_join',
                  summary: 'Server durch Spieler-Verbindung automatisch aus dem Ruhemodus aufgeweckt',
                });
                await writeAudit({
                  serverId,
                  action: 'server.wake_on_join',
                  actorName: 'system',
                  metadata: { port, serverName },
                });
                void notifyServerStatus('wake_on_join', serverName, 'Ein Spieler hat sich verbunden – Server wird automatisch gestartet!');
                await startServer(serverId, { actorId: null }).catch((err) => {
                  log.error({ err, serverId }, 'Fehler beim automatischen Aufwecken des Servers');
                });
              })();
              return;
            }
          } else if (state === 1) {
            // Status (Server List Ping)
            if (pid[0] === 0) {
              // Request -> Status Response
              const response = JSON.stringify({
                version: { name: '§6[Ruhemodus]', protocol: 767 },
                players: { max: 0, online: 0 },
                description: {
                  text: `§e§l[Ruhemodus] §f${serverName} schläft zur Ressourcenschonung\n§a» Zum automatischen Aufwecken einfach beitreten!`,
                },
              });
              sock.write(stringPacket(0, response));
            } else if (pid[0] === 1) {
              // Ping -> Pong
              const payload = pkt.subarray(pid[1]);
              sock.write(frame(Buffer.concat([varint(1), payload])));
              sock.end();
              return;
            }
          } else if (state === 2 && pid[0] === 0) {
            // Login Start
            const msg = JSON.stringify({
              text: `§e§l[NexusPanel] §6Server wacht auf!\n\n§fDer Server "${serverName}" startet jetzt automatisch.\n§aBitte in ca. 30–60 Sekunden erneut verbinden!`,
            });
            try {
              sock.write(stringPacket(0, msg), () => {
                sock.end();
              });
            } catch {}
            return;
          }
        }
      });
    });

    srv.on('error', (err) => {
      log.warn({ err, serverId, port }, 'Wake-Proxy konnte Port nicht binden (evtl. noch belegt)');
      activeProxies.delete(serverId);
    });

    srv.listen(port, '0.0.0.0', () => {
      log.info({ serverId, serverName, port }, 'Wake-Proxy aktiv (wartet auf Spieler zum automatischen Aufwecken)');
    });

    activeProxies.set(serverId, { server: srv, port });
    return true;
  } catch (err) {
    log.warn({ err, serverId, port }, 'Fehler beim Starten des Wake-Proxys');
    return false;
  }
}

export function stopWakeProxy(serverId: string): void {
  const entry = activeProxies.get(serverId);
  if (entry) {
    try {
      entry.server.close();
    } catch {}
    activeProxies.delete(serverId);
    log.info({ serverId, port: entry.port }, 'Wake-Proxy beendet');
  }
}

export function stopAllWakeProxies(): void {
  for (const [id, entry] of activeProxies.entries()) {
    try {
      entry.server.close();
    } catch {}
  }
  activeProxies.clear();
}

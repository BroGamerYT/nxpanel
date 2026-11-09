import { describe, it, expect } from 'vitest';
import { getGameSrvMeta } from '../src/network/dns.js';

describe('DNS & SRV Record Logik', () => {
  it('erkennt Minecraft für _minecraft._tcp SRV-Records', () => {
    expect(getGameSrvMeta('Paper Minecraft', 'minecraft')).toEqual({
      service: '_minecraft',
      proto: '_tcp',
      defaultPort: 25565,
    });
    expect(getGameSrvMeta('Minecraft Forge Server')).toEqual({
      service: '_minecraft',
      proto: '_tcp',
      defaultPort: 25565,
    });
    expect(getGameSrvMeta('Purpur')).toEqual({
      service: '_minecraft',
      proto: '_tcp',
      defaultPort: 25565,
    });
  });

  it('erkennt TeamSpeak 3 für _ts3._udp SRV-Records', () => {
    expect(getGameSrvMeta('TeamSpeak 3 Server')).toEqual({
      service: '_ts3',
      proto: '_udp',
      defaultPort: 9987,
    });
    expect(getGameSrvMeta('TS3')).toEqual({
      service: '_ts3',
      proto: '_udp',
      defaultPort: 9987,
    });
  });

  it('erkennt Terraria für _terraria._tcp SRV-Records', () => {
    expect(getGameSrvMeta('Terraria TShock')).toEqual({
      service: '_terraria',
      proto: '_tcp',
      defaultPort: 7777,
    });
  });

  it('liefert null für Spiele ohne SRV-Unterstützung (z. B. Rust, Palworld)', () => {
    expect(getGameSrvMeta('Rust Server')).toBeNull();
    expect(getGameSrvMeta('Palworld Dedicated Server')).toBeNull();
    expect(getGameSrvMeta('Sons of the Forest')).toBeNull();
  });
});

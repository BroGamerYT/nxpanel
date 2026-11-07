import { lookup } from 'node:dns/promises';

/**
 * Verbindungstest von der Panel-Maschine ins Internet - genau der Weg,
 * den auch die Spielcontainer nehmen (gleiche VM, gleiches NAT).
 *
 * Gedacht fuer Spiele, die sich bei einem Dienst anmelden muessen, allen
 * voran ARK: Survival Ascended bei Epic Online Services. Typische Ursachen,
 * warum ein Server nicht in der Liste auftaucht:
 *   - ausgehende Adresse ist eine andere als die, unter der Spieler verbinden
 *   - Uhr der VM geht falsch (Anmeldetoken werden abgelehnt)
 *   - DNS oder HTTPS nach draussen klappt nicht
 */
export interface CheckResult {
  key: 'dns' | 'https' | 'publicIp' | 'clock';
  ok: boolean | null;
  value: string | null;
  detail: string | null;
}

type Fetcher = typeof fetch;

async function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
}

export async function networkCheck(publicHost: string | null, f: Fetcher = fetch): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // 1. DNS fuer Epic
  try {
    const r = await timed(lookup('api.epicgames.dev'), 5000);
    out.push({ key: 'dns', ok: true, value: r.address, detail: 'api.epicgames.dev' });
  } catch (err) {
    out.push({ key: 'dns', ok: false, value: null, detail: err instanceof Error ? err.message : String(err) });
  }

  // 2. HTTPS zu Epic (Zertifikat, Firewall). Jede HTTP-Antwort zaehlt als erreichbar.
  try {
    const r = await timed(f('https://api.epicgames.dev/sdk/v1/default?platformId=WIN', { method: 'GET' }), 8000);
    out.push({ key: 'https', ok: true, value: `HTTP ${r.status}`, detail: 'api.epicgames.dev' });
  } catch (err) {
    out.push({ key: 'https', ok: false, value: null, detail: err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err) });
  }

  // 3. Mit welcher Adresse kommen wir draussen an? + 4. Uhrzeit ueber den Date-Header
  try {
    const before = Date.now();
    const r = await timed(f('https://api.ipify.org?format=json'), 8000);
    const after = Date.now();
    const ip = ((await r.json()) as { ip?: string }).ip ?? null;
    const isIp = !!publicHost && /^\d+\.\d+\.\d+\.\d+$/.test(publicHost);
    out.push({
      key: 'publicIp', value: ip,
      ok: ip && isIp ? ip === publicHost : null,
      detail: isIp ? publicHost : null,
    });
    const date = r.headers.get('date');
    if (date) {
      // Date hat Sekundengenauigkeit - Abweichungen unter 5 s sind Rauschen.
      const skew = Math.round((Date.parse(date) - (before + after) / 2) / 1000);
      out.push({ key: 'clock', ok: Math.abs(skew) <= 30, value: String(skew), detail: date });
    } else {
      out.push({ key: 'clock', ok: null, value: null, detail: null });
    }
  } catch (err) {
    out.push({ key: 'publicIp', ok: false, value: null, detail: err instanceof Error ? err.message : String(err) });
    out.push({ key: 'clock', ok: null, value: null, detail: null });
  }
  return out;
}

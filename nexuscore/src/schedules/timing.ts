/**
 * Zeitberechnung fuer Zeitplaene.
 *
 * Erlaubt sind ein Intervall in Minuten, eine Uhrzeit "HH:MM" (taeglich) oder
 * ein Cron-Ausdruck mit fuenf Feldern ("Minute Stunde Tag Monat Wochentag").
 * Das Original kannte nur die ersten beiden und las Unsinn still als
 * "in 24 Stunden" - hier wird er abgelehnt, damit ein Zeitplan nie zu einer
 * unerwarteten Zeit laeuft. Gerechnet wird in der Ortszeit des Rechners.
 */

export class ScheduleError extends Error {
  readonly statusCode = 400;
  readonly code = 'schedule_error';
}

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const FIELD_NAMES = ['Minute', 'Stunde', 'Tag', 'Monat', 'Wochentag'];

function parseField(text: string, index: number): Set<number> {
  const [min, max] = RANGES[index]!;
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new ScheduleError(`Ungültiges Feld "${text}" (${FIELD_NAMES[index]})`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new ScheduleError(`Ungültige Schrittweite in "${text}" (${FIELD_NAMES[index]})`);
    let from: number;
    let to: number;
    if (m[1] === '*') {
      from = min;
      to = max;
    } else if (m[1]!.includes('-')) {
      [from, to] = m[1]!.split('-').map(Number) as [number, number];
    } else {
      from = Number(m[1]);
      // "5/10" heisst: ab 5 in Zehnerschritten bis zum Ende
      to = m[2] === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new ScheduleError(`${FIELD_NAMES[index]} muss zwischen ${min} und ${max} liegen ("${text}")`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleError('Ein Cron-Ausdruck braucht fünf Felder: Minute Stunde Tag Monat Wochentag (oder eine Uhrzeit HH:MM)');
  }
  const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, i)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  // Sonntag darf 0 oder 7 sein
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    daysRestricted: fields[2] !== '*',
    weekdaysRestricted: fields[4] !== '*',
  };
}

/** Passt dieser Zeitpunkt auf den Ausdruck? Sind Tag UND Wochentag eingeschraenkt, genuegt einer (wie Vixie-Cron). */
function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minutes.has(d.getMinutes()) || !spec.hours.has(d.getHours()) || !spec.months.has(d.getMonth() + 1)) return false;
  const dayOk = spec.days.has(d.getDate());
  const weekdayOk = spec.weekdays.has(d.getDay());
  if (spec.daysRestricted && spec.weekdaysRestricted) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** Prueft eine Zeitangabe. Wirft ScheduleError mit lesbarer Meldung. */
export function validateTiming(cron: string | null | undefined, intervalMinutes: number | null | undefined): void {
  const hasCron = typeof cron === 'string' && cron.trim() !== '';
  const hasInterval = typeof intervalMinutes === 'number' && intervalMinutes > 0;
  if (hasCron === hasInterval) {
    throw new ScheduleError(hasCron ? 'Entweder eine Uhrzeit oder ein Intervall angeben, nicht beides' : 'Eine Uhrzeit oder ein Intervall ist nötig');
  }
  if (!hasCron) return;

  const t = cron!.trim();
  const hm = HHMM.exec(t);
  if (hm) {
    if (Number(hm[1]) > 23 || Number(hm[2]) > 59) throw new ScheduleError(`Ungültige Uhrzeit "${t}" (erwartet HH:MM von 00:00 bis 23:59)`);
    return;
  }
  parseCron(t);
}

/**
 * Der naechste Zeitpunkt nach `from`.
 *
 * @throws ScheduleError bei ungueltiger Angabe oder einem Ausdruck, der nie eintrifft (z. B. 30. Februar)
 */
export function nextRun(cron: string | null | undefined, intervalMinutes: number | null | undefined, from: Date = new Date()): Date {
  validateTiming(cron, intervalMinutes);
  if (typeof intervalMinutes === 'number' && intervalMinutes > 0) {
    return new Date(from.getTime() + intervalMinutes * 60_000);
  }

  const t = cron!.trim();
  const hm = HHMM.exec(t);
  if (hm) {
    const next = new Date(from);
    next.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  const spec = parseCron(t);
  const probe = new Date(from);
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  // Hoechstens vier Jahre voraus: genug fuer den 29. Februar, danach gilt der Ausdruck als unerfuellbar.
  const limit = from.getTime() + 4 * 366 * 24 * 3600_000;
  while (probe.getTime() <= limit) {
    if (!spec.months.has(probe.getMonth() + 1)) {
      // Ganzen Monat ueberspringen
      probe.setMonth(probe.getMonth() + 1, 1);
      probe.setHours(0, 0, 0, 0);
      continue;
    }
    if (matches(spec, probe)) return new Date(probe);
    // Passt die Stunde nicht, gleich zur naechsten Stunde springen
    if (!spec.hours.has(probe.getHours())) {
      probe.setHours(probe.getHours() + 1, 0, 0, 0);
    } else {
      probe.setMinutes(probe.getMinutes() + 1);
    }
  }
  throw new ScheduleError(`Der Ausdruck "${t}" trifft nie ein`);
}

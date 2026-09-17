// ============================================================================
// M15c: CRON PARSER — 5 field standar Unix, ditulis sendiri (zero dependency)
//
// ┌───────────── minute      (0-59)
// │ ┌───────────── hour       (0-23)
// │ │ ┌───────────── day of month (1-31)
// │ │ │ ┌───────────── month    (1-12)
// │ │ │ │ ┌───────────── day of week (0-6, Minggu=0)
// │ │ │ │ │
// * * * * *
//
// Field syntax yang didukung:
//   *         semua nilai
//   5         tepat satu nilai
//   1-5       range
//   *\/15     step (dari awal field)
//   1-5/2     range dengan step
//   1,3,5     list
//   1-3,5     campuran (range + list)
// ============================================================================

export interface CronFields {
  minutes: Set<number>; // 0-59
  hours: Set<number>; // 0-23
  daysOfMonth: Set<number>; // 1-31
  months: Set<number>; // 1-12
  daysOfWeek: Set<number>; // 0-6
}

const RANGES: { min: number; max: number; name: string }[] = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day-of-month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 6, name: 'day-of-week' },
];

// Parse SATU field menjadi set nilai
function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    // step: X/N atau */N
    let rangePart = part;
    let step = 1;
    const stepMatch = part.match(/^([^/]+)\/(\d+)$/);
    if (stepMatch) {
      rangePart = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (step < 1) throw new Error(`${name}: step must be >= 1 ('${part}')`);
    }

    // range atau nilai tunggal atau *
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) {
        throw new Error(`${name}: invalid part '${rangePart}' (examples: *, 5, 1-5)`);
      }
      start = parseInt(rangeMatch[1], 10);
      end = rangeMatch[2] !== undefined ? parseInt(rangeMatch[2], 10) : start;
      if (start < min || start > max || end < min || end > max) {
        throw new Error(`${name}: nilai ${start}-${end} di luar rentang ${min}-${max}`);
      }
      if (end < start) throw new Error(`${name}: range terbalik ${start}-${end}`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  if (values.size === 0) {
    throw new Error(`${name}: no valid values`);
  }
  return values;
}

// Parse expression penuh → fields. Lempar Error dengan pesan jelas kalau invalid.
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron must have 5 fields (minute hour dom month dow), got ${parts.length}: '${expr}'`);
  }

  return {
    minutes: parseField(parts[0], RANGES[0].min, RANGES[0].max, RANGES[0].name),
    hours: parseField(parts[1], RANGES[1].min, RANGES[1].max, RANGES[1].name),
    daysOfMonth: parseField(parts[2], RANGES[2].min, RANGES[2].max, RANGES[2].name),
    months: parseField(parts[3], RANGES[3].min, RANGES[3].max, RANGES[3].name),
    daysOfWeek: parseField(parts[4], RANGES[4].min, RANGES[4].max, RANGES[4].name),
  };
}

// Apakah timestamp cocok dengan cron? (menit-precision, waktu lokal server)
export function cronMatches(expr: string, date: Date): boolean {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return false; // expression invalid → tidak pernah cocok (fail-safe)
  }

  return (
    fields.minutes.has(date.getMinutes()) &&
    fields.hours.has(date.getHours()) &&
    fields.daysOfMonth.has(date.getDate()) &&
    fields.months.has(date.getMonth() + 1) &&
    fields.daysOfWeek.has(date.getDay())
  );
}

// ─── M39: TIMEZONE SUPPORT ─────────────────────────────────────────────────────
// Konversi UTC timestamp ke waktu lokal zona IANA (e.g. "Asia/Jakarta"),
// lalu evaluasi cron terhadap waktu lokal tsb.
//
// Implementasi: Intl.DateTimeFormat dengan timeZone option — ini CARA BENAR
// (bukan hard-coded offset) karena menangani DST (daylight saving time).
//
// Kenapa bukan offset hard-coded? Karena "America/New_York" = UTC-5 di winter
// tapi UTC-4 di summer (DST). Intl.DateTimeFormat handle ini otomatis.

const VALID_TZ_RE = /^[A-Za-z_\/+-]+(\/[A-Za-z_+-]+)*$/;

/**
 * Validasi nama timezone IANA. Lempar Error kalau invalid.
 * Format: "Asia/Jakarta", "America/New_York", "UTC", "Etc/UTC"
 */
export function validateTimezone(tz: string): void {
  if (!VALID_TZ_RE.test(tz)) {
    throw new Error(`Invalid timezone format: '${tz}' (expected IANA name like "Asia/Jakarta")`);
  }
  try {
    // Test apakah Intl menerima timezone ini
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: '${tz}' (not an IANA timezone name)`);
  }
}

/**
 * Ambil komponen waktu lokal dalam timezone IANA tertentu.
 * Return: { minute, hour, dayOfMonth, month, dayOfWeek } — untuk evaluasi cron.
 */
function getTimezoneFields(date: Date, timeZone: string): {
  minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  // Parse parts dari formatter
  const parts = fmt.formatToParts(date);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return parseInt(part?.value ?? '0', 10);
  };

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekdayPart = parts.find((p) => p.type === 'weekday');
  const dayOfWeek = weekdayMap[weekdayPart?.value ?? ''] ?? 0;

  return {
    minute: get('minute'),
    hour: get('hour'),
    dayOfMonth: get('day'),
    month: get('month'),
    dayOfWeek,
  };
}

/**
 * M39: Apakah timestamp cocok dengan cron dalam timezone tertentu?
 *
 * @param expr Cron expression 5-field
 * @param date UTC timestamp
 * @param timeZone IANA timezone name (default: UTC)
 */
export function cronMatchesInTimezone(
  expr: string,
  date: Date,
  timeZone: string = 'UTC'
): boolean {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return false; // fail-safe
  }

  const tz = getTimezoneFields(date, timeZone);

  return (
    fields.minutes.has(tz.minute) &&
    fields.hours.has(tz.hour) &&
    fields.daysOfMonth.has(tz.dayOfMonth) &&
    fields.months.has(tz.month) &&
    fields.daysOfWeek.has(tz.dayOfWeek)
  );
}

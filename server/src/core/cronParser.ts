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
      if (step < 1) throw new Error(`${name}: step harus >= 1 ('${part}')`);
    }

    // range atau nilai tunggal atau *
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) {
        throw new Error(`${name}: bagian '${rangePart}' tidak valid (contoh: *, 5, 1-5)`);
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
    throw new Error(`${name}: tidak ada nilai valid`);
  }
  return values;
}

// Parse expression penuh → fields. Lempar Error dengan pesan jelas kalau invalid.
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron harus 5 field (minute hour dom month dow), dapat ${parts.length}: '${expr}'`);
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

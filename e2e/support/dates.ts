/** The seeded hours are written in this fixed-offset zone (no DST), which is also the browser timezone. */
export const E2E_TIMEZONE = "America/Bogota";
export const E2E_UTC_OFFSET = "-05:00";

/** `YYYY-MM-DD` of an instant in the e2e timezone. */
export function dateInZone(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: E2E_TIMEZONE }).format(instant);
}

export function today(): string {
  return dateInZone(new Date());
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Monday of the week (Monday first) that contains `date`. */
export function mondayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** ISO instant for a wall-clock time (`HH:MM`) of a date in the e2e timezone. */
export function instant(date: string, time: string): string {
  return `${date}T${time}:00${E2E_UTC_OFFSET}`;
}

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

/** Whole days from `from` to `to` (`YYYY-MM-DD` both; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const utc = (date: string) => {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * The seed anchors appointments on yesterday, today, tomorrow and the Monday and Sunday of the current week, so
 * nothing is seeded after today + 6 (today is a Monday and the Sunday is 6 days ahead). Specs that book later days
 * use today + 40 and up. Today + 8 is therefore empty whatever weekday the suite runs on.
 */
export const EMPTY_DAY_OFFSET = 8;

/** The day-view range label the app shows for a date, e.g. `viernes, 20 de noviembre de 2026`. */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

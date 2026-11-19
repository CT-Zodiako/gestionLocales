/**
 * Calendar helpers in the browser's timezone. Dates are plain `YYYY-MM-DD` keys of the local calendar;
 * every day is built from local fields (`new Date(y, m, d)`), so DST changes never skip or repeat a day.
 */

export type AgendaView = "day" | "week";

const pad = (value: number) => String(value).padStart(2, "0");

export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight at the start of a date key. */
export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

/** `HH:MM` (24 h) of an instant in the browser timezone, the value format of `<input type="time">`. */
export function toTimeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function todayKey(): string {
  return toDateKey(new Date());
}

export function addDays(key: string, days: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** Monday of the week (Monday first) that contains the date. */
export function startOfWeek(key: string): string {
  const weekday = parseDateKey(key).getDay(); // 0 = Sunday
  return addDays(key, -((weekday + 6) % 7));
}

export type VisibleRange = {
  /** Local midnights; the API window is the half-open `[from, to)`. */
  from: Date;
  to: Date;
  /** The date keys shown, one column each. */
  days: string[];
};

export function visibleRange(view: AgendaView, selectedDate: string): VisibleRange {
  const first = view === "week" ? startOfWeek(selectedDate) : selectedDate;
  const count = view === "week" ? 7 : 1;
  return {
    from: parseDateKey(first),
    to: parseDateKey(addDays(first, count)),
    days: Array.from({ length: count }, (_, index) => addDays(first, index)),
  };
}

/** Minutes after local midnight of `dayKey` for an instant, clamped to the day (0 to 1440). */
export function minutesInDay(instant: Date, dayKey: string): number {
  const dayStart = parseDateKey(dayKey);
  const dayEnd = parseDateKey(addDays(dayKey, 1));
  if (instant <= dayStart) return 0;
  if (instant >= dayEnd) return 24 * 60;
  return instant.getHours() * 60 + instant.getMinutes();
}

const timeFormat = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** `HH:MM` in the browser timezone. */
export function formatTime(instant: Date): string {
  return timeFormat.format(instant);
}

const dayLabelFormat = new Intl.DateTimeFormat("es", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const rangeLabelFormat = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const weekdayShortFormat = new Intl.DateTimeFormat("es", { weekday: "short" });

export function formatDayLabel(key: string): string {
  return dayLabelFormat.format(parseDateKey(key));
}

/** "martes, 18 de noviembre de 2026" or "16–22 de noviembre de 2026". */
export function formatRangeLabel(view: AgendaView, selectedDate: string): string {
  if (view === "day") return formatDayLabel(selectedDate);
  const { days } = visibleRange("week", selectedDate);
  return rangeLabelFormat.formatRange(parseDateKey(days[0] as string), parseDateKey(days[6] as string));
}

export function formatWeekdayShort(key: string): string {
  return weekdayShortFormat.format(parseDateKey(key));
}

export function dayOfMonth(key: string): number {
  return parseDateKey(key).getDate();
}

/**
 * Free appointment slots, computed in the business timezone with `Intl.DateTimeFormat` only.
 *
 * Everything here is pure: the caller passes the opening hours, the booked spans and the clock. A "date" is
 * a calendar day `YYYY-MM-DD` in the business timezone; an "instant" is a `Date`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface OpeningRangeInput {
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** `HH:MM` or `HH:MM:SS`, wall-clock time in the business timezone. */
  opensAt: string;
  closesAt: string;
}

/** A booked appointment (cancelled ones are the caller's to leave out). */
export interface BookedSpan {
  startsAt: Date;
  endsAt: Date;
}

export interface DaySlot {
  startsAt: Date;
  endsAt: Date;
  /** False when a booked appointment overlaps it. */
  free: boolean;
}

export interface FreeSlotsInput {
  /** IANA timezone of the business, e.g. `America/Bogota`. */
  timezone: string;
  /** Calendar day in that timezone. */
  date: string;
  durationMinutes: number;
  openingHours: OpeningRangeInput[];
  booked: BookedSpan[];
  /** Slots starting at or before this instant are in the past and are left out. */
  now: Date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallParts(timezone: string, ms: number): WallParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Offset of the timezone from UTC at an instant, in milliseconds (wall clock minus UTC). */
function offsetAt(timezone: string, ms: number): number {
  const wall = wallParts(timezone, ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function splitDate(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year ?? 0, month ?? 1, day ?? 1];
}

/** `YYYY-MM-DD` that is a real calendar day. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return addDays(value, 0) === value;
}

/** Calendar arithmetic on a `YYYY-MM-DD` day; no timezone or DST involved. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = splitDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, for a calendar day. */
export function weekdayOf(date: string): number {
  const [year, month, day] = splitDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The calendar day an instant falls on in the timezone. */
export function localDateOf(timezone: string, instant: Date): string {
  const wall = wallParts(timezone, instant.getTime());
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Wall-clock `HH:MM` of an instant in the timezone. */
export function formatLocalTime(timezone: string, instant: Date): string {
  const wall = wallParts(timezone, instant.getTime());
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/**
 * The instant at which the timezone's wall clock shows `date` `time` (`HH:MM` or `HH:MM:SS`).
 * A wall time that does not exist (spring-forward gap) moves forward past the gap; one that happens twice
 * (fall-back overlap) resolves to its first occurrence.
 */
export function zonedWallTimeToInstant(timezone: string, date: string, time: string): Date {
  const [year, month, day] = splitDate(date);
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);

  const before = offsetAt(timezone, wall - DAY_MS);
  const after = offsetAt(timezone, wall + DAY_MS);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => offsetAt(timezone, instant) === wall - instant);

  // No candidate means the wall time falls in a gap: use the offset in force before it.
  return new Date(candidates.length > 0 ? Math.min(...candidates) : wall - before);
}

/** The half-open interval `[start, end)` of a calendar day; 23 or 25 hours long on DST days. */
export function dayBounds(timezone: string, date: string): { start: Date; end: Date } {
  return {
    start: zonedWallTimeToInstant(timezone, date, "00:00"),
    end: zonedWallTimeToInstant(timezone, addDays(date, 1), "00:00"),
  };
}

/**
 * Candidate slots of a day, each marked free or taken: every opening range of that weekday is stepped
 * through by the service duration in elapsed time (so DST days are as long as they really are), a slot
 * must end by closing time, and slots starting at or before `now` are dropped. Sorted, without duplicates.
 */
export function computeDaySlots(input: FreeSlotsInput): DaySlot[] {
  if (!(input.durationMinutes > 0)) return [];

  const weekday = weekdayOf(input.date);
  const durationMs = input.durationMinutes * MINUTE_MS;
  const starts = new Set<number>();

  for (const range of input.openingHours) {
    if (range.weekday !== weekday) continue;

    const opens = zonedWallTimeToInstant(input.timezone, input.date, range.opensAt).getTime();
    const closes = zonedWallTimeToInstant(input.timezone, input.date, range.closesAt).getTime();
    for (let start = opens; start + durationMs <= closes; start += durationMs) starts.add(start);
  }

  return [...starts]
    .filter((start) => start > input.now.getTime())
    .sort((a, b) => a - b)
    .map((start) => {
      const end = start + durationMs;
      const taken = input.booked.some((span) => start < span.endsAt.getTime() && end > span.startsAt.getTime());
      return { startsAt: new Date(start), endsAt: new Date(end), free: !taken };
    });
}

/** Start instants of the free slots of a day (see `computeDaySlots`). */
export function computeFreeSlots(input: FreeSlotsInput): Date[] {
  return computeDaySlots(input)
    .filter((slot) => slot.free)
    .map((slot) => slot.startsAt);
}

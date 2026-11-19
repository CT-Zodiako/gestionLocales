import { describe, expect, it } from "vitest";
import {
  addDays,
  computeDaySlots,
  computeFreeSlots,
  dayBounds,
  localDateOf,
  weekdayOf,
  zonedWallTimeToInstant,
  type FreeSlotsInput,
} from "../src/whatsapp/availability.ts";

const BOGOTA = "America/Bogota";
const NEW_YORK = "America/New_York";
const MINUTE = 60_000;

function iso(dates: Date[]): string[] {
  return dates.map((date) => date.toISOString());
}

function input(overrides: Partial<FreeSlotsInput>): FreeSlotsInput {
  return {
    timezone: BOGOTA,
    date: "2031-03-10", // a Monday
    durationMinutes: 60,
    openingHours: [{ weekday: 1, opensAt: "09:00", closesAt: "12:00" }],
    booked: [],
    now: new Date("2031-03-09T00:00:00Z"),
    ...overrides,
  };
}

describe("calendar helpers", () => {
  it("computes the weekday and adds days on the calendar, across month and year ends", () => {
    expect(weekdayOf("2031-03-10")).toBe(1);
    expect(weekdayOf("2031-03-09")).toBe(0);
    expect(weekdayOf("2031-03-15")).toBe(6);
    expect(addDays("2031-03-10", 6)).toBe("2031-03-16");
    expect(addDays("2031-12-30", 3)).toBe("2032-01-02");
    expect(addDays("2032-02-28", 1)).toBe("2032-02-29");
    expect(addDays("2031-03-01", -1)).toBe("2031-02-28");
  });

  it("reads the local date of an instant in the business timezone", () => {
    // 03:30Z is still the previous evening in Bogotá (UTC-5), already the next day in Auckland.
    expect(localDateOf(BOGOTA, new Date("2031-03-10T03:30:00Z"))).toBe("2031-03-09");
    expect(localDateOf("Pacific/Auckland", new Date("2031-03-10T03:30:00Z"))).toBe("2031-03-10");
    expect(localDateOf(BOGOTA, new Date("2031-03-10T05:00:00Z"))).toBe("2031-03-10");
  });
});

describe("zonedWallTimeToInstant", () => {
  it("converts a wall time with a fixed offset", () => {
    expect(zonedWallTimeToInstant(BOGOTA, "2031-03-10", "09:00").toISOString()).toBe("2031-03-10T14:00:00.000Z");
    expect(zonedWallTimeToInstant(BOGOTA, "2031-03-10", "09:00:00").toISOString()).toBe("2031-03-10T14:00:00.000Z");
  });

  it("uses the offset in force on that day (EST before the spring change, EDT after it)", () => {
    expect(zonedWallTimeToInstant(NEW_YORK, "2031-03-08", "09:00").toISOString()).toBe("2031-03-08T14:00:00.000Z");
    expect(zonedWallTimeToInstant(NEW_YORK, "2031-03-10", "09:00").toISOString()).toBe("2031-03-10T13:00:00.000Z");
  });

  it("moves a wall time that does not exist (spring-forward gap) to the first instant after the gap", () => {
    // 2031-03-09 02:30 does not exist in New York: clocks jump from 02:00 EST to 03:00 EDT.
    expect(zonedWallTimeToInstant(NEW_YORK, "2031-03-09", "02:30").toISOString()).toBe("2031-03-09T07:30:00.000Z");
  });

  it("takes the first occurrence of a wall time that happens twice (fall-back overlap)", () => {
    // 2031-11-02 01:30 happens as EDT (05:30Z) and again as EST (06:30Z).
    expect(zonedWallTimeToInstant(NEW_YORK, "2031-11-02", "01:30").toISOString()).toBe("2031-11-02T05:30:00.000Z");
  });

  it("bounds a local day by its midnights, which are 23 or 25 hours apart on DST days", () => {
    const normal = dayBounds(NEW_YORK, "2031-03-10");
    const spring = dayBounds(NEW_YORK, "2031-03-09");
    const fall = dayBounds(NEW_YORK, "2031-11-02");

    expect((normal.end.getTime() - normal.start.getTime()) / (60 * MINUTE)).toBe(24);
    expect((spring.end.getTime() - spring.start.getTime()) / (60 * MINUTE)).toBe(23);
    expect((fall.end.getTime() - fall.start.getTime()) / (60 * MINUTE)).toBe(25);
    expect(spring.start.toISOString()).toBe("2031-03-09T05:00:00.000Z");
  });
});

describe("computeFreeSlots", () => {
  it("steps through the opening range by the service duration", () => {
    expect(iso(computeFreeSlots(input({ durationMinutes: 60 })))).toEqual([
      "2031-03-10T14:00:00.000Z",
      "2031-03-10T15:00:00.000Z",
      "2031-03-10T16:00:00.000Z",
    ]);
    expect(computeFreeSlots(input({ durationMinutes: 45 }))).toHaveLength(4); // 09:00 09:45 10:30 11:15 (ends 12:00)
  });

  it("never offers a slot that would end after closing time", () => {
    const slots = computeFreeSlots(input({ durationMinutes: 50 })); // 09:00 09:50 10:40 (ends 11:30); 11:30 would end 12:20
    expect(iso(slots)).toEqual(["2031-03-10T14:00:00.000Z", "2031-03-10T14:50:00.000Z", "2031-03-10T15:40:00.000Z"]);
  });

  it("returns nothing for a weekday without opening hours or a service longer than the range", () => {
    expect(computeFreeSlots(input({ date: "2031-03-11" }))).toEqual([]);
    expect(computeFreeSlots(input({ durationMinutes: 240 }))).toEqual([]);
    expect(computeFreeSlots(input({ openingHours: [] }))).toEqual([]);
  });

  it("supports several ranges per weekday, sorted and without duplicates when ranges overlap", () => {
    const slots = computeFreeSlots(
      input({
        openingHours: [
          { weekday: 1, opensAt: "14:00:00", closesAt: "15:00:00" },
          { weekday: 1, opensAt: "09:00:00", closesAt: "10:00:00" },
          { weekday: 1, opensAt: "09:30", closesAt: "10:00" },
          { weekday: 2, opensAt: "09:00", closesAt: "18:00" },
        ],
        durationMinutes: 30,
      }),
    );
    expect(iso(slots)).toEqual([
      "2031-03-10T14:00:00.000Z",
      "2031-03-10T14:30:00.000Z",
      "2031-03-10T19:00:00.000Z",
      "2031-03-10T19:30:00.000Z",
    ]);
  });

  it("excludes slots overlapping a booked appointment but allows back-to-back ones", () => {
    const booked = [{ startsAt: new Date("2031-03-10T14:30:00Z"), endsAt: new Date("2031-03-10T15:30:00Z") }];

    const slots = computeFreeSlots(input({ durationMinutes: 30, booked }));

    // 14:00-14:30 ends exactly when the booking starts (fine); 14:30 and 15:00 overlap; 15:30 starts when it ends.
    expect(iso(slots)).toEqual([
      "2031-03-10T14:00:00.000Z",
      "2031-03-10T15:30:00.000Z",
      "2031-03-10T16:00:00.000Z",
      "2031-03-10T16:30:00.000Z",
    ]);
  });

  it("excludes the past: slots starting at or before now", () => {
    const now = new Date("2031-03-10T15:00:00Z"); // 10:00 in Bogotá
    expect(iso(computeFreeSlots(input({ now })))).toEqual(["2031-03-10T16:00:00.000Z"]);
    expect(computeFreeSlots(input({ now: new Date("2031-03-10T16:30:00Z") }))).toEqual([]);
  });

  it("reports taken slots as not free in the day view, but leaves past slots out entirely", () => {
    const booked = [{ startsAt: new Date("2031-03-10T15:00:00Z"), endsAt: new Date("2031-03-10T16:00:00Z") }];
    const now = new Date("2031-03-10T14:00:00Z");

    const day = computeDaySlots(input({ booked, now }));

    expect(day.map((slot) => [slot.startsAt.toISOString(), slot.free])).toEqual([
      ["2031-03-10T15:00:00.000Z", false],
      ["2031-03-10T16:00:00.000Z", true],
    ]);
  });

  it("uses the business timezone to decide which weekday an opening range belongs to", () => {
    // The same instant range is Monday in Bogotá; Auckland (UTC+13 in March) is already on Tuesday.
    const bogota = computeFreeSlots(input({ date: "2031-03-10", openingHours: [{ weekday: 1, opensAt: "09:00", closesAt: "10:00" }] }));
    const auckland = computeFreeSlots(
      input({ timezone: "Pacific/Auckland", date: "2031-03-10", openingHours: [{ weekday: 1, opensAt: "09:00", closesAt: "10:00" }] }),
    );
    expect(iso(bogota)).toEqual(["2031-03-10T14:00:00.000Z"]);
    expect(iso(auckland)).toEqual(["2031-03-09T20:00:00.000Z"]);
  });

  describe("on daylight-saving days", () => {
    it("spring forward: the day is 23 hours long, there is no 02:00 hour and slots follow real elapsed time", () => {
      // Sunday 2031-03-09 in New York: 00:00-06:00 wall time is only 5 real hours.
      const slots = computeFreeSlots(
        input({
          timezone: NEW_YORK,
          date: "2031-03-09",
          openingHours: [{ weekday: 0, opensAt: "00:00", closesAt: "06:00" }],
          now: new Date("2031-03-08T12:00:00Z"),
        }),
      );

      expect(iso(slots)).toEqual([
        "2031-03-09T05:00:00.000Z", // 00:00 EST
        "2031-03-09T06:00:00.000Z", // 01:00 EST
        "2031-03-09T07:00:00.000Z", // 03:00 EDT (02:00 does not exist)
        "2031-03-09T08:00:00.000Z", // 04:00 EDT
        "2031-03-09T09:00:00.000Z", // 05:00 EDT
      ]);
    });

    it("fall back: the repeated hour yields two slots and the range is 7 real hours long", () => {
      const slots = computeFreeSlots(
        input({
          timezone: NEW_YORK,
          date: "2031-11-02",
          openingHours: [{ weekday: 0, opensAt: "00:00", closesAt: "06:00" }],
          now: new Date("2031-11-01T12:00:00Z"),
        }),
      );

      expect(iso(slots)).toEqual([
        "2031-11-02T04:00:00.000Z", // 00:00 EDT
        "2031-11-02T05:00:00.000Z", // 01:00 EDT
        "2031-11-02T06:00:00.000Z", // 01:00 EST
        "2031-11-02T07:00:00.000Z", // 02:00 EST
        "2031-11-02T08:00:00.000Z",
        "2031-11-02T09:00:00.000Z",
        "2031-11-02T10:00:00.000Z", // 05:00 EST, ends at 06:00 EST = 11:00Z
      ]);
    });

    it("keeps 09:00 wall-clock slots on both sides of the change", () => {
      const before = computeFreeSlots(
        input({ timezone: NEW_YORK, date: "2031-03-08", openingHours: [{ weekday: 6, opensAt: "09:00", closesAt: "10:00" }], now: new Date("2031-03-01T00:00:00Z") }),
      );
      const after = computeFreeSlots(
        input({ timezone: NEW_YORK, date: "2031-03-10", openingHours: [{ weekday: 1, opensAt: "09:00", closesAt: "10:00" }], now: new Date("2031-03-01T00:00:00Z") }),
      );
      expect(iso(before)).toEqual(["2031-03-08T14:00:00.000Z"]);
      expect(iso(after)).toEqual(["2031-03-10T13:00:00.000Z"]);
    });
  });
});

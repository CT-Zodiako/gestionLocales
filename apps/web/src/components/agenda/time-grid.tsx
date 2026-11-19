import type { AppointmentDetailResponse } from "@gestion/shared";
import { cn } from "@/lib/utils.ts";
import { dayOfMonth, formatDayLabel, formatWeekdayShort, todayKey } from "@/lib/agenda-dates.ts";
import { rememberOpener } from "@/lib/focus-return.ts";
import { useAgendaStore } from "@/stores/agenda-store.ts";
import { AppointmentBlock, HOUR_PX } from "./appointment-block.tsx";
import { gridHours, placeDay } from "./layout.ts";

type TimeGridProps = {
  days: string[];
  appointments: AppointmentDetailResponse[];
};

/** Hour gutter plus one column per day; blocks are positioned by start and duration. */
export function TimeGrid({ days, appointments }: TimeGridProps) {
  const compact = days.length > 1;
  const columns = days.map((day) => ({ day, blocks: placeDay(appointments, day) }));
  const { startHour, endHour } = gridHours(columns.flatMap((column) => column.blocks));
  const hours = Array.from({ length: endHour - startHour }, (_, index) => startHour + index);
  const today = todayKey();
  const openBooking = useAgendaStore((state) => state.openBooking);

  return (
    <div
      className="grid min-w-0"
      style={{ gridTemplateColumns: `${compact ? "2.25rem" : "3rem"} repeat(${days.length}, minmax(0, 1fr))` }}
    >
      {compact && (
        <>
          <div className="sticky top-0 z-10 border-b bg-background" />
          {days.map((day) => (
            <div
              key={day}
              className={cn(
                "sticky top-0 z-10 flex flex-col items-center border-b border-l bg-background py-1 text-xs",
                day === today && "font-semibold text-blue-700",
              )}
              title={formatDayLabel(day)}
            >
              <span className="capitalize">{formatWeekdayShort(day).replace(".", "")}</span>
              <span className="text-sm">{dayOfMonth(day)}</span>
            </div>
          ))}
        </>
      )}

      <div>
        {hours.map((hour) => {
          const label = String(hour).padStart(2, "0");
          return (
            <div
              key={hour}
              data-testid={`hour-${label}`}
              className="border-t pr-1 text-right text-[10px] text-muted-foreground first:border-t-0 sm:text-xs"
              style={{ height: HOUR_PX }}
            >
              <span className={cn("relative bg-background px-0.5", hour === startHour ? "top-0.5" : "-top-2")}>
                {label}:00
              </span>
            </div>
          );
        })}
      </div>

      {columns.map(({ day, blocks }) => (
        <div key={day} data-testid={`day-${day}`} className="relative border-l" style={{ height: hours.length * HOUR_PX }}>
          {hours.map((hour) => {
            const label = `${String(hour).padStart(2, "0")}:00`;
            // Day view: an empty hour is a tap target that opens the booking dialog at that time. Keyboard users have
            // "Nueva cita" in the toolbar, so these stay out of the Tab order (they remain reachable by assistive tech).
            return compact ? (
              <div key={hour} className="border-t first:border-t-0" style={{ height: HOUR_PX }} />
            ) : (
              <button
                key={hour}
                type="button"
                tabIndex={-1}
                aria-label={`Agendar a las ${label}`}
                className="block w-full cursor-pointer border-t outline-none first:border-t-0 hover:bg-muted/60 focus-visible:bg-muted/60"
                style={{ height: HOUR_PX }}
                onClick={(event) => {
                  rememberOpener(event.currentTarget);
                  openBooking({ date: day, time: label });
                }}
              />
            );
          })}
          {blocks.map((block) => (
            <AppointmentBlock
              key={block.appointment.id}
              block={block}
              gridStartMin={startHour * 60}
              compact={compact}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

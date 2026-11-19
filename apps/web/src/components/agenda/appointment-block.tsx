import type { AppointmentDetailResponse } from "@gestion/shared";
import { cn } from "@/lib/utils.ts";
import { formatTime } from "@/lib/agenda-dates.ts";
import { rememberOpener } from "@/lib/focus-return.ts";
import { useAgendaStore } from "@/stores/agenda-store.ts";
import type { PlacedBlock } from "./layout.ts";

/** Pixels per hour of the time grid; a block's top and height derive from it. */
export const HOUR_PX = 64;

/** A block taller than this (in minutes) has room for a second line. */
const TWO_LINE_MINUTES = 45;

export function customerLabel({ customerName, customerPhone }: AppointmentDetailResponse): string {
  return customerName ?? `+${customerPhone}`;
}

type AppointmentBlockProps = {
  block: PlacedBlock;
  gridStartMin: number;
  /** Week view: narrow columns, so only the customer. */
  compact: boolean;
};

export function AppointmentBlock({ block, gridStartMin, compact }: AppointmentBlockProps) {
  const { appointment } = block;
  const cancelled = appointment.status === "cancelled";
  const durationMin = block.endMin - block.startMin;
  const name = customerLabel(appointment);
  const openDetail = useAgendaStore((state) => state.openDetail);
  const time = `${formatTime(new Date(appointment.startsAt))}–${formatTime(new Date(appointment.endsAt))}`;
  const summary = `${name}, ${appointment.serviceName}, ${time}${cancelled ? ", cancelada" : ""}`;
  const roomy = !compact && durationMin >= TWO_LINE_MINUTES;

  return (
    <button
      type="button"
      data-testid="appointment-block"
      data-status={appointment.status}
      aria-label={summary}
      title={summary}
      onClick={(event) => {
        rememberOpener(event.currentTarget);
        openDetail(appointment);
      }}
      className={cn(
        "absolute cursor-pointer overflow-hidden rounded-md border border-background border-l-4 px-1 text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "py-0.5 text-[10px] leading-3" : "px-2 py-1 text-xs leading-4",
        cancelled
          ? "border-l-muted-foreground bg-muted text-muted-foreground line-through"
          : "border-l-teal-700 bg-teal-100 text-teal-950",
      )}
      style={{
        top: ((block.startMin - gridStartMin) * HOUR_PX) / 60,
        height: (durationMin * HOUR_PX) / 60,
        left: `${(block.lane / block.lanes) * 100}%`,
        width: `${100 / block.lanes}%`,
      }}
    >
      {compact ? (
        <span className="line-clamp-2 block font-medium break-words">{name}</span>
      ) : roomy ? (
        <>
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate">{appointment.serviceName}</span>
          <span className="block truncate">
            {time}
            {cancelled && <span className="no-underline"> · Cancelada</span>}
          </span>
        </>
      ) : (
        <span className="block truncate">
          <span className="font-medium">{name}</span> · {appointment.serviceName}
          {cancelled && " · Cancelada"}
        </span>
      )}
    </button>
  );
}

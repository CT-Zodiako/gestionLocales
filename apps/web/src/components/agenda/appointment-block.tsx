import { cn } from "@/lib/utils.ts";
import { formatTime } from "@/lib/agenda-dates.ts";
import type { PlacedBlock } from "./layout.ts";

/** Pixels per hour of the time grid; a block's top and height derive from it. */
export const HOUR_PX = 64;

/** A block taller than this (in minutes) has room for a second line. */
const TWO_LINE_MINUTES = 45;

export function customerLabel(block: PlacedBlock): string {
  const { customerName, customerPhone } = block.appointment;
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
  const name = customerLabel(block);
  const time = `${formatTime(new Date(appointment.startsAt))}–${formatTime(new Date(appointment.endsAt))}`;
  const summary = `${name}, ${appointment.serviceName}, ${time}${cancelled ? ", cancelada" : ""}`;
  const roomy = !compact && durationMin >= TWO_LINE_MINUTES;

  return (
    <div
      data-testid="appointment-block"
      data-status={appointment.status}
      role="group"
      aria-label={summary}
      title={summary}
      className={cn(
        "absolute overflow-hidden rounded-md border border-background border-l-4 px-1 text-left",
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
        <p className="line-clamp-2 font-medium break-words">{name}</p>
      ) : roomy ? (
        <>
          <p className="truncate font-medium">{name}</p>
          <p className="truncate">{appointment.serviceName}</p>
          <p className="truncate">
            {time}
            {cancelled && <span className="no-underline"> · Cancelada</span>}
          </p>
        </>
      ) : (
        <p className="truncate">
          <span className="font-medium">{name}</span> · {appointment.serviceName}
          {cancelled && " · Cancelada"}
        </p>
      )}
    </div>
  );
}

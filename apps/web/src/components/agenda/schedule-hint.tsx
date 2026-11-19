import { formatTime, toDateKey } from "@/lib/agenda-dates.ts";
import { localInstant } from "@/lib/appointment-forms.ts";

type ScheduleHintProps = {
  date: string;
  time: string;
  durationMinutes: number | undefined;
};

/** "Termina a las 11:15" once the start and the duration are known; polite so typing is not interrupted. */
export function ScheduleHint({ date, time, durationMinutes }: ScheduleHintProps) {
  const start = localInstant(date, time);
  let text: string | null = null;
  if (start && durationMinutes !== undefined) {
    const end = new Date(Date.parse(start) + durationMinutes * 60_000);
    text = `Termina a las ${formatTime(end)}${toDateKey(end) === date ? "" : " (día siguiente)"}`;
  }
  return (
    <p data-testid="end-time" aria-live="polite" className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { HttpError } from "@/lib/api.ts";
import { visibleRange } from "@/lib/agenda-dates.ts";
import { appointmentsQueryOptions } from "@/lib/appointments.ts";
import { useAgendaStore } from "@/stores/agenda-store.ts";
import { TimeGrid } from "./time-grid.tsx";

/** Day or week agenda for the selected date: loading, error with retry, empty and the time grid. */
export function AgendaView() {
  const selectedDate = useAgendaStore((state) => state.selectedDate);
  const view = useAgendaStore((state) => state.view);
  const showCancelled = useAgendaStore((state) => state.showCancelled);

  const range = visibleRange(view, selectedDate);
  const query = useQuery(appointmentsQueryOptions(range.from, range.to));

  if (query.isPending) {
    return (
      <p role="status" className="p-6 text-center text-sm text-muted-foreground">
        Cargando citas…
      </p>
    );
  }

  if (query.isError) {
    const expired = query.error instanceof HttpError && query.error.status === 401;
    return (
      <div role="alert" className="flex flex-col items-center gap-3 p-6 text-center text-sm">
        <p className="text-destructive">
          {expired ? "Tu sesión expiró. Vuelve a iniciar sesión." : "No se pudieron cargar las citas."}
        </p>
        {expired ? (
          <Button asChild variant="outline" className="h-10 px-4">
            <Link to="/login">Iniciar sesión</Link>
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-10 px-4"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Reintentando…" : "Reintentar"}
          </Button>
        )}
      </div>
    );
  }

  const appointments = showCancelled
    ? query.data
    : query.data.filter((appointment) => appointment.status !== "cancelled");

  return (
    <>
      {appointments.length === 0 && (
        <p role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">
          {view === "week" ? "No hay citas esta semana." : "No hay citas para este día."}
        </p>
      )}
      <TimeGrid days={range.days} appointments={appointments} />
    </>
  );
}

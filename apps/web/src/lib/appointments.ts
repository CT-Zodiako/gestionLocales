import { queryOptions } from "@tanstack/react-query";
import { fetchAppointments } from "./api.ts";

/** Appointments of the half-open window `[from, to)`; the key carries the range, so each range is cached apart. */
export function appointmentsQueryOptions(from: Date, to: Date) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return queryOptions({
    queryKey: ["appointments", fromIso, toIso],
    queryFn: () => fetchAppointments(fromIso, toIso),
    retry: false,
    // Offline, the request is attempted anyway and fails at once (error state with Reintentar); the default
    // "online" mode would pause the query and leave "Cargando citas…" on screen until the network returns.
    networkMode: "always",
    staleTime: 30_000,
  });
}

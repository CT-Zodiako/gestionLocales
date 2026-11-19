import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAgendaStore } from "@/stores/agenda-store.ts";
import { ApiError, cancelAppointment, createAppointment, createService, fetchAppointments, fetchServices, moveAppointment } from "./api.ts";
import { toDateKey } from "./agenda-dates.ts";

export const appointmentsQueryKey = ["appointments"];
export const servicesQueryKey = ["services"];
/** Shared by every write below, so a dialog can tell that one is in flight (`useIsMutating`). */
export const agendaWriteMutationKey = ["agenda-write"];

/** Appointments of the half-open window `[from, to)`; the key carries the range, so each range is cached apart. */
export function appointmentsQueryOptions(from: Date, to: Date) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return queryOptions({
    queryKey: [...appointmentsQueryKey, fromIso, toIso],
    queryFn: () => fetchAppointments(fromIso, toIso),
    retry: false,
    // Offline, the request is attempted anyway and fails at once (error state with Reintentar); the default
    // "online" mode would pause the query and leave "Cargando citas…" on screen until the network returns.
    networkMode: "always",
    staleTime: 30_000,
  });
}

export function servicesQueryOptions() {
  return queryOptions({
    queryKey: servicesQueryKey,
    queryFn: fetchServices,
    retry: false,
    networkMode: "always",
    staleTime: 30_000,
  });
}

/**
 * The writes wait for the refetch of what they changed before resolving, so a dialog closes on the fresh grid.
 * A 404 means the agenda is stale (the appointment or service is gone), so it is refreshed on that error too.
 */
function useAgendaWrites() {
  const queryClient = useQueryClient();
  const refreshAppointments = () => queryClient.invalidateQueries({ queryKey: appointmentsQueryKey });
  const refreshServices = () => queryClient.invalidateQueries({ queryKey: servicesQueryKey });
  const refreshOnNotFound = async (error: Error) => {
    if (error instanceof ApiError && error.status === 404) await Promise.all([refreshAppointments(), refreshServices()]);
  };
  return { refreshAppointments, refreshServices, refreshOnNotFound };
}

export function useCreateAppointment() {
  const { refreshAppointments, refreshOnNotFound } = useAgendaWrites();
  return useMutation({
    mutationKey: agendaWriteMutationKey,
    mutationFn: createAppointment,
    onSuccess: async (appointment) => {
      useAgendaStore.getState().reveal(toDateKey(new Date(appointment.startsAt)));
      await refreshAppointments();
    },
    onError: refreshOnNotFound,
  });
}

export function useMoveAppointment() {
  const { refreshAppointments, refreshOnNotFound } = useAgendaWrites();
  return useMutation({
    mutationKey: agendaWriteMutationKey,
    mutationFn: ({ id, startsAt }: { id: string; startsAt: string }) => moveAppointment(id, { startsAt }),
    onSuccess: async (appointment) => {
      useAgendaStore.getState().reveal(toDateKey(new Date(appointment.startsAt)));
      await refreshAppointments();
    },
    onError: refreshOnNotFound,
  });
}

export function useCancelAppointment() {
  const { refreshAppointments, refreshOnNotFound } = useAgendaWrites();
  return useMutation({
    mutationKey: agendaWriteMutationKey,
    mutationFn: cancelAppointment,
    onSuccess: refreshAppointments,
    onError: refreshOnNotFound,
  });
}

export function useCreateService() {
  const { refreshServices } = useAgendaWrites();
  return useMutation({
    mutationKey: agendaWriteMutationKey,
    mutationFn: createService,
    onSuccess: refreshServices,
  });
}

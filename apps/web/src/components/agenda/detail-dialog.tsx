import { zodResolver } from "@hookform/resolvers/zod";
import type { AppointmentDetailResponse } from "@gestion/shared";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { formatDayLabel, formatTime, toDateKey, toTimeKey } from "@/lib/agenda-dates.ts";
import { type MoveFormValues, moveFormSchema, toMoveBody, writeErrorMessage } from "@/lib/appointment-forms.ts";
import { agendaWriteMutationKey, servicesQueryOptions, useCancelAppointment, useMoveAppointment } from "@/lib/appointments.ts";
import { restoreOpener } from "@/lib/focus-return.ts";
import { formatPrice } from "@/lib/services.ts";
import { useAgendaStore } from "@/stores/agenda-store.ts";
import { customerLabel } from "./appointment-block.tsx";
import { errorProps, FormAlert, FormField } from "./form-field.tsx";
import { ScheduleHint } from "./schedule-hint.tsx";

/** Detail of the clicked appointment, with "Mover" (a date/time form) and "Cancelar cita" (with a confirmation step). */
export function AppointmentDetailDialog() {
  const open = useAgendaStore((state) => state.detailOpen);
  const appointment = useAgendaStore((state) => state.detailAppointment);
  const close = useAgendaStore((state) => state.closeDetail);
  const writing = useIsMutating({ mutationKey: agendaWriteMutationKey }) > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !writing) close();
      }}
    >
      <DialogContent onCloseAutoFocus={restoreOpener} onInteractOutside={(event) => event.preventDefault()}>
        {/* Keyed so each appointment starts in its detail view. */}
        {appointment && <DetailBody key={appointment.id} appointment={appointment} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

type Mode = "view" | "move" | "cancel";

type DetailBodyProps = {
  appointment: AppointmentDetailResponse;
  onClose: () => void;
};

function DetailBody({ appointment, onClose }: DetailBodyProps) {
  const [mode, setMode] = useState<Mode>("view");
  // The button to focus when coming back to the detail view (the one that opened the step just left).
  const [returnedFrom, setReturnedFrom] = useState<Exclude<Mode, "view"> | null>(null);
  const start = new Date(appointment.startsAt);
  const end = new Date(appointment.endsAt);
  const summary = `${appointment.serviceName} · ${formatTime(start)}–${formatTime(end)}`;
  const name = customerLabel(appointment);
  // The price is not part of the appointment; it comes from the services list (shared cache), when there is one.
  const services = useQuery(servicesQueryOptions());
  const price = services.data?.find((service) => service.id === appointment.serviceId)?.price ?? null;

  function backToView(from: Exclude<Mode, "view">) {
    setReturnedFrom(from);
    setMode("view");
  }

  if (mode === "move") {
    return (
      <MoveForm
        appointment={appointment}
        description={`${name} · ${summary}`}
        onBack={() => backToView("move")}
        onClose={onClose}
      />
    );
  }

  if (mode === "cancel") {
    return (
      <CancelConfirmation
        appointment={appointment}
        description={`${name} · ${formatDayLabel(toDateKey(start))} · ${summary}`}
        onBack={() => backToView("cancel")}
        onClose={onClose}
      />
    );
  }

  const cancelled = appointment.status === "cancelled";
  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>{summary}</DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Fecha</dt>
        <dd>{formatDayLabel(toDateKey(start))}</dd>
        <dt className="text-muted-foreground">Teléfono</dt>
        <dd>+{appointment.customerPhone}</dd>
        {price !== null && (
          <>
            <dt className="text-muted-foreground">Precio</dt>
            <dd data-testid="detail-price">{formatPrice(price)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Estado</dt>
        <dd>{cancelled ? "Cancelada" : "Agendada"}</dd>
      </dl>

      {!cancelled && (
        <DialogFooter className="flex-col sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="h-10"
            autoFocus={returnedFrom === "move"}
            onClick={() => setMode("move")}
          >
            Mover
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-10"
            autoFocus={returnedFrom === "cancel"}
            onClick={() => setMode("cancel")}
          >
            Cancelar cita
          </Button>
        </DialogFooter>
      )}
    </>
  );
}

type StepProps = {
  appointment: AppointmentDetailResponse;
  description: string;
  onBack: () => void;
  onClose: () => void;
};

function MoveForm({ appointment, description, onBack, onClose }: StepProps) {
  const moveAppointment = useMoveAppointment();
  const [formError, setFormError] = useState<string | null>(null);
  const start = new Date(appointment.startsAt);
  const durationMinutes = (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000;
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<MoveFormValues>({
    resolver: zodResolver(moveFormSchema),
    defaultValues: { date: toDateKey(start), time: toTimeKey(start) },
  });
  const [date, time] = watch(["date", "time"]);

  async function onSubmit(values: MoveFormValues) {
    if (moveAppointment.isPending) return;
    setFormError(null);
    try {
      await moveAppointment.mutateAsync({ id: appointment.id, startsAt: toMoveBody(values).startsAt });
    } catch (error) {
      setFormError(writeErrorMessage(error, "move"));
      return;
    }
    onClose();
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>Mover cita</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <form noValidate className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
        <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
          <FormField id="move-date" label="Fecha" error={errors.date?.message}>
            <Input id="move-date" type="date" autoFocus {...errorProps("move-date", errors.date?.message)} {...register("date")} />
          </FormField>
          <FormField id="move-time" label="Hora" error={errors.time?.message}>
            <Input id="move-time" type="time" {...errorProps("move-time", errors.time?.message)} {...register("time")} />
          </FormField>
        </div>
        <ScheduleHint date={date} time={time} durationMinutes={durationMinutes} />

        <FormAlert message={formError} />

        <DialogFooter className="flex-col sm:flex-row">
          <Button type="button" variant="outline" className="h-10" disabled={moveAppointment.isPending} onClick={onBack}>
            Volver
          </Button>
          <Button type="submit" className="h-10" disabled={moveAppointment.isPending}>
            {moveAppointment.isPending ? "Moviendo…" : "Mover cita"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function CancelConfirmation({ appointment, description, onBack, onClose }: StepProps) {
  const cancelAppointment = useCancelAppointment();
  const [formError, setFormError] = useState<string | null>(null);

  async function confirm() {
    if (cancelAppointment.isPending) return;
    setFormError(null);
    try {
      await cancelAppointment.mutateAsync(appointment.id);
    } catch (error) {
      setFormError(writeErrorMessage(error, "cancel"));
      return;
    }
    onClose();
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>¿Cancelar esta cita?</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <p>La cita quedará cancelada y el horario volverá a estar libre.</p>

      <FormAlert message={formError} />

      <DialogFooter className="flex-col sm:flex-row">
        {/* The safe answer takes the focus. */}
        <Button type="button" variant="outline" className="h-10" autoFocus disabled={cancelAppointment.isPending} onClick={onBack}>
          No, volver
        </Button>
        <Button type="button" variant="destructive" className="h-10" disabled={cancelAppointment.isPending} onClick={() => void confirm()}>
          {cancelAppointment.isPending ? "Cancelando…" : "Sí, cancelar cita"}
        </Button>
      </DialogFooter>
    </>
  );
}

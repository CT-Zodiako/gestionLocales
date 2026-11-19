import { zodResolver } from "@hookform/resolvers/zod";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import {
  type BookingFormValues,
  bookingFormSchema,
  toCreateBody,
  writeErrorMessage,
} from "@/lib/appointment-forms.ts";
import { agendaWriteMutationKey, servicesQueryOptions, useCreateAppointment } from "@/lib/appointments.ts";
import { restoreOpener } from "@/lib/focus-return.ts";
import { useAgendaStore } from "@/stores/agenda-store.ts";
import { errorProps, FormAlert, FormField } from "./form-field.tsx";
import { ScheduleHint } from "./schedule-hint.tsx";
import { ServiceInlineForm } from "./service-inline-form.tsx";

/** "Nueva cita": opened from the toolbar or an empty slot; closes on success, keeps everything typed on an error. */
export function BookingDialog() {
  const open = useAgendaStore((state) => state.bookingOpen);
  const prefill = useAgendaStore((state) => state.bookingPrefill);
  const close = useAgendaStore((state) => state.closeBooking);
  const writing = useIsMutating({ mutationKey: agendaWriteMutationKey }) > 0;

  return (
    <Dialog
      open={open}
      // Neither Escape nor the close button may discard a request that is still in flight.
      onOpenChange={(next) => {
        if (!next && !writing) close();
      }}
    >
      <DialogContent
        onCloseAutoFocus={restoreOpener}
        // A stray tap outside must not throw away what was typed; Escape, the X and "Cancelar" close it.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <BookingForm prefill={prefill} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

type BookingFormProps = {
  prefill: { date: string; time: string };
  onClose: () => void;
};

function BookingForm({ prefill, onClose }: BookingFormProps) {
  const services = useQuery(servicesQueryOptions());
  const createAppointment = useCreateAppointment();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BookingFormValues>({
    resolver: zodResolver(bookingFormSchema),
    defaultValues: { customerPhone: "", customerName: "", serviceId: "", date: prefill.date, time: prefill.time },
  });

  const activeServices = services.data?.filter((service) => service.active) ?? [];
  const noServices = services.isSuccess && activeServices.length === 0;
  const [serviceId, date, time] = watch(["serviceId", "date", "time"]);
  const duration = activeServices.find((service) => service.id === serviceId)?.durationMinutes;

  async function onSubmit(values: BookingFormValues) {
    if (createAppointment.isPending) return;
    setFormError(null);
    try {
      await createAppointment.mutateAsync(toCreateBody(values));
    } catch (error) {
      setFormError(writeErrorMessage(error, "create"));
      return;
    }
    onClose();
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>Nueva cita</DialogTitle>
        <DialogDescription>Datos del cliente, servicio y horario.</DialogDescription>
      </DialogHeader>

      {noServices && (
        <ServiceInlineForm
          onCreated={(service) => setValue("serviceId", service.id, { shouldValidate: Boolean(errors.serviceId) })}
        />
      )}

      <form noValidate className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
        <FormField id="booking-phone" label="Teléfono del cliente" error={errors.customerPhone?.message}>
          <Input
            id="booking-phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+57 300 123 4567"
            {...errorProps("booking-phone", errors.customerPhone?.message)}
            {...register("customerPhone")}
          />
        </FormField>

        <FormField id="booking-name" label="Nombre del cliente (opcional)" error={errors.customerName?.message}>
          <Input
            id="booking-name"
            autoComplete="off"
            {...errorProps("booking-name", errors.customerName?.message)}
            {...register("customerName")}
          />
        </FormField>

        <FormField id="booking-service" label="Servicio" error={errors.serviceId?.message}>
          <Controller
            control={control}
            name="serviceId"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={!services.isSuccess || noServices}
              >
                <SelectTrigger
                  id="booking-service"
                  ref={field.ref}
                  onBlur={field.onBlur}
                  className="w-full"
                  {...errorProps("booking-service", errors.serviceId?.message)}
                >
                  <SelectValue placeholder={services.isPending ? "Cargando servicios…" : "Elige un servicio"} />
                </SelectTrigger>
                <SelectContent>
                  {activeServices.map((service) => (
                    <SelectItem key={service.id} value={service.id}>
                      {service.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {services.isError && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              <span>No se pudieron cargar los servicios.</span>
              <Button
                type="button"
                variant="outline"
                className="h-10"
                disabled={services.isFetching}
                onClick={() => void services.refetch()}
              >
                {services.isFetching ? "Reintentando…" : "Reintentar"}
              </Button>
            </div>
          )}
        </FormField>

        <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
          <FormField id="booking-date" label="Fecha" error={errors.date?.message}>
            <Input id="booking-date" type="date" {...errorProps("booking-date", errors.date?.message)} {...register("date")} />
          </FormField>
          <FormField id="booking-time" label="Hora" error={errors.time?.message}>
            <Input id="booking-time" type="time" {...errorProps("booking-time", errors.time?.message)} {...register("time")} />
          </FormField>
        </div>
        <ScheduleHint date={date} time={time} durationMinutes={duration} />

        <FormAlert message={formError} />

        <DialogFooter className="flex-col sm:flex-row">
          <Button type="button" variant="outline" className="h-10" disabled={createAppointment.isPending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" className="h-10" disabled={createAppointment.isPending}>
            {createAppointment.isPending ? "Agendando…" : "Agendar cita"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

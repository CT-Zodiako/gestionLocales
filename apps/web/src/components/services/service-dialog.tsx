import { zodResolver } from "@hookform/resolvers/zod";
import type { ServiceResponse } from "@gestion/shared";
import { useIsMutating } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { errorProps, FormAlert, FormField } from "@/components/agenda/form-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  type ServiceEditFormValues,
  serviceEditFormSchema,
  toServiceBody,
  toUpdateServiceBody,
  writeErrorMessage,
} from "@/lib/appointment-forms.ts";
import { agendaWriteMutationKey, useCreateService, useUpdateService } from "@/lib/appointments.ts";
import { restoreOpener } from "@/lib/focus-return.ts";

type ServiceDialogProps = {
  open: boolean;
  /** The service being edited, or null to create one. */
  service: ServiceResponse | null;
  onClose: () => void;
};

/** Create (`service` null) or edit a service. Closes on success, keeps everything typed on an error. */
export function ServiceDialog({ open, service, onClose }: ServiceDialogProps) {
  const writing = useIsMutating({ mutationKey: agendaWriteMutationKey }) > 0;

  return (
    <Dialog
      open={open}
      // Neither Escape nor the close button may discard a request that is still in flight.
      onOpenChange={(next) => {
        if (!next && !writing) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={restoreOpener}
        // A stray tap outside must not throw away what was typed; Escape, the X and "Cancelar" close it.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <ServiceForm key={service?.id ?? "new"} service={service} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function ServiceForm({ service, onClose }: { service: ServiceResponse | null; onClose: () => void }) {
  const editing = service !== null;
  const createService = useCreateService();
  const updateService = useUpdateService();
  const pending = createService.isPending || updateService.isPending;
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<ServiceEditFormValues>({
    resolver: zodResolver(serviceEditFormSchema),
    defaultValues: {
      name: service?.name ?? "",
      durationMinutes: service ? String(service.durationMinutes) : "",
      price: service?.price == null ? "" : String(service.price),
      active: service?.active ?? true,
    },
  });

  async function onSubmit(values: ServiceEditFormValues) {
    if (pending) return;
    setFormError(null);
    try {
      if (service) await updateService.mutateAsync({ id: service.id, body: toUpdateServiceBody(values) });
      else await createService.mutateAsync(toServiceBody(values));
    } catch (error) {
      setFormError(writeErrorMessage(error, editing ? "service-edit" : "service"));
      return;
    }
    onClose();
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>{editing ? "Editar servicio" : "Nuevo servicio"}</DialogTitle>
        <DialogDescription>
          {editing ? "Cambia los datos del servicio." : "Nombre, duración y precio del servicio."}
        </DialogDescription>
      </DialogHeader>

      <form noValidate className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
        <FormField id="service-name" label="Nombre del servicio" error={errors.name?.message}>
          <Input id="service-name" autoFocus autoComplete="off" {...errorProps("service-name", errors.name?.message)} {...register("name")} />
        </FormField>

        <FormField id="service-duration" label="Duración (minutos)" error={errors.durationMinutes?.message}>
          <Input
            id="service-duration"
            inputMode="numeric"
            autoComplete="off"
            {...errorProps("service-duration", errors.durationMinutes?.message)}
            {...register("durationMinutes")}
          />
        </FormField>

        <FormField id="service-price" label="Precio (opcional)" error={errors.price?.message}>
          <Input
            id="service-price"
            inputMode="numeric"
            autoComplete="off"
            placeholder="25000"
            {...errorProps("service-price", errors.price?.message)}
            {...register("price")}
          />
          <p className="text-xs text-muted-foreground">En pesos, sin puntos ni decimales. Vacío: sin precio.</p>
        </FormField>

        {editing && (
          <div className="flex flex-col gap-1">
            <div className="flex min-h-10 items-center justify-between gap-3">
              <Label htmlFor="service-active" className="min-h-10 flex-1">
                Activo
              </Label>
              <Controller
                control={control}
                name="active"
                render={({ field }) => (
                  <Switch
                    id="service-active"
                    ref={field.ref}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-describedby="service-active-hint"
                  />
                )}
              />
            </div>
            <p id="service-active-hint" className="text-xs text-muted-foreground">
              Un servicio inactivo no se ofrece para agendar ni en WhatsApp.
            </p>
          </div>
        )}

        <FormAlert message={formError} />

        <DialogFooter className="flex-col sm:flex-row">
          <Button type="button" variant="outline" className="h-10" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" className="h-10" disabled={pending}>
            {editing ? (pending ? "Guardando…" : "Guardar cambios") : pending ? "Creando…" : "Crear servicio"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

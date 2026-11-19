import { zodResolver } from "@hookform/resolvers/zod";
import type { ServiceResponse } from "@gestion/shared";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { type ServiceFormValues, serviceFormSchema, toServiceBody, writeErrorMessage } from "@/lib/appointment-forms.ts";
import { useCreateService } from "@/lib/appointments.ts";
import { errorProps, FormAlert, FormField } from "./form-field.tsx";

/** "Nuevo servicio": offered inside the booking dialog while the business has no services to pick. */
export function ServiceInlineForm({ onCreated }: { onCreated: (service: ServiceResponse) => void }) {
  const createService = useCreateService();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceFormSchema),
    defaultValues: { name: "", durationMinutes: "" },
  });

  async function onSubmit(values: ServiceFormValues) {
    if (createService.isPending) return;
    setFormError(null);
    try {
      onCreated(await createService.mutateAsync(toServiceBody(values)));
    } catch (error) {
      setFormError(writeErrorMessage(error, "service"));
    }
  }

  return (
    <form
      noValidate
      aria-labelledby="new-service-title"
      className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3"
      onSubmit={handleSubmit(onSubmit)}
    >
      <div className="flex flex-col gap-1">
        <h3 id="new-service-title" className="text-sm font-medium">
          Nuevo servicio
        </h3>
        <p className="text-sm text-muted-foreground">Aún no tienes servicios. Crea uno para poder agendar.</p>
      </div>
      <FormField id="new-service-name" label="Nombre del servicio" error={errors.name?.message}>
        <Input id="new-service-name" autoComplete="off" {...errorProps("new-service-name", errors.name?.message)} {...register("name")} />
      </FormField>
      <FormField id="new-service-duration" label="Duración (minutos)" error={errors.durationMinutes?.message}>
        <Input
          id="new-service-duration"
          inputMode="numeric"
          autoComplete="off"
          {...errorProps("new-service-duration", errors.durationMinutes?.message)}
          {...register("durationMinutes")}
        />
      </FormField>
      <FormAlert message={formError} />
      <Button type="submit" variant="outline" className="h-10" disabled={createService.isPending}>
        {createService.isPending ? "Creando…" : "Crear servicio"}
      </Button>
    </form>
  );
}

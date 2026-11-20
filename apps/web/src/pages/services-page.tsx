import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import type { ServiceResponse } from "@gestion/shared";
import { AgendaHeader } from "@/components/agenda/agenda-header.tsx";
import { ServiceDialog } from "@/components/services/service-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { servicesQueryOptions } from "@/lib/appointments.ts";
import { rememberOpener } from "@/lib/focus-return.ts";
import { formatDuration, priceLabel, sortServices } from "@/lib/services.ts";
import { cn } from "@/lib/utils.ts";

/** "Servicios": every service of the business (active first), with create and edit in a dialog. */
export function ServicesPage() {
  const services = useQuery(servicesQueryOptions());
  // Which dialog is open, and for which service (null = a new one). The service is kept while the dialog closes.
  const [dialog, setDialog] = useState<{ open: boolean; service: ServiceResponse | null }>({ open: false, service: null });

  function openDialog(element: HTMLElement, service: ServiceResponse | null) {
    rememberOpener(element);
    setDialog({ open: true, service });
  }

  return (
    <div className="mx-auto flex h-dvh max-w-6xl flex-col">
      <AgendaHeader />
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="min-w-0 text-base font-semibold">Servicios</h2>
        <Button type="button" className="h-10 shrink-0 px-3" onClick={(event) => openDialog(event.currentTarget, null)}>
          <Plus />
          Nuevo servicio
        </Button>
      </div>

      {/* Focusable so keyboard users can scroll the list; the ring is inset because the container clips overflow. */}
      <main
        tabIndex={0}
        aria-label="Lista de servicios"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {services.isPending && <p className="p-3 text-sm text-muted-foreground">Cargando servicios…</p>}

        {services.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-destructive">
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

        {services.isSuccess && services.data.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">Aún no tienes servicios. Crea el primero con «Nuevo servicio».</p>
        )}

        {services.isSuccess && services.data.length > 0 && (
          <ul className="divide-y">
            {sortServices(services.data).map((service) => (
              <ServiceRow key={service.id} service={service} onEdit={(element) => openDialog(element, service)} />
            ))}
          </ul>
        )}
      </main>

      <ServiceDialog
        open={dialog.open}
        service={dialog.service}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
      />
    </div>
  );
}

function ServiceRow({ service, onEdit }: { service: ServiceResponse; onEdit: (element: HTMLElement) => void }) {
  return (
    <li data-testid="service-row" data-active={service.active} className="flex items-center gap-3 px-3 py-2">
      <div className={cn("min-w-0 flex-1", !service.active && "text-muted-foreground")}>
        <p data-testid="service-name" className="truncate font-medium">
          {service.name}
        </p>
        <p className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span data-testid="service-duration">{formatDuration(service.durationMinutes)}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="service-price">{priceLabel(service.price)}</span>
        </p>
      </div>
      <span
        data-testid="service-status"
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
          service.active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {service.active ? "Activo" : "Inactivo"}
      </span>
      <Button
        type="button"
        variant="outline"
        className="h-10 shrink-0 px-3"
        aria-label={`Editar ${service.name}`}
        onClick={(event) => onEdit(event.currentTarget)}
      >
        <Pencil />
        Editar
      </Button>
    </li>
  );
}

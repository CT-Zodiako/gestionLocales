import type { ServiceResponse } from "@gestion/shared";

/** `$25.000`: whole pesos with a dot as thousands separator (es-CO), no decimals. Same format as the WhatsApp bot. */
export function formatPrice(price: number): string {
  return `$${String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/** `30 min`. */
export function formatDuration(durationMinutes: number): string {
  return `${durationMinutes} min`;
}

/** The price of the list, or `Sin precio` when the service has none. */
export function priceLabel(price: number | null): string {
  return price === null ? "Sin precio" : formatPrice(price);
}

/** Option text of a service picker: the name, plus `· $25.000` when it has a price. */
export function serviceOptionLabel(service: Pick<ServiceResponse, "name" | "price">): string {
  return service.price === null ? service.name : `${service.name} · ${formatPrice(service.price)}`;
}

/** Active services first, then the inactive ones; each group by name. */
export function sortServices(services: ServiceResponse[]): ServiceResponse[] {
  return [...services].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
  );
}

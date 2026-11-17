import { type HealthResponse, healthResponseSchema } from "@gestion/shared";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  // 503 still carries a valid body describing the degraded state.
  return healthResponseSchema.parse(await res.json());
}

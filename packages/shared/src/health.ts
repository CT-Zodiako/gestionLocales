import { z } from "zod";

/** Response of GET /api/health, shared by the API and the PWA. */
export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  database: z.enum(["up", "down"]),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

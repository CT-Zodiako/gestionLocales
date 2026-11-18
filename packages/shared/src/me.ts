import { z } from "zod";

/** Signed-in user, as returned by GET /api/me. */
export const meUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});

export type MeUser = z.infer<typeof meUserSchema>;

/** Business the signed-in user belongs to. */
export const meBusinessSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type MeBusiness = z.infer<typeof meBusinessSchema>;

/** Response of GET /api/me when a valid session cookie is present. */
export const meResponseSchema = z.object({
  user: meUserSchema,
  business: meBusinessSchema,
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Body of every error response of the API. */
export const errorResponseSchema = z.object({
  error: z.string(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

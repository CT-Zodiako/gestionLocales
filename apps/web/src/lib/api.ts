import {
  type HealthResponse,
  healthResponseSchema,
  type MeResponse,
  meResponseSchema,
} from "@gestion/shared";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  // 503 still carries a valid body describing the degraded state.
  return healthResponseSchema.parse(await res.json());
}

/** Same-origin GET /api/me; resolves to null when there is no session. */
export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch("/api/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GET /api/me failed with ${res.status}`);

  return meResponseSchema.parse(await res.json());
}

export type SignInInput = {
  email: string;
  password: string;
};

/** Better Auth email+password sign-in; the session cookie is set by the API. */
export async function signIn(input: SignInInput): Promise<void> {
  const res = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`POST /api/auth/sign-in/email failed with ${res.status}`);
}

export async function signOut(): Promise<void> {
  const res = await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`POST /api/auth/sign-out failed with ${res.status}`);
}

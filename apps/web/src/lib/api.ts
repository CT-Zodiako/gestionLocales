import {
  type AppointmentDetailResponse,
  type AppointmentResponse,
  appointmentSchema,
  type CreateAppointmentBody,
  type CreateServiceBody,
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  listAppointmentsResponseSchema,
  listServicesResponseSchema,
  type MeResponse,
  meResponseSchema,
  type MoveAppointmentBody,
  type ServiceResponse,
  serviceSchema,
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

/** A failed HTTP call; `status` lets callers tell a rejection from an outage. */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
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
  if (!res.ok) throw new HttpError(`POST /api/auth/sign-in/email failed with ${res.status}`, res.status);
}

export async function signOut(): Promise<void> {
  const res = await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`POST /api/auth/sign-out failed with ${res.status}`);
}

/** GET /api/appointments for the half-open window `[from, to)` (ISO instants); any status, ordered by start. */
export async function fetchAppointments(from: string, to: string): Promise<AppointmentDetailResponse[]> {
  const res = await fetch(`/api/appointments?${new URLSearchParams({ from, to })}`);
  if (!res.ok) throw new HttpError(`GET /api/appointments failed with ${res.status}`, res.status);

  return listAppointmentsResponseSchema.parse(await res.json()).appointments;
}

/** A failed agenda API call: `code` is the `{"error": "<code>"}` of the answer (`slot_taken`, `not_found`, ...), or null. */
export class ApiError extends HttpError {
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message, status);
    this.name = "ApiError";
    this.code = code;
  }
}

async function apiError(res: Response, description: string): Promise<ApiError> {
  const body = errorResponseSchema.safeParse(await res.json().catch(() => null));
  return new ApiError(`${description} failed with ${res.status}`, res.status, body.success ? body.data.error : null);
}

/** Sends one JSON request to the agenda API; any non-2xx answer becomes an `ApiError`. */
async function sendJson(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await apiError(res, `${method} ${path}`);
  return res.json();
}

/** POST /api/appointments; 404 `not_found` (service), 409 `slot_taken`, 400 `invalid_request`. */
export async function createAppointment(body: CreateAppointmentBody): Promise<AppointmentResponse> {
  return appointmentSchema.parse(await sendJson("POST", "/api/appointments", body));
}

/** PATCH /api/appointments/:id: moves it keeping its duration; 404 `not_found`, 409 `slot_taken`. */
export async function moveAppointment(id: string, body: MoveAppointmentBody): Promise<AppointmentResponse> {
  return appointmentSchema.parse(await sendJson("PATCH", `/api/appointments/${id}`, body));
}

/** POST /api/appointments/:id/cancel; 404 `not_found` when it is missing or already cancelled. */
export async function cancelAppointment(id: string): Promise<AppointmentResponse> {
  return appointmentSchema.parse(await sendJson("POST", `/api/appointments/${id}/cancel`));
}

export async function fetchServices(): Promise<ServiceResponse[]> {
  return listServicesResponseSchema.parse(await sendJson("GET", "/api/services")).services;
}

export async function createService(body: CreateServiceBody): Promise<ServiceResponse> {
  return serviceSchema.parse(await sendJson("POST", "/api/services", body));
}

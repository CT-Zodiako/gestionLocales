import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "react-router";
import { meQueryOptions } from "../lib/session.ts";

/**
 * Redirects to /login only when the API says there is no session (401); a failed
 * request shows an error with a retry button instead of logging the user out.
 */
export function RequireAuth() {
  const me = useQuery(meQueryOptions);

  if (me.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p className="text-sm text-gray-600">Cargando…</p>
      </main>
    );
  }

  if (me.isError && me.data === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p role="alert" className="text-sm text-red-600">
          No se pudo verificar la sesión. Intenta de nuevo.
        </p>
        <button
          type="button"
          onClick={() => void me.refetch()}
          disabled={me.isFetching}
          className="self-start rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
        >
          {me.isFetching ? "Reintentando…" : "Reintentar"}
        </button>
      </main>
    );
  }

  if (!me.data) return <Navigate to="/login" replace />;

  return <Outlet />;
}

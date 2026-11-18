import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "react-router";
import { meQueryOptions } from "../lib/session.ts";

/** Redirects to /login when there is no session; renders the children otherwise. */
export function RequireAuth() {
  const me = useQuery(meQueryOptions);

  if (me.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p className="text-sm text-gray-600">Cargando…</p>
      </main>
    );
  }

  if (!me.data) return <Navigate to="/login" replace />;

  return <Outlet />;
}

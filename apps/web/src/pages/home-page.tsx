import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { fetchHealth, signOut } from "../lib/api.ts";
import { meQueryKey, meQueryOptions } from "../lib/session.ts";

export function HomePage() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const me = useQuery(meQueryOptions);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      queryClient.removeQueries({ queryKey: meQueryKey });
      setIsSigningOut(false);
      await navigate("/login", { replace: true });
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Gestión de citas</h1>

      {me.data && (
        <section className="flex flex-col gap-1 text-sm">
          <p className="text-gray-600">{me.data.business.name}</p>
          <p className="font-medium">{me.data.user.name}</p>
          <p className="text-gray-600">{me.data.user.email}</p>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="mt-2 self-start rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
          >
            {isSigningOut ? "Saliendo…" : "Cerrar sesión"}
          </button>
        </section>
      )}

      <p className="text-sm text-gray-600">Estado del sistema</p>
      {health.isPending && <p>Consultando…</p>}
      {health.isError && <p className="text-red-600">No se pudo contactar la API.</p>}
      {health.data && (
        <ul className="space-y-1 text-sm">
          <li>API: {health.data.status === "ok" ? "✅ en línea" : "⚠️ degradada"}</li>
          <li>Base de datos: {health.data.database === "up" ? "✅ conectada" : "❌ sin conexión"}</li>
        </ul>
      )}
    </main>
  );
}

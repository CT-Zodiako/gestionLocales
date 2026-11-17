import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../lib/api.ts";

export function HomePage() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Gestión de citas</h1>
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

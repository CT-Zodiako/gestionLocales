import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { signOut } from "@/lib/api.ts";
import { meQueryOptions } from "@/lib/session.ts";

/** Business name and logout. Logout keeps the T2 behavior: a failure is shown and the session and cache are kept. */
export function AgendaHeader() {
  const me = useQuery(meQueryOptions);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut() {
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch {
      // Keep the session cache and stay here: the session may still be valid.
      setSignOutError("No se pudo cerrar la sesión. Intenta de nuevo.");
      setIsSigningOut(false);
      return;
    }
    // Drop every cached query, not only the session: the next owner must never see this owner's data.
    queryClient.clear();
    setIsSigningOut(false);
    await navigate("/login", { replace: true });
  }

  return (
    <header className="border-b px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-lg font-semibold">{me.data?.business.name ?? "Gestión de citas"}</h1>
        <Button
          type="button"
          variant="ghost"
          className="h-10 shrink-0 px-3"
          onClick={handleSignOut}
          disabled={isSigningOut}
        >
          <LogOut />
          {isSigningOut ? "Saliendo…" : "Cerrar sesión"}
        </Button>
      </div>
      {signOutError && (
        <p role="alert" className="pt-1 text-sm text-destructive">
          {signOutError}
        </p>
      )}
    </header>
  );
}

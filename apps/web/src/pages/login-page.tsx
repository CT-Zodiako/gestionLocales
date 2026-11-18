import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { HttpError, signIn } from "../lib/api.ts";
import { meQueryKey } from "../lib/session.ts";

const loginFormSchema = z.object({
  email: z.email("Ingresa un correo válido"),
  password: z.string().min(1, "La contraseña es obligatoria"),
});

type LoginForm = z.infer<typeof loginFormSchema>;

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginForm) {
    setFormError(null);
    try {
      await signIn(values);
      // Drop the anonymous /api/me answer so the guard fetches the new session.
      queryClient.removeQueries({ queryKey: meQueryKey });
      await navigate("/", { replace: true });
    } catch (error) {
      const rejected = error instanceof HttpError && (error.status === 400 || error.status === 401);
      setFormError(
        rejected
          ? "Correo o contraseña incorrectos."
          : "No se pudo iniciar sesión. Intenta de nuevo más tarde.",
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Iniciar sesión</h1>
      <p className="text-sm text-gray-600">Acceso del negocio</p>

      <form className="flex flex-col gap-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="email">
            Correo
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className="rounded border border-gray-300 px-3 py-2"
            {...register("email")}
          />
          {errors.email && (
            <p role="alert" className="text-sm text-red-600">
              {errors.email.message}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="password">
            Contraseña
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="rounded border border-gray-300 px-3 py-2"
            {...register("password")}
          />
          {errors.password && (
            <p role="alert" className="text-sm text-red-600">
              {errors.password.message}
            </p>
          )}
        </div>

        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {isSubmitting ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

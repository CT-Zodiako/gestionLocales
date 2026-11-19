import type { ReactNode } from "react";
import { Label } from "@/components/ui/label.tsx";

type FormFieldProps = {
  /** Id of the control; the label points at it and the error is `${id}-error`. */
  id: string;
  label: string;
  error?: string | undefined;
  children: ReactNode;
};

/** A labelled control with its validation message, announced when it appears. */
export function FormField({ id, label, error, children }: FormFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Props that tie a control to its error message. */
export function errorProps(id: string, error: string | undefined) {
  return { "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}-error` : undefined } as const;
}

/** A failure of the whole form (server answer), announced when it appears. */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

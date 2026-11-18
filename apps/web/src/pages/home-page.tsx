import { AgendaHeader } from "@/components/agenda/agenda-header.tsx";
import { AgendaToolbar } from "@/components/agenda/agenda-toolbar.tsx";
import { AgendaView } from "@/components/agenda/agenda-view.tsx";

/** App shell after login: header, date navigation and the day/week agenda. */
export function HomePage() {
  return (
    <div className="mx-auto flex h-dvh max-w-6xl flex-col">
      <AgendaHeader />
      <AgendaToolbar />
      {/* Focusable so keyboard users can scroll the grid; the ring is inset because the container clips overflow. */}
      <main
        tabIndex={0}
        aria-label="Agenda"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <AgendaView />
      </main>
    </div>
  );
}

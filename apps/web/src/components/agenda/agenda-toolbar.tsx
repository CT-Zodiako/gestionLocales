import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Toggle } from "@/components/ui/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.tsx";
import { formatRangeLabel, type AgendaView } from "@/lib/agenda-dates.ts";
import { useAgendaStore } from "@/stores/agenda-store.ts";

export function AgendaToolbar() {
  const selectedDate = useAgendaStore((state) => state.selectedDate);
  const view = useAgendaStore((state) => state.view);
  const showCancelled = useAgendaStore((state) => state.showCancelled);
  const setView = useAgendaStore((state) => state.setView);
  const setShowCancelled = useAgendaStore((state) => state.setShowCancelled);
  const goToToday = useAgendaStore((state) => state.goToToday);
  const shift = useAgendaStore((state) => state.shift);
  const unit = view === "week" ? "semana" : "día";

  return (
    <div className="flex flex-col gap-2 border-b px-3 py-2">
      <p data-testid="range-label" aria-live="polite" className="text-sm font-medium">
        {formatRangeLabel(view, selectedDate)}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            className="size-10"
            aria-label={`Anterior (${unit})`}
            onClick={() => shift(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button type="button" variant="outline" className="h-10 px-4" onClick={goToToday}>
            Hoy
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            className="size-10"
            aria-label={`Siguiente (${unit})`}
            onClick={() => shift(1)}
          >
            <ChevronRight />
          </Button>
        </div>

        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={view}
          // Radix reports "" when the pressed item is pressed again; a view is always selected.
          onValueChange={(next) => next && setView(next as AgendaView)}
          aria-label="Vista"
        >
          <ToggleGroupItem value="day" className="h-10 px-4">
            Día
          </ToggleGroupItem>
          <ToggleGroupItem value="week" className="h-10 px-4">
            Semana
          </ToggleGroupItem>
        </ToggleGroup>

        <Toggle
          variant="outline"
          className="h-10 px-3"
          pressed={showCancelled}
          onPressedChange={setShowCancelled}
        >
          Canceladas
        </Toggle>
      </div>
    </div>
  );
}

import { create } from "zustand";
import { addDays, type AgendaView, todayKey } from "@/lib/agenda-dates.ts";

/** UI state only: server data (appointments) lives in TanStack Query. */
type AgendaState = {
  /** Local date (`YYYY-MM-DD`) the agenda is anchored on; in week view the week that contains it. */
  selectedDate: string;
  view: AgendaView;
  /** Cancelled appointments are hidden unless this is on. */
  showCancelled: boolean;
  setView: (view: AgendaView) => void;
  setShowCancelled: (show: boolean) => void;
  goToToday: () => void;
  /** Moves one day (day view) or one week (week view) back (-1) or forward (1). */
  shift: (direction: -1 | 1) => void;
};

export const useAgendaStore = create<AgendaState>()((set) => ({
  selectedDate: todayKey(),
  view: "day",
  showCancelled: false,
  setView: (view) => set({ view }),
  setShowCancelled: (showCancelled) => set({ showCancelled }),
  goToToday: () => set({ selectedDate: todayKey() }),
  shift: (direction) =>
    set((state) => ({
      selectedDate: addDays(state.selectedDate, direction * (state.view === "week" ? 7 : 1)),
    })),
}));

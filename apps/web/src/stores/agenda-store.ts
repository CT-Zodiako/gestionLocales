import { create } from "zustand";
import type { AppointmentDetailResponse } from "@gestion/shared";
import { addDays, type AgendaView, todayKey, visibleRange } from "@/lib/agenda-dates.ts";

/** What the booking dialog opens with: a local date (`YYYY-MM-DD`) and an optional time (`HH:MM`, empty when none). */
type BookingPrefill = { date: string; time: string };

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
  /** Moves the agenda to a date only when it is not already visible (after a booking or a move to another day). */
  reveal: (date: string) => void;

  bookingOpen: boolean;
  bookingPrefill: BookingPrefill;
  /** The date defaults to the one the agenda shows; the time to none. */
  openBooking: (prefill?: Partial<BookingPrefill>) => void;
  closeBooking: () => void;

  detailOpen: boolean;
  /** The appointment the detail dialog was opened on; kept after closing so the dialog can finish its exit animation. */
  detailAppointment: AppointmentDetailResponse | null;
  openDetail: (appointment: AppointmentDetailResponse) => void;
  closeDetail: () => void;
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
  reveal: (date) =>
    set((state) =>
      visibleRange(state.view, state.selectedDate).days.includes(date) ? state : { selectedDate: date },
    ),

  bookingOpen: false,
  bookingPrefill: { date: todayKey(), time: "" },
  openBooking: (prefill) =>
    set((state) => ({
      bookingOpen: true,
      bookingPrefill: { date: prefill?.date ?? state.selectedDate, time: prefill?.time ?? "" },
    })),
  closeBooking: () => set({ bookingOpen: false }),

  detailOpen: false,
  detailAppointment: null,
  openDetail: (appointment) => set({ detailOpen: true, detailAppointment: appointment }),
  closeDetail: () => set({ detailOpen: false }),
}));

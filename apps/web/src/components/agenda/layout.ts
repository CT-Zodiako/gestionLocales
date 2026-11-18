import type { AppointmentDetailResponse } from "@gestion/shared";
import { minutesInDay } from "@/lib/agenda-dates.ts";

/** Hours the grid always shows (07:00 to 21:00); it grows when an appointment falls outside. */
export const DEFAULT_START_HOUR = 7;
export const DEFAULT_END_HOUR = 21;

export type PlacedBlock = {
  appointment: AppointmentDetailResponse;
  /** Minutes after midnight, clipped to the day. */
  startMin: number;
  endMin: number;
  /** Side-by-side position among overlapping blocks (only cancelled ones can overlap a booked one). */
  lane: number;
  lanes: number;
};

/** Blocks of one day, clipped to it, with lanes for the ones that overlap. */
export function placeDay(appointments: AppointmentDetailResponse[], dayKey: string): PlacedBlock[] {
  const items = appointments
    .map((appointment) => ({
      appointment,
      startMin: minutesInDay(new Date(appointment.startsAt), dayKey),
      endMin: minutesInDay(new Date(appointment.endsAt), dayKey),
    }))
    .filter((item) => item.endMin > item.startMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const placed: PlacedBlock[] = [];
  let cluster: PlacedBlock[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;

  const closeCluster = () => {
    for (const block of cluster) block.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };

  for (const item of items) {
    if (item.startMin >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.endMin;
    clusterEnd = cluster.length === 0 ? item.endMin : Math.max(clusterEnd, item.endMin);
    const block: PlacedBlock = { ...item, lane, lanes: 1 };
    cluster.push(block);
    placed.push(block);
  }
  closeCluster();
  return placed;
}

/** First and last hour (end exclusive) the grid shows for the given blocks. */
export function gridHours(blocks: PlacedBlock[]): { startHour: number; endHour: number } {
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const block of blocks) {
    startHour = Math.min(startHour, Math.floor(block.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(block.endMin / 60));
  }
  return { startHour, endHour };
}

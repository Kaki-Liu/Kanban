import type { ItemConfig, Run, Snapshot, WorkLog } from "./contracts";
import { matches } from "./time";

export type CalendarItem =
  | { kind: "actual"; run: Run }
  | { kind: "planned"; config: ItemConfig; date: string };

export interface CalendarDay {
  date: string;
  items: CalendarItem[];
  logs: WorkLog[];
}

// Dates are calendar days in the app's fixed zone; UTC arithmetic avoids the
// host time zone and daylight-saving changes when laying out the month.
export function calendarMonth(month: string): string[] {
  const first = new Date(`${month}-01T12:00:00Z`);
  if (Number.isNaN(first.valueOf())) return [];
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const start = new Date(first);
  start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  const end = new Date(last);
  end.setUTCDate(last.getUTCDate() + 6 - ((last.getUTCDay() + 6) % 7));
  const dates: string[] = [];
  for (
    const day = new Date(start);
    day <= end;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    dates.push(day.toISOString().slice(0, 10));
  return dates;
}

export function adjacentMonth(month: string, offset: number): string {
  const day = new Date(`${month}-01T12:00:00Z`);
  day.setUTCMonth(day.getUTCMonth() + offset);
  return day.toISOString().slice(0, 7);
}

export function calendarConfig(item: CalendarItem): ItemConfig {
  return item.kind === "actual" ? item.run.config : item.config;
}

export function buildCalendarDays(
  data: Pick<Snapshot, "today" | "runs" | "templates" | "logs">,
  dates: string[],
): CalendarDay[] {
  const days = new Map<string, CalendarDay>(
    dates.map((date) => [date, { date, items: [], logs: [] }]),
  );
  const existing = new Set<string>();
  for (const run of data.runs) {
    if (!days.has(run.date)) continue;
    // Withdrawn instances suppress the preview too: they are not new plans.
    existing.add(JSON.stringify([run.templateId, run.date]));
    if (run.state !== "withdrawn")
      days.get(run.date)!.items.push({ kind: "actual", run });
  }
  for (const log of data.logs) days.get(log.date)?.logs.push(log);
  for (const template of data.templates) {
    if (template.paused || template.archived) continue;
    for (const date of dates) {
      if (
        date < data.today ||
        existing.has(JSON.stringify([template.id, date])) ||
        !matches(template.config, date)
      )
        continue;
      days
        .get(date)!
        .items.push({ kind: "planned", config: template.config, date });
    }
  }
  for (const day of days.values()) {
    day.items.sort((a, b) => {
      const first = calendarConfig(a),
        second = calendarConfig(b);
      return (
        (first.schedule.time || "99:99").localeCompare(
          second.schedule.time || "99:99",
        ) || first.title.localeCompare(second.title, "zh-CN")
      );
    });
    day.logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return [...days.values()];
}

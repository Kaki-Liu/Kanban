import type { ItemConfig, Run } from "./contracts";

export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function atTime(date: string, time: string): string {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}
export function matches(config: ItemConfig, date: string): boolean {
  const s = config.schedule;
  if (s.frequency === "once") return s.date === date;
  if (date < s.start_date) return false;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  if (s.frequency === "daily") return true;
  if (s.frequency === "weekdays") return weekday <= 5;
  return s.frequency === "weekly" && s.weekdays.includes(weekday);
}
export function editable(run: Run): boolean {
  return (
    (run.state === "pending" || run.state === "withdrawn") &&
    !run.startedAt &&
    !run.manual
  );
}

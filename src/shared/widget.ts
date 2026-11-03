import { z } from "zod";
import type { Reminder, Run, Template } from "./contracts";
import { atTime, matches, today } from "./time";

export const widgetSize = {
  width: 380,
  height: 560,
  minWidth: 340,
  minHeight: 420,
  maxWidth: 560,
  maxHeight: 900,
} as const;

export const widgetPreferencesSchema = z
  .object({
    visible: z.boolean().default(false),
    pinned: z.boolean().default(true),
    bounds: z
      .object({
        x: z.number().int().min(-100000).max(100000),
        y: z.number().int().min(-100000).max(100000),
        width: z.number().int().min(1).max(widgetSize.maxWidth),
        height: z.number().int().min(1).max(widgetSize.maxHeight),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WidgetPreferences = z.infer<typeof widgetPreferencesSchema>;
export interface WidgetReminder {
  id: string;
  title: string;
  dueAt: string;
  runId?: string;
}
export interface WidgetSnapshot {
  today: string;
  checklists: Run[];
  upcoming: WidgetReminder[];
  pinned: boolean;
}

type Bounds = { x: number; y: number; width: number; height: number };
export function clampWidgetBounds(
  bounds: Bounds | undefined,
  area: Bounds,
): Bounds {
  const width = Math.min(
    area.width,
    Math.max(
      widgetSize.minWidth,
      Math.min(widgetSize.maxWidth, bounds?.width ?? widgetSize.width),
    ),
  );
  const height = Math.min(
    area.height,
    Math.max(
      widgetSize.minHeight,
      Math.min(widgetSize.maxHeight, bounds?.height ?? widgetSize.height),
    ),
  );
  return {
    x: Math.min(
      area.x + area.width - width,
      Math.max(area.x, bounds?.x ?? area.x + area.width - width - 16),
    ),
    y: Math.min(
      area.y + area.height - height,
      Math.max(area.y, bounds?.y ?? area.y + 80),
    ),
    width,
    height,
  };
}

export function widgetContent(
  templates: Template[],
  runs: Run[],
  reminders: Reminder[],
  now: Date,
): Omit<WidgetSnapshot, "pinned"> {
  const day = today(now);
  const active = templates.filter((t) => !t.paused && !t.archived);
  const activeIds = new Set(active.map((t) => t.id));
  const pending = runs.filter(
    (r) =>
      activeIds.has(r.templateId) && ["pending", "doing"].includes(r.state),
  );
  const byId = new Map(pending.map((r) => [r.id, r]));
  const upcoming: WidgetReminder[] = [];
  // Persisted reminders are authoritative, including snoozes across midnight.
  for (const reminder of reminders) {
    const run = byId.get(reminder.runId);
    if (!run || reminder.status !== "pending") continue;
    if (
      reminder.dueAt < now.toISOString() &&
      run.date !== day &&
      !reminder.snoozed
    )
      continue;
    upcoming.push({
      id: run.id,
      runId: run.id,
      title: run.config.title,
      dueAt: reminder.dueAt,
    });
  }
  const occupied = new Set(
    runs.map((r) => JSON.stringify([r.templateId, r.date])),
  );
  for (const template of active) {
    const config = template.config,
      schedule = config.schedule;
    if (!config.reminder.popup || !schedule.time) continue;
    const first =
      schedule.frequency === "once"
        ? schedule.date
        : schedule.start_date > day
          ? schedule.start_date
          : day;
    const cursor = new Date(`${first}T12:00:00Z`);
    // All supported recurrences repeat within one week; two weeks yield two occurrences.
    let projected = 0;
    for (
      let offset = 0;
      offset < (schedule.frequency === "once" ? 1 : 15) && projected < 2;
      offset++
    ) {
      const date = cursor.toISOString().slice(0, 10);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (
        !matches(config, date) ||
        occupied.has(JSON.stringify([template.id, date]))
      )
        continue;
      const dueAt = atTime(date, schedule.time);
      if (dueAt < now.toISOString()) continue;
      upcoming.push({
        id: `scheduled:${template.id}:${date}`,
        title: config.title,
        dueAt,
      });
      projected++;
    }
  }
  return {
    today: day,
    checklists: pending
      .filter((r) => r.date === day && r.config.type === "checklist")
      .sort(
        (a, b) =>
          (a.config.schedule.time ?? "99:99").localeCompare(
            b.config.schedule.time ?? "99:99",
          ) || a.id.localeCompare(b.id),
      ),
    upcoming: upcoming
      .sort(
        (a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id),
      )
      .slice(0, 2),
  };
}

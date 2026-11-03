import { z } from "zod";
import { workflowSchema, type Workflow } from "./workflow";
import type { ProjectConfigPreview } from "./project-config";
import type { WidgetSnapshot } from "./widget";
export type { WidgetSnapshot } from "./widget";

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  }, "日期不存在");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const idSchema = z.string().trim().min(1).max(200);
const textSchema = z.string().max(100000);
const scheduleSchema = z.discriminatedUnion("frequency", [
  z
    .object({
      frequency: z.literal("once"),
      date: dateSchema,
      time: timeSchema.optional(),
      timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
    })
    .strict(),
  z
    .object({
      frequency: z.enum(["daily", "weekdays"]),
      start_date: dateSchema,
      time: timeSchema.optional(),
      timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
    })
    .strict(),
  z
    .object({
      frequency: z.literal("weekly"),
      start_date: dateSchema,
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .refine((a) => new Set(a).size === a.length, "星期不能重复"),
      time: timeSchema.optional(),
      timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
    })
    .strict(),
]);
export const itemSchema = z
  .object({
    id: idSchema,
    type: z.enum(["task", "checklist"]),
    title: z.string().trim().min(1).max(200),
    project_id: idSchema.nullable().default(null),
    content_markdown: textSchema.default(""),
    owner: z.string().max(200).optional(),
    checklist: z
      .array(
        z
          .object({ id: idSchema, text: z.string().trim().min(1).max(1000) })
          .strict(),
      )
      .max(100)
      .default([]),
    schedule: scheduleSchema,
    reminder: z
      .object({
        popup: z.boolean().default(false),
        snooze_minutes: z.number().int().min(1).max(1440).default(10),
      })
      .strict()
      .default({ popup: false, snooze_minutes: 10 }),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.type === "task" && item.checklist.length)
      ctx.addIssue({
        code: "custom",
        path: ["checklist"],
        message: "普通任务不包含检查子项",
      });
    if (item.type === "checklist" && !item.checklist.length)
      ctx.addIssue({
        code: "custom",
        path: ["checklist"],
        message: "检查清单至少需要一项",
      });
    if (new Set(item.checklist.map((c) => c.id)).size !== item.checklist.length)
      ctx.addIssue({
        code: "custom",
        path: ["checklist"],
        message: "子项 id 重复",
      });
    if (item.reminder.popup && !item.schedule.time)
      ctx.addIssue({
        code: "custom",
        path: ["schedule", "time"],
        message: "弹窗提醒需要时间",
      });
  });
export const importSchema = z
  .object({
    schema_version: z.literal(1),
    items: z.array(itemSchema).min(1).max(500),
  })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.items.forEach((v, i) => {
      if (seen.has(v.id))
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "id"],
          message: "同一批次 id 重复",
        });
      seen.add(v.id);
    });
  });
export type ItemConfig = z.infer<typeof itemSchema>;
export type ImportConfig = z.infer<typeof importSchema>;
export interface Template {
  id: string;
  config: ItemConfig;
  paused: boolean;
  archived: boolean;
  noteId: string | null;
}
export type RunState =
  "pending" | "doing" | "completed" | "skipped" | "withdrawn";
export interface Run {
  id: string;
  templateId: string;
  date: string;
  config: ItemConfig;
  state: RunState;
  checks: Record<string, boolean>;
  startedAt: string | null;
  completedAt: string | null;
  changedAt: string;
  manual: boolean;
  skipReason: string;
}
export const projectSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(200),
    description: textSchema.default(""),
    owner: z.string().max(200).default(""),
    state: z
      .enum(["unstarted", "active", "paused", "completed"])
      .default("unstarted"),
    progress: z.number().min(0).max(100).default(0),
    update: textSchema.default(""),
    archived: z.boolean().default(false),
    logUpdate: z.boolean().default(false),
    workflow: workflowSchema.optional(),
  })
  .strict();
export type ProjectInput = z.input<typeof projectSchema>;
export interface Project {
  id: string;
  name: string;
  description: string;
  owner: string;
  state: "unstarted" | "active" | "paused" | "completed";
  progress: number;
  update: string;
  archived: boolean;
  workflow?: Workflow;
}
export const logSchema = z
  .object({
    id: idSchema.optional(),
    body: textSchema.trim().min(1),
    date: dateSchema,
    projectId: idSchema.nullable().default(null),
    runId: idSchema.nullable().default(null),
  })
  .strict();
export type LogInput = z.input<typeof logSchema>;
export interface WorkLog {
  id: string;
  body: string;
  date: string;
  projectId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}
export const noteSchema = z
  .object({
    id: idSchema.optional(),
    title: z.string().trim().min(1).max(200),
    body: textSchema.default(""),
    projectId: idSchema.nullable().default(null),
  })
  .strict();
export type NoteInput = z.input<typeof noteSchema>;
export interface Note {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}
export const settingsSchema = z
  .object({
    shortcut: z.string().trim().min(1).max(100),
    autoStart: z.boolean(),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export interface Reminder {
  runId: string;
  dueAt: string;
  status: "pending" | "shown" | "dismissed" | "cancelled";
  snoozed: boolean;
}
export interface Snapshot {
  today: string;
  revision: number;
  templates: Template[];
  runs: Run[];
  projects: Project[];
  logs: WorkLog[];
  notes: Note[];
  settings: Settings;
  dataPath: string;
}
export interface ImportChange {
  id: string;
  title: string;
  action: "add" | "update" | "unchanged";
  fields: string[];
  protectedCount: number;
  syncCount: number;
  warnings: string[];
}
export interface ImportPreview {
  token: string;
  changes: ImportChange[];
}
export interface BackupPreview {
  token: string;
  createdAt: string;
  counts: Record<string, number>;
}
export interface ReportEntry {
  id: string;
  date: string;
  projectId: string | null;
  title: string;
  body: string;
  kind: "completed" | "log" | "pending";
}
export interface ReportQuery {
  from: string;
  to: string;
  includePending: boolean;
}
export interface DesktopAPI {
  snapshot(): Promise<Snapshot>;
  widget: {
    get(): Promise<WidgetSnapshot>;
    show(): Promise<void>;
    setPinned(pinned: boolean): Promise<void>;
    hide(): Promise<void>;
    openMain(runId?: string): Promise<void>;
  };
  items: {
    save(config: ItemConfig, noteId?: string): Promise<void>;
    setMode(id: string, paused: boolean, archived: boolean): Promise<void>;
    check(id: string, key: string, checked: boolean): Promise<void>;
    state(
      id: string,
      state: RunState,
      result?: string,
      reason?: string,
    ): Promise<void>;
    editRun(id: string, title: string, body: string): Promise<void>;
  };
  projects: {
    previewConfig(
      text: string,
      targetId?: string,
    ): Promise<ProjectConfigPreview>;
    commitConfig(token: string): Promise<string>;
    exportConfig(id?: string): Promise<string>;
    saveConfigFile(text: string): Promise<boolean>;
    save(input: ProjectInput): Promise<void>;
    saveWorkflow(
      id: string,
      workflow: Workflow,
      expectedRevision: number,
    ): Promise<void>;
  };
  records: {
    saveLog(input: LogInput): Promise<void>;
    deleteLog(id: string): Promise<void>;
    saveNote(input: NoteInput): Promise<void>;
    deleteNote(id: string): Promise<void>;
  };
  reminders: {
    list(): Promise<Run[]>;
    dismiss(ids: string[]): Promise<void>;
    snooze(id: string): Promise<void>;
    open(id: string): Promise<void>;
  };
  imports: {
    preview(text: string): Promise<ImportPreview>;
    commit(token: string): Promise<void>;
    readFile(): Promise<string | null>;
    export(): Promise<boolean>;
  };
  reports: {
    preview(query: ReportQuery): Promise<ReportEntry[]>;
    output(
      entries: ReportEntry[],
      grouping: "date" | "project",
      save: boolean,
    ): Promise<boolean>;
  };
  backup: {
    create(): Promise<boolean>;
    preview(): Promise<BackupPreview | null>;
    restore(token: string): Promise<void>;
  };
  settings: { save(settings: Settings): Promise<void> };
  window: {
    copyText(text: string): Promise<void>;
    close(): Promise<void>;
    dirty(value: boolean): void;
    openExternal(url: string): Promise<void>;
  };
  onChange(callback: () => void): () => void;
  onOpenRun(callback: (id: string) => void): () => void;
}
export { today, atTime, matches, editable } from "./time";

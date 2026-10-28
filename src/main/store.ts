import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { workflowSchema, type Workflow } from "../shared/workflow";
import {
  atTime,
  today,
  matches,
  editable,
  importSchema,
  itemSchema,
  projectSchema,
  logSchema,
  noteSchema,
  settingsSchema,
  dateSchema,
} from "../shared/contracts";
import type {
  ItemConfig,
  Template,
  Run,
  RunState,
  Project,
  ProjectInput,
  WorkLog,
  LogInput,
  Note,
  NoteInput,
  Settings,
  Snapshot,
  ImportPreview,
  ImportConfig,
  BackupPreview,
  ReportEntry,
  ReportQuery,
  Reminder,
} from "../shared/contracts";

const APP_ID = 1262571074;
const tables: Record<string, string[]> = {
  projects: ["id", "data"],
  notes: ["id", "data", "project_id"],
  templates: ["id", "config", "paused", "archived", "note_id"],
  runs: ["id", "template_id", "day", "state", "data"],
  reminders: ["run_id", "due_at", "status", "snoozed"],
  logs: ["id", "data", "run_id", "project_id"],
  meta: ["key", "value"],
};
type Row = Record<string, any>;
function errorText(e: unknown): string {
  if (e instanceof z.ZodError)
    return e.issues
      .map((i) => `${i.path.join(".") || "配置"}: ${i.message}`)
      .join("\n");
  return e instanceof Error ? e.message : String(e);
}
function parseConfig(text: string): ImportConfig {
  try {
    return importSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(errorText(e));
  }
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Store {
  db: DatabaseSync;
  private previews = new Map<
    string,
    { config: ImportConfig; revision: number; day: string }
  >();
  private restores = new Map<
    string,
    { path: string; hash: string; revision: number }
  >();
  private busy = false;
  constructor(
    public readonly path: string,
    private clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row).user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new Error("数据版本高于此程序，请使用更新版本打开。");
    }
    if (version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE notes(id TEXT PRIMARY KEY, data TEXT NOT NULL, project_id TEXT REFERENCES projects(id));
      CREATE TABLE templates(id TEXT PRIMARY KEY, config TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, note_id TEXT REFERENCES notes(id) ON DELETE SET NULL);
      CREATE TABLE runs(id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES templates(id), day TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(template_id, day));
      CREATE TABLE reminders(run_id TEXT PRIMARY KEY REFERENCES runs(id), due_at TEXT NOT NULL, status TEXT NOT NULL, snoozed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX reminders_due ON reminders(status, due_at);
      CREATE TABLE logs(id TEXT PRIMARY KEY, data TEXT NOT NULL, run_id TEXT REFERENCES runs(id), project_id TEXT REFERENCES projects(id));
      CREATE INDEX logs_run ON logs(run_id);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES('revision','0');
      INSERT INTO meta VALUES('settings','{"shortcut":"Ctrl+Alt+J","autoStart":false}');
      PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
      COMMIT;
    `);
    if (
      Number(
        (this.db.prepare("PRAGMA application_id").get() as Row).application_id,
      ) !== APP_ID
    ) {
      this.db.close();
      throw new Error("文件不是工作看板数据库");
    }
  }
  now(): string {
    return this.clock().toISOString();
  }
  day(): string {
    return today(this.clock());
  }
  revision(): number {
    return Number(
      (
        this.db
          .prepare("SELECT value FROM meta WHERE key='revision'")
          .get() as Row
      ).value,
    );
  }
  async prepareVersion(version: string): Promise<void> {
    z.string()
      .max(100)
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
      .parse(version);
    const previous = this.db
      .prepare("SELECT value FROM meta WHERE key='app_version'")
      .get() as Row | undefined;
    if (previous?.value === version) return;
    const hasData = ["projects", "templates", "logs", "notes"].some((table) =>
      Boolean(this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()),
    );
    if (hasData) {
      const directory = join(dirname(this.path), "backups");
      mkdirSync(directory, { recursive: true });
      await this.createBackup(
        join(
          directory,
          `before-upgrade-${version}-${Date.now()}-${randomUUID().slice(0, 8)}.kanban-backup`,
        ),
      );
    }
    // Mark only after a consistent snapshot succeeds; a failed startup can safely retry.
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO meta(key,value) VALUES('app_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(version);
    });
  }
  settings(): Settings {
    return settingsSchema.parse(
      JSON.parse(
        (
          this.db
            .prepare("SELECT value FROM meta WHERE key='settings'")
            .get() as Row
        ).value,
      ),
    );
  }
  private transaction<T>(fn: () => T): T {
    if (this.busy) throw new Error("正在备份或恢复，请稍后重试。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db
        .prepare(
          "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        )
        .run();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private rows(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private entities<T>(table: string): T[] {
    return this.rows(`SELECT data FROM ${table}`).map((r) =>
      JSON.parse(r.data),
    );
  }
  templates(): Template[] {
    return this.rows("SELECT * FROM templates").map((r) => ({
      id: r.id,
      config: JSON.parse(r.config),
      paused: Boolean(r.paused),
      archived: Boolean(r.archived),
      noteId: r.note_id,
    }));
  }
  runs(): Run[] {
    return this.entities<Run>("runs");
  }
  getRun(id: string): Run {
    const r = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id) as
      Row | undefined;
    if (!r) throw new Error("事项不存在");
    return JSON.parse(r.data);
  }
  private putRun(run: Run): void {
    this.db
      .prepare(
        "INSERT INTO runs(id,template_id,day,state,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,state=excluded.state,data=excluded.data",
      )
      .run(run.id, run.templateId, run.date, run.state, JSON.stringify(run));
  }
  private projectExists(id: string | null): void {
    if (id && !this.db.prepare("SELECT id FROM projects WHERE id=?").get(id))
      throw new Error(`项目不存在：${id}`);
  }
  private validateConfig(config: ItemConfig): ItemConfig {
    const parsed = itemSchema.parse(config);
    this.projectExists(parsed.project_id);
    return parsed;
  }
  private setReminder(run: Run, reset: boolean): void {
    if (
      !run.config.reminder.popup ||
      !run.config.schedule.time ||
      !["pending", "doing"].includes(run.state)
    ) {
      this.db
        .prepare("UPDATE reminders SET status='cancelled' WHERE run_id=?")
        .run(run.id);
      return;
    }
    const due = atTime(run.date, run.config.schedule.time);
    this.db
      .prepare(
        `INSERT INTO reminders(run_id,due_at,status,snoozed) VALUES(?,?,'pending',0) ON CONFLICT(run_id) ${reset ? "DO UPDATE SET due_at=excluded.due_at,status='pending',snoozed=0" : "DO NOTHING"}`,
      )
      .run(run.id, due);
  }
  private generate(template: Template): void {
    if (template.paused || template.archived) return;
    const config = template.config;
    const day =
      config.schedule.frequency === "once" ? config.schedule.date : this.day();
    if (
      !matches(config, day) ||
      this.db
        .prepare("SELECT id FROM runs WHERE template_id=? AND day=?")
        .get(template.id, day)
    )
      return;
    const run: Run = {
      id: randomUUID(),
      templateId: template.id,
      date: day,
      config,
      state: "pending",
      checks: {},
      startedAt: null,
      completedAt: null,
      changedAt: this.now(),
      manual: false,
      skipReason: "",
    };
    this.putRun(run);
    this.setReminder(run, false);
  }
  ensureToday(): boolean {
    if (this.busy) return false;
    const missing = this.templates().filter(
      (t) =>
        !t.paused &&
        !t.archived &&
        matches(
          t.config,
          t.config.schedule.frequency === "once"
            ? t.config.schedule.date
            : this.day(),
        ) &&
        !this.db
          .prepare("SELECT id FROM runs WHERE template_id=? AND day=?")
          .get(
            t.id,
            t.config.schedule.frequency === "once"
              ? t.config.schedule.date
              : this.day(),
          ),
    );
    if (!missing.length) return false;
    this.transaction(() => missing.forEach((t) => this.generate(t)));
    return true;
  }
  snapshot(): Snapshot {
    this.ensureToday();
    return {
      today: this.day(),
      revision: this.revision(),
      templates: this.templates(),
      runs: this.runs(),
      projects: this.entities<Project>("projects"),
      logs: this.entities<WorkLog>("logs"),
      notes: this.entities<Note>("notes"),
      settings: this.settings(),
      dataPath: this.path,
    };
  }
  private apply(config: ItemConfig, noteId?: string): void {
    const old = this.templates().find((t) => t.id === config.id);
    if (old && same(old.config, config) && noteId === undefined) return;
    if (
      noteId &&
      !this.db.prepare("SELECT id FROM notes WHERE id=?").get(noteId)
    )
      throw new Error("关联笔记不存在");
    this.db
      .prepare(
        "INSERT INTO templates(id,config,note_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,note_id=COALESCE(excluded.note_id,templates.note_id)",
      )
      .run(config.id, JSON.stringify(config), noteId ?? null);
    if (old) {
      for (const run of this.runs().filter(
        (r) =>
          r.templateId === config.id && r.date >= this.day() && editable(r),
      )) {
        const valid = matches(config, run.date);
        const previousDue = run.config.schedule.time;
        const previousPopup = run.config.reminder.popup;
        const wasWithdrawn = run.state === "withdrawn";
        run.config = config;
        run.checks = {};
        run.changedAt = this.now();
        run.state = valid ? "pending" : "withdrawn";
        this.putRun(run);
        this.setReminder(
          run,
          wasWithdrawn ||
            previousDue !== config.schedule.time ||
            previousPopup !== config.reminder.popup ||
            !valid,
        );
      }
    }
    this.generate({
      id: config.id,
      config,
      paused: old?.paused ?? false,
      archived: old?.archived ?? false,
      noteId: noteId ?? old?.noteId ?? null,
    });
    if (old?.paused || old?.archived)
      this.db
        .prepare(
          "UPDATE reminders SET status='cancelled' WHERE run_id IN (SELECT id FROM runs WHERE template_id=?)",
        )
        .run(config.id);
  }
  saveItem(input: ItemConfig, noteId?: string): void {
    const config = this.validateConfig(input);
    this.transaction(() => this.apply(config, noteId));
  }
  setMode(id: string, paused: boolean, archived: boolean): void {
    const template = this.templates().find((t) => t.id === id);
    if (!template) throw new Error("配置不存在");
    this.transaction(() => {
      this.db
        .prepare("UPDATE templates SET paused=?,archived=? WHERE id=?")
        .run(+paused, +archived, id);
      if (paused || archived)
        this.db
          .prepare(
            "UPDATE reminders SET status='cancelled' WHERE run_id IN (SELECT id FROM runs WHERE template_id=?)",
          )
          .run(id);
      else {
        this.generate({ ...template, paused, archived });
        for (const r of this.runs().filter(
          (r) =>
            r.templateId === id &&
            r.date >= this.day() &&
            r.state === "pending" &&
            !r.startedAt,
        ))
          this.setReminder(r, true);
      }
    });
  }
  check(id: string, key: string, checked: boolean): void {
    this.transaction(() => {
      const r = this.getRun(id);
      if (
        !["pending", "doing"].includes(r.state) ||
        !r.config.checklist.some((c) => c.id === key)
      )
        throw new Error("无法修改此子项，请先重新打开事项");
      r.checks = { ...r.checks, [key]: checked };
      r.startedAt ||= this.now();
      r.changedAt = this.now();
      this.putRun(r);
    });
  }
  state(id: string, state: RunState, result = "", reason = ""): void {
    if (!["pending", "doing", "completed", "skipped"].includes(state))
      throw new Error("无效状态");
    this.transaction(() => {
      const r = this.getRun(id);
      if (r.state === "withdrawn") throw new Error("此事项已由配置更新撤销");
      if (r.state === state) return;
      if (state === "doing" && r.config.type !== "task")
        throw new Error("检查清单没有进行中列");
      const reopening =
        ["completed", "skipped"].includes(r.state) &&
        ["pending", "doing"].includes(state);
      r.state = state;
      r.startedAt ||= this.now();
      r.changedAt = this.now();
      r.completedAt = state === "completed" ? this.now() : null;
      r.skipReason = state === "skipped" ? reason : "";
      this.putRun(r);
      if (["completed", "skipped"].includes(state) || reopening)
        this.db
          .prepare("UPDATE reminders SET status='cancelled' WHERE run_id=?")
          .run(id);
      if (result.trim())
        this.putLog({
          body: result,
          date: this.day(),
          projectId: r.config.project_id,
          runId: r.id,
        });
    });
  }
  editRun(id: string, title: string, body: string): void {
    z.string().trim().min(1).max(200).parse(title);
    z.string().max(100000).parse(body);
    this.transaction(() => {
      const r = this.getRun(id);
      r.config = { ...r.config, title: title.trim(), content_markdown: body };
      r.manual = true;
      r.changedAt = this.now();
      this.putRun(r);
    });
  }
  saveProject(input: ProjectInput): void {
    const parsed = projectSchema.parse(input);
    this.transaction(() => {
      const { logUpdate, ...p } = parsed;
      const project: Project = { ...p, id: p.id || randomUUID() };
      const oldRow = this.db
        .prepare("SELECT data FROM projects WHERE id=?")
        .get(project.id) as Row | undefined;
      const old: Project | undefined = oldRow
        ? JSON.parse(oldRow.data)
        : undefined;
      if (old) {
        if (
          p.workflow &&
          !same(
            p.workflow,
            old.workflow ? workflowSchema.parse(old.workflow) : undefined,
          )
        )
          throw new Error("开发流程已变化，请在开发流程页面刷新后保存");
        project.workflow = old.workflow;
      }
      if (!old && project.workflow) this.markWorkflowStarted(project.workflow);
      this.db
        .prepare(
          "INSERT INTO projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(project.id, JSON.stringify(project));
      if (!old && project.workflow)
        this.recordWorkflowCompletions(project.id, project.workflow);
      if (logUpdate && project.update.trim())
        this.putLog({
          body: project.update,
          date: this.day(),
          projectId: project.id,
        });
    });
  }
  saveWorkflow(
    projectId: string,
    input: Workflow,
    expectedRevision: number,
  ): void {
    z.string().min(1).max(200).parse(projectId);
    z.number().int().nonnegative().parse(expectedRevision);
    const workflow = workflowSchema.parse(input);
    this.transaction(() => {
      if (expectedRevision !== this.revision())
        throw new Error("数据已变化，请刷新后重新检查草稿再保存");
      const row = this.db
        .prepare("SELECT data FROM projects WHERE id=?")
        .get(projectId) as Row | undefined;
      if (!row) throw new Error("项目不存在");
      const project: Project = JSON.parse(row.data);
      const previous = project.workflow;
      this.markWorkflowStarted(workflow, previous);
      project.workflow = workflow;
      this.db
        .prepare("UPDATE projects SET data=? WHERE id=?")
        .run(JSON.stringify(project), projectId);
      this.recordWorkflowCompletions(projectId, workflow, previous);
    });
  }
  private markWorkflowStarted(workflow: Workflow, previous?: Workflow): void {
    const oldTasks = new Map(previous?.tasks.map((task) => [task.id, task]));
    const started = (task: Workflow["tasks"][number] | undefined): boolean =>
      Boolean(
        task &&
        (task.hasStarted ||
          task.state !== "todo" ||
          task.evidence.trim() ||
          task.blocker.trim() ||
          task.handoff.status !== "draft"),
      );
    for (const task of workflow.tasks) {
      task.hasStarted = started(task) || started(oldTasks.get(task.id));
    }
  }
  private recordWorkflowCompletions(
    projectId: string,
    workflow: Workflow,
    previous?: Workflow,
  ): void {
    for (const task of workflow.tasks) {
      if (task.state !== "done") continue;
      const oldTask = previous?.tasks.find((entry) => entry.id === task.id);
      if (
        oldTask?.state === "done" &&
        oldTask.title === task.title &&
        oldTask.evidence === task.evidence
      )
        continue;
      // One stable work-log entry survives reopen/recomplete and avoids duplicate report material.
      const logId = `workflow-${createHash("sha256")
        .update(JSON.stringify([projectId, task.id]))
        .digest("hex")}`;
      const oldRow = this.db
        .prepare("SELECT data FROM logs WHERE id=?")
        .get(logId) as Row | undefined;
      const old: WorkLog | undefined = oldRow
        ? JSON.parse(oldRow.data)
        : undefined;
      const log: WorkLog = {
        id: logId,
        body: `完成开发任务：${task.title}\n\n${task.evidence}`,
        date: oldTask?.state === "done" && old ? old.date : this.day(),
        projectId,
        runId: null,
        createdAt: old?.createdAt || this.now(),
        updatedAt: this.now(),
      };
      this.db
        .prepare(
          "INSERT INTO logs(id,data,run_id,project_id) VALUES(?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(log.id, JSON.stringify(log), projectId);
    }
  }
  private putLog(input: LogInput): void {
    const parsed = logSchema.parse(input);
    this.projectExists(parsed.projectId);
    const old = parsed.id
      ? this.entities<WorkLog>("logs").find((l) => l.id === parsed.id)
      : undefined;
    if (parsed.id && !old) throw new Error("工作流水不存在");
    if (parsed.runId) {
      const run = this.getRun(parsed.runId);
      run.startedAt ||= this.now();
      this.putRun(run);
    }
    const log: WorkLog = {
      ...parsed,
      id: parsed.id || randomUUID(),
      createdAt: old?.createdAt || this.now(),
      updatedAt: this.now(),
    };
    this.db
      .prepare(
        "INSERT INTO logs(id,data,run_id,project_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,run_id=excluded.run_id,project_id=excluded.project_id",
      )
      .run(log.id, JSON.stringify(log), log.runId, log.projectId);
  }
  saveLog(input: LogInput): void {
    this.transaction(() => this.putLog(input));
  }
  deleteLog(id: string): void {
    this.transaction(() =>
      this.db.prepare("DELETE FROM logs WHERE id=?").run(id),
    );
  }
  saveNote(input: NoteInput): void {
    const parsed = noteSchema.parse(input);
    this.projectExists(parsed.projectId);
    const old = parsed.id
      ? this.entities<Note>("notes").find((n) => n.id === parsed.id)
      : undefined;
    if (parsed.id && !old) throw new Error("笔记不存在");
    const note: Note = {
      ...parsed,
      id: parsed.id || randomUUID(),
      createdAt: old?.createdAt || this.now(),
      updatedAt: this.now(),
    };
    this.transaction(() =>
      this.db
        .prepare(
          "INSERT INTO notes(id,data,project_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,project_id=excluded.project_id",
        )
        .run(note.id, JSON.stringify(note), note.projectId),
    );
  }
  deleteNote(id: string): void {
    this.transaction(() =>
      this.db.prepare("DELETE FROM notes WHERE id=?").run(id),
    );
  }
  saveSettings(input: Settings): void {
    const settings = settingsSchema.parse(input);
    this.transaction(() =>
      this.db
        .prepare("UPDATE meta SET value=? WHERE key='settings'")
        .run(JSON.stringify(settings)),
    );
  }
  reminders(): Reminder[] {
    return this.rows("SELECT * FROM reminders").map((r) => ({
      runId: r.run_id,
      dueAt: r.due_at,
      status: r.status,
      snoozed: Boolean(r.snoozed),
    }));
  }
  dueReminders(): Run[] {
    const templates = this.templates();
    return this.reminders()
      .filter((r) => r.status === "pending" && r.dueAt <= this.now())
      .map((r) => ({ reminder: r, run: this.getRun(r.runId) }))
      .filter(
        ({ reminder, run }) =>
          ["pending", "doing"].includes(run.state) &&
          (run.date === this.day() || reminder.snoozed) &&
          templates.some(
            (t) => t.id === run.templateId && !t.paused && !t.archived,
          ),
      )
      .map((r) => r.run);
  }
  markShown(ids: string[]): void {
    if (ids.length)
      this.transaction(() =>
        ids.forEach((id) =>
          this.db
            .prepare(
              "UPDATE reminders SET status='shown' WHERE run_id=? AND status='pending'",
            )
            .run(id),
        ),
      );
  }
  dismiss(ids: string[]): void {
    if (ids.length)
      this.transaction(() =>
        ids.forEach((id) =>
          this.db
            .prepare(
              "UPDATE reminders SET status='dismissed' WHERE run_id=? AND status='shown'",
            )
            .run(id),
        ),
      );
  }
  snooze(id: string): void {
    this.transaction(() => {
      const r = this.getRun(id);
      const template = this.templates().find((t) => t.id === r.templateId);
      if (
        !["pending", "doing"].includes(r.state) ||
        !template ||
        template.paused ||
        template.archived
      )
        throw new Error("此事项当前无法稍后提醒");
      r.manual = true;
      this.putRun(r);
      this.db
        .prepare(
          "INSERT INTO reminders(run_id,due_at,status,snoozed) VALUES(?,?,'pending',1) ON CONFLICT(run_id) DO UPDATE SET due_at=excluded.due_at,status='pending',snoozed=1",
        )
        .run(
          id,
          new Date(
            this.clock().valueOf() + r.config.reminder.snooze_minutes * 60000,
          ).toISOString(),
        );
    });
  }
  previewImport(text: string): ImportPreview {
    const config = parseConfig(text);
    config.items.forEach((c, i) => {
      try {
        this.projectExists(c.project_id);
      } catch (e) {
        throw new Error(`items.${i}.project_id: ${errorText(e)}`);
      }
    });
    const templates = this.templates(),
      runs = this.runs();
    const changes = config.items.map((c) => {
      const old = templates.find((t) => t.id === c.id);
      const fields = old
        ? Object.keys(c).filter(
            (k) =>
              !same(
                old.config[k as keyof ItemConfig],
                c[k as keyof ItemConfig],
              ),
          )
        : [];
      const affected = runs.filter(
        (r) => r.templateId === c.id && r.date >= this.day(),
      );
      const warnings: string[] = [];
      if (c.schedule.frequency === "once" && c.schedule.date < this.day())
        warnings.push("过去日期：显示逾期，不补弹提醒");
      if (old?.paused || old?.archived)
        warnings.push("配置仍处于暂停或归档状态");
      if (old)
        for (const key of fields)
          if (
            c[key as keyof ItemConfig] === null ||
            c[key as keyof ItemConfig] === ""
          )
            warnings.push(`${key} 将被清空`);
      return {
        id: c.id,
        title: c.title,
        action: !old
          ? ("add" as const)
          : fields.length
            ? ("update" as const)
            : ("unchanged" as const),
        fields,
        protectedCount: affected.filter((r) => !editable(r)).length,
        syncCount: affected.filter(editable).length,
        warnings,
      };
    });
    this.previews.clear();
    const token = randomUUID();
    this.previews.set(token, {
      config,
      revision: this.revision(),
      day: this.day(),
    });
    return { token, changes };
  }
  commitImport(token: string): void {
    const p = this.previews.get(token);
    if (!p || p.revision !== this.revision() || p.day !== this.day())
      throw new Error("预览已过期，数据或日期发生变化，请重新预览。");
    p.config.items.forEach((c) => this.validateConfig(c));
    this.transaction(() => p.config.items.forEach((c) => this.apply(c)));
    this.previews.clear();
  }
  exportConfig(): string {
    return JSON.stringify(
      { schema_version: 1, items: this.templates().map((t) => t.config) },
      null,
      2,
    );
  }
  report(query: ReportQuery): ReportEntry[] {
    dateSchema.parse(query.from);
    dateSchema.parse(query.to);
    if (query.to < query.from) throw new Error("结束日期不能早于开始日期");
    const range = (date: string) => date >= query.from && date <= query.to;
    const logs = this.entities<WorkLog>("logs").filter((l) => range(l.date));
    const runs = this.runs().filter(
      (r) =>
        (r.state === "completed" &&
          r.completedAt &&
          range(today(new Date(r.completedAt)))) ||
        (query.includePending &&
          ["pending", "doing"].includes(r.state) &&
          range(r.date)),
    );
    const entries: ReportEntry[] = runs.map((r) => ({
      id: `run:${r.id}`,
      date: r.completedAt ? today(new Date(r.completedAt)) : r.date,
      projectId: r.config.project_id,
      title: r.config.title,
      body: logs
        .filter((l) => l.runId === r.id)
        .map((l) => `${l.date}：${l.body}`)
        .join("\n\n"),
      kind: r.state === "completed" ? "completed" : "pending",
    }));
    for (const l of logs)
      if (!runs.some((r) => r.id === l.runId))
        entries.push({
          id: `log:${l.id}`,
          date: l.date,
          projectId: l.projectId,
          title: "工作记录",
          body: l.body,
          kind: "log",
        });
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }
  reportMarkdown(entries: ReportEntry[], grouping: "date" | "project"): string {
    const projects = this.entities<Project>("projects");
    const groups = new Map<string, ReportEntry[]>();
    for (const e of entries) {
      const key =
        grouping === "date"
          ? e.date
          : projects.find((p) => p.id === e.projectId)?.name || "未关联项目";
      groups.set(key, [...(groups.get(key) || []), e]);
    }
    return (
      "# 工作汇报素材\n\n" +
      [...groups]
        .map(
          ([group, items]) =>
            `## ${group}\n\n` +
            items
              .map(
                (e) =>
                  `### ${e.title}\n\n${e.date} · ${projects.find((p) => p.id === e.projectId)?.name || "未关联项目"} · ${{ completed: "已完成", pending: "待跟进", log: "工作流水" }[e.kind]}\n\n${e.body || (e.kind === "completed" ? "已记录完成。" : "待跟进。")}\n`,
              )
              .join("\n"),
        )
        .join("\n")
    );
  }
  async createBackup(path: string): Promise<void> {
    if (this.busy) throw new Error("数据操作正在进行");
    const canonical = (p: string) => {
      const full = existsSync(p) ? realpathSync(p) : resolve(p);
      return process.platform === "win32" ? full.toLowerCase() : full;
    };
    if (canonical(path) === canonical(this.path))
      throw new Error("备份不能覆盖当前数据库");
    this.busy = true;
    try {
      await backup(this.db, path);
      const copy = new DatabaseSync(path);
      try {
        copy
          .prepare(
            "INSERT INTO meta(key,value) VALUES('backup_created',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(this.now());
        copy.exec(
          "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;",
        );
      } finally {
        copy.close();
      }
    } finally {
      this.busy = false;
    }
  }
  private inspectBackup(path: string): {
    createdAt: string;
    counts: Record<string, number>;
    data: Record<string, Row[]>;
  } {
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
      copy.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN;");
      if (
        Number(
          (copy.prepare("PRAGMA application_id").get() as Row).application_id,
        ) !== APP_ID ||
        Number(
          (copy.prepare("PRAGMA user_version").get() as Row).user_version,
        ) !== 1
      )
        throw new Error("备份格式或版本不兼容");
      if (
        (copy.prepare("PRAGMA integrity_check").get() as Row)
          .integrity_check !== "ok" ||
        copy.prepare("PRAGMA foreign_key_check").all().length
      )
        throw new Error("备份完整性检查失败");
      const schema = copy
        .prepare(
          "SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger')",
        )
        .all() as Row[];
      if (
        schema.length !== Object.keys(tables).length ||
        schema.some((r) => r.type !== "table" || !tables[r.name])
      )
        throw new Error("备份含不支持的表结构");
      const data: Record<string, Row[]> = {},
        counts: Record<string, number> = {};
      for (const [table, columns] of Object.entries(tables)) {
        if (
          !same(
            (copy.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(
              (r) => r.name,
            ),
            columns,
          )
        )
          throw new Error("备份列结构不兼容");
        data[table] = copy
          .prepare(`SELECT ${columns.join(",")} FROM ${table}`)
          .all() as Row[];
        counts[table] = data[table].length;
      }
      const projectIds = new Set(data.projects.map((p) => p.id));
      const hasProject = (value: string | null) =>
        value === null || projectIds.has(value);
      for (const row of data.templates) {
        const c = itemSchema.parse(JSON.parse(row.config));
        if (c.id !== row.id || !hasProject(c.project_id))
          throw new Error("配置标识或关联项目损坏");
      }
      for (const row of data.projects) {
        const p = JSON.parse(row.data);
        projectSchema.parse(p);
        if (p.id !== row.id) throw new Error("项目标识损坏");
      }
      for (const row of data.notes) {
        const n = JSON.parse(row.data);
        noteSchema.parse({
          id: n.id,
          title: n.title,
          body: n.body,
          projectId: n.projectId,
        });
        if (n.id !== row.id || n.projectId !== row.project_id)
          throw new Error("笔记标识损坏");
      }
      for (const row of data.logs) {
        const l = JSON.parse(row.data);
        logSchema.parse({
          id: l.id,
          body: l.body,
          date: l.date,
          projectId: l.projectId,
          runId: l.runId,
        });
        if (
          l.id !== row.id ||
          l.runId !== row.run_id ||
          l.projectId !== row.project_id
        )
          throw new Error("流水标识损坏");
      }
      for (const row of data.runs) {
        const r = JSON.parse(row.data);
        itemSchema.parse(r.config);
        dateSchema.parse(r.date);
        z.record(z.string(), z.boolean()).parse(r.checks);
        z.boolean().parse(r.manual);
        z.string().datetime().parse(r.changedAt);
        z.string().datetime().nullable().parse(r.startedAt);
        z.string().datetime().nullable().parse(r.completedAt);
        if (
          r.id !== row.id ||
          r.templateId !== row.template_id ||
          r.date !== row.day ||
          r.state !== row.state ||
          !hasProject(r.config.project_id) ||
          !["pending", "doing", "completed", "skipped", "withdrawn"].includes(
            r.state,
          ) ||
          (r.state === "completed" && !r.completedAt)
        )
          throw new Error("执行记录损坏");
      }
      for (const row of data.reminders) {
        z.string().datetime().parse(row.due_at);
        z.enum(["pending", "shown", "dismissed", "cancelled"]).parse(
          row.status,
        );
        if (row.snoozed !== 0 && row.snoozed !== 1)
          throw new Error("提醒状态损坏");
      }
      const settings = data.meta.find((r) => r.key === "settings");
      if (!settings) throw new Error("备份缺少设置");
      settingsSchema.parse(JSON.parse(settings.value));
      if (!data.meta.some((r) => r.key === "revision" && /^\d+$/.test(r.value)))
        throw new Error("备份缺少数据版本");
      return {
        createdAt:
          data.meta.find((r) => r.key === "backup_created")?.value || "未知",
        counts,
        data,
      };
    } finally {
      copy.close();
    }
  }
  previewBackup(path: string): BackupPreview {
    const inspected = this.inspectBackup(path);
    const token = randomUUID();
    this.restores.clear();
    this.restores.set(token, {
      path,
      hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
      revision: this.revision(),
    });
    return { token, createdAt: inspected.createdAt, counts: inspected.counts };
  }
  async restoreBackup(token: string): Promise<void> {
    const preview = this.restores.get(token);
    if (!preview || preview.revision !== this.revision())
      throw new Error("恢复预览已过期，请重新选择备份");
    if (
      preview.hash !==
      createHash("sha256").update(readFileSync(preview.path)).digest("hex")
    )
      throw new Error("备份文件已变化，请重新预览");
    const { data } = this.inspectBackup(preview.path);
    const previousRevision = this.revision();
    const backupDir = join(dirname(this.path), "backups");
    mkdirSync(backupDir, { recursive: true });
    await this.createBackup(
      join(backupDir, `before-restore-${Date.now()}.kanban-backup`),
    );
    this.transaction(() => {
      for (const table of [
        "logs",
        "reminders",
        "runs",
        "templates",
        "notes",
        "projects",
        "meta",
      ])
        this.db.exec(`DELETE FROM ${table}`);
      for (const [table, cols] of Object.entries(tables)) {
        const insert = this.db.prepare(
          `INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
        );
        for (const row of data[table]) insert.run(...cols.map((c) => row[c]));
      }
      this.db
        .prepare("UPDATE meta SET value=? WHERE key='revision'")
        .run(String(previousRevision));
      if (this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("恢复后关联检查失败");
    });
    this.previews.clear();
    this.restores.clear();
  }
  close(): void {
    this.db.close();
  }
}

/** Differential migration check. All databases and backups are isolated temporary files. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/main/store";
import { itemSchema } from "../src/shared/contracts";
import { createWorkflow } from "../src/shared/workflow-templates";

async function main() {
  const executable =
    process.env.KANBAN_STORE_PROBE ||
    ["src-tauri/target/debug/store-probe.exe", "src-tauri/target/x86_64-pc-windows-gnu/debug/store-probe.exe", "src-tauri/target/x86_64-pc-windows-msvc/debug/store-probe.exe"].map((p) => resolve(p)).find(existsSync);
  if (!executable) throw new Error("请先运行 npm run test:harness，或设置 KANBAN_STORE_PROBE。");
  const directory = mkdtempSync(join(tmpdir(), "kanban-rust-parity-"));
  let now = new Date("2026-11-03T01:00:00Z");
  let ts = new Store(join(directory, "electron.db"), () => now);
  const child = spawn(executable, [join(directory, "rust.db")], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const responses: Array<{
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const next = responses.shift();
    if (!next) return;
    try {
      const result = JSON.parse(line);
      result.ok
        ? next.resolve(result.value)
        : next.reject(new Error(result.error));
    } catch (error) {
      next.reject(error as Error);
    }
  });
  child.on("error", (error) => {
    for (const pending of responses.splice(0)) pending.reject(error);
  });
  child.on("exit", (code) => {
    for (const pending of responses.splice(0))
      pending.reject(new Error(`Rust probe exit ${code}: ${diagnostics}`));
  });
  const rust = (channel: string, args: unknown[] = []) =>
    new Promise<any>((resolve, reject) => {
      responses.push({ resolve, reject });
      child.stdin.write(
        JSON.stringify({ channel, args, now: now.toISOString() }) + "\n",
      );
    });
  const tsCall = async (channel: string, a: any[]) => {
    switch (channel) {
      case "items.save":
        return ts.saveItem(a[0]);
      case "items.check":
        return ts.check(a[0], a[1], a[2]);
      case "items.state":
        return ts.state(a[0], a[1], a[2], a[3]);
      case "items.mode":
        return ts.setMode(a[0], a[1], a[2]);
      case "items.edit":
        return ts.editRun(a[0], a[1], a[2]);
      case "logs.save":
        return ts.saveLog(a[0]);
      case "notes.save":
        return ts.saveNote(a[0]);
      case "projects.save":
        return ts.saveProject(a[0]);
      case "projects.workflow":
        return ts.saveWorkflow(a[0], a[1], a[2]);
      case "reminders.snooze":
        return ts.snooze(a[0]);
      default:
        throw new Error(`Missing reference adapter ${channel}`);
    }
  };
  const both = async (channel: string, args: unknown[], rustArgs = args) => {
    await tsCall(channel, args);
    await rust(channel, rustArgs);
  };
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : value;
  // UUIDs differ by implementation. Stable domain identity replaces IDs only;
  // every timestamp, status, check, revision, content and association is retained.
  const normalized = (snapshot: any) => {
    const copy = structuredClone(snapshot);
    const ids = new Map<string, string>();
    for (const run of copy.runs)
      ids.set(run.id, `run:${run.templateId}:${run.date}`);
    for (const [index, log] of copy.logs.entries())
      if (!log.id.startsWith("workflow-")) ids.set(log.id, `log:${index}`);
    for (const [index, note] of copy.notes.entries())
      ids.set(note.id, `note:${index}`);
    const rewrite = (value: any): any =>
      typeof value === "string" && ids.has(value)
        ? ids.get(value)
        : Array.isArray(value)
          ? value.map(rewrite)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, v]) => [key, rewrite(v)]),
              )
            : value;
    const result = rewrite(copy);
    result.dataPath = "<isolated database>";
    for (const field of ["runs", "templates", "projects", "logs", "notes"])
      result[field].sort((a: any, b: any) => a.id.localeCompare(b.id));
    return canonical(result);
  };
  let checks = 0;
  const equal = async (label: string) => {
    const left = ts.snapshot(),
      right = await rust("snapshot");
    assert.deepEqual(normalized(right), normalized(left), label);
    checks++;
    process.stdout.write(`PASS ${label}\n`);
    return { left, right };
  };
  const routine = (title = "每日运维检查") =>
    itemSchema.parse({
      id: "routine",
      type: "checklist",
      title,
      checklist: [
        { id: "service", text: "检查服务" },
        { id: "alerts", text: "确认告警" },
      ],
      schedule: {
        frequency: "weekdays",
        start_date: "2026-11-03",
        time: "09:30",
      },
      reminder: { popup: true, snooze_minutes: 10 },
    });
  try {
    await equal("empty compatible schema");
    await both("projects.save", [
      { id: "ops", name: "运维工具", owner: "张工", progress: 25 },
    ]);
    await both("items.save", [routine()]);
    await both("notes.save", [
      { title: "私人备忘", body: "不进入汇报", projectId: "ops" },
    ]);
    let pair = await equal("project, recurring task and private note");
    await both("items.save", [routine("同步未开始检查")]);
    pair = await equal("unstarted instance update");
    await both(
      "items.check",
      [pair.left.runs[0].id, "service", true],
      [pair.right.runs[0].id, "service", true],
    );
    await both(
      "items.check",
      [pair.left.runs[0].id, "service", false],
      [pair.right.runs[0].id, "service", false],
    );
    await both("items.save", [routine("保留已操作快照")]);
    pair = await equal("sticky started state and protected snapshot");
    await both(
      "items.state",
      [pair.left.runs[0].id, "completed", "服务正常"],
      [pair.right.runs[0].id, "completed", "服务正常"],
    );
    await both("logs.save", [
      { body: "补记昨天的工作", date: "2026-11-02", projectId: "ops" },
    ]);
    pair = await equal("completion result and attributed-date log");
    const query = {
      from: "2026-11-01",
      to: "2026-11-03",
      includePending: true,
    };
    const leftReport = ts.report(query),
      rightReport = await rust("reports.preview", [query]);
    assert.deepEqual(
      canonical(rightReport.map(({ id, ...entry }: any) => entry)),
      canonical(leftReport.map(({ id, ...entry }) => entry)),
    );
    checks++;
    process.stdout.write(
      "PASS report result association and notes exclusion\n",
    );
    await both(
      "items.state",
      [pair.left.runs[0].id, "pending"],
      [pair.right.runs[0].id, "pending"],
    );
    await equal("reopening completed record");
    now = new Date("2026-11-06T15:55:00Z");
    pair = await equal("only current day generated after offline gap");
    const leftRun = pair.left.runs.find((r) => r.date === "2026-11-06")!,
      rightRun = pair.right.runs.find((r: any) => r.date === "2026-11-06");
    await both("reminders.snooze", [leftRun.id], [rightRun.id]);
    now = new Date("2026-11-07T00:01:00Z");
    await equal("cross-day snooze and no weekend instances");
    const leftWidget = ts.widgetSnapshot(),
      rightWidget = await rust("widget.get");
    assert.deepEqual(
      rightWidget.upcoming.map(({ id, runId, ...r }: any) => r),
      leftWidget.upcoming.map(({ id, runId, ...r }) => r),
    );
    checks++;
    process.stdout.write("PASS next reminders use snooze and weekday rules\n");
    await both("items.mode", ["routine", true, false]);
    now = new Date("2026-11-09T01:00:00Z");
    await equal("paused template skips generation");
    await both("items.mode", ["routine", false, false]);
    await equal("resume generates only current day");
    const config = JSON.stringify({
      schema_version: 1,
      items: [routine("Agent 修改例行检查")],
    });
    const leftPreview = ts.previewImport(config),
      rightPreview = await rust("imports.preview", [config]);
    assert.deepEqual(
      canonical(rightPreview.changes),
      canonical(leftPreview.changes),
    );
    ts.commitImport(leftPreview.token);
    await rust("imports.commit", [rightPreview.token]);
    await equal("batch import updates unstarted and protects history");
    const workflow = createWorkflow("kanban");
    workflow.goal = "稳定交付运维工具";
    const revision = ts.snapshot().revision;
    await both("projects.workflow", ["ops", workflow, revision]);
    await equal("existing project development workflow");
    const projectConfig = JSON.stringify({
      schema_version: 1,
      kind: "kanban-project",
      project: { id: "ops", name: "新的运维工具", progress: 50 },
    });
    const lp = ts.previewProjectConfig(projectConfig),
      rp = await rust("projects.config.preview", [projectConfig]);
    ts.commitProjectConfig(lp.token);
    await rust("projects.config.commit", [rp.token]);
    await equal("full project config retains omitted workflow");
    const oldBackup = join(directory, "electron.kanban-backup"),
      rustBackup = join(directory, "rust.kanban-backup");
    await ts.createBackup(oldBackup);
    await rust("backup.create", [rustBackup]);
    await both("logs.save", [{ body: "恢复前临时记录", date: "2026-11-09" }]);
    const oldRestore = ts.previewBackup(rustBackup),
      rustRestore = await rust("backup.preview", [oldBackup]);
    await ts.restoreBackup(oldRestore.token);
    await rust("backup.restore", [rustRestore.token]);
    await equal("cross-engine backup restore compatibility");
    ts.close();
    ts = new Store(join(directory, "electron.db"), () => now);
    await equal("reopen reference database without content loss");
    process.stdout.write(
      `Rust/Electron parity: ${checks} checkpoints passed.\n`,
    );
  } finally {
    ts.close();
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else {
        child.once("exit", () => resolve());
        setTimeout(() => {
          child.kill();
          resolve();
        }, 3000).unref();
      }
    });
    reader.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + "kanban-rust-parity-"))
      throw new Error("拒绝清理隔离测试目录以外的路径");
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/main/store";
import { workflowSchema } from "../../src/shared/workflow";
import type { DesktopAPI } from "../../src/shared/contracts";

test("旧版本本地数据升级备份、开发流程保存与同版本重启", async () => {
  test.setTimeout(90000);
  const dataDir = mkdtempSync(join(tmpdir(), "kanban-workflow-upgrade-"));
  const databasePath = join(dataDir, "kanban.db");
  const projectId = "legacy-project";
  const errors: string[] = [];
  let application: ElectronApplication | undefined;

  const stop = async () => {
    if (!application) return;
    const instance = application;
    application = undefined;
    await instance.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await instance.close().catch(() => {});
  };
  const launch = async (): Promise<Page> => {
    application = await electron.launch({
      executablePath:
        process.env.KANBAN_TEST_EXE || (require("electron") as string),
      args: process.env.KANBAN_TEST_EXE ? [] : ["."],
      env: {
        ...process.env,
        KANBAN_DATA_DIR: dataDir,
        KANBAN_E2E: "1",
      },
    });
    await application.firstWindow();
    await expect
      .poll(() =>
        application!
          .windows()
          .some((window) => window.url().includes("window=main")),
      )
      .toBe(true);
    const page = application
      .windows()
      .find((window) => window.url().includes("window=main"))!;
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "今天，把事情一件件做好" }),
    ).toBeVisible();
    return page;
  };
  const backupFiles = () =>
    readdirSync(join(dataDir, "backups")).filter(
      (name) =>
        name.startsWith("before-upgrade-") && name.endsWith(".kanban-backup"),
    );

  try {
    const seed = new Store(
      databasePath,
      () => new Date("2026-10-28T02:00:00Z"),
    );
    let originalProjectJSON: string;
    let originalLogs: ReturnType<Store["snapshot"]>["logs"];
    let originalNotes: ReturnType<Store["snapshot"]>["notes"];
    try {
      seed.saveProject({ id: projectId, name: "旧版运维项目", progress: 35 });
      seed.saveLog({
        body: "旧版保留的工作流水",
        date: "2026-10-28",
        projectId,
      });
      seed.saveNote({ title: "旧版个人笔记", body: "原有私人内容", projectId });
      const original = seed.snapshot();
      originalLogs = original.logs;
      originalNotes = original.notes;
      expect(original.projects[0].workflow).toBeUndefined();
      expect(
        seed.db.prepare("SELECT value FROM meta WHERE key='app_version'").get(),
      ).toBeUndefined();
      originalProjectJSON = (
        seed.db
          .prepare("SELECT data FROM projects WHERE id=?")
          .get(projectId) as { data: string }
      ).data;
    } finally {
      seed.close();
    }

    let page = await launch();
    const first = await page.evaluate(() =>
      (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
    );
    expect(first.projects).toHaveLength(1);
    expect(first.projects[0]).toMatchObject({
      id: projectId,
      name: "旧版运维项目",
      progress: 35,
    });
    expect(first.projects[0].workflow).toBeUndefined();
    expect(first.logs).toEqual(originalLogs);
    expect(first.notes).toEqual(originalNotes);

    const backups = backupFiles();
    expect(backups).toHaveLength(1);
    const copy = new DatabaseSync(join(dataDir, "backups", backups[0]), {
      readOnly: true,
    });
    try {
      expect(
        (
          copy
            .prepare("SELECT data FROM projects WHERE id=?")
            .get(projectId) as { data: string }
        ).data,
      ).toBe(originalProjectJSON);
      expect(
        copy.prepare("SELECT value FROM meta WHERE key='app_version'").get(),
      ).toBeUndefined();
      expect(copy.prepare("SELECT count(*) AS count FROM logs").get()).toEqual({
        count: 1,
      });
      expect(copy.prepare("SELECT count(*) AS count FROM notes").get()).toEqual(
        { count: 1 },
      );
    } finally {
      copy.close();
    }

    const workflow = workflowSchema.parse({
      mode: "kanban",
      goal: "持续改进值班工具",
      tasks: [
        { id: "development-task", title: "完成升级后试用", state: "doing" },
      ],
    });
    const afterSave = await page.evaluate(
      async ({ id, value }) => {
        const api = (window as unknown as { kanban: DesktopAPI }).kanban;
        const current = await api.snapshot();
        await api.projects.saveWorkflow(id, value, current.revision);
        return api.snapshot();
      },
      { id: projectId, value: workflow },
    );
    expect(afterSave.projects[0].workflow?.tasks[0].hasStarted).toBe(true);
    await stop();

    page = await launch();
    const restarted = await page.evaluate(() =>
      (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
    );
    expect(restarted.projects[0].workflow).toEqual(
      afterSave.projects[0].workflow,
    );
    expect(restarted.logs).toEqual(originalLogs);
    expect(restarted.notes).toEqual(originalNotes);
    expect(backupFiles()).toEqual(backups);
    expect(errors).toEqual([]);
  } finally {
    await stop();
    rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DesktopAPI } from "../../src/shared/contracts";

let application: ElectronApplication, page: Page, dataDir: string;
const errors: string[] = [];
test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "kanban-e2e-"));
  errors.length = 0;
  const executablePath =
    process.env.KANBAN_TEST_EXE || (require("electron") as string);
  application = await electron.launch({
    executablePath,
    args: process.env.KANBAN_TEST_EXE ? [] : ["."],
    env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
  });
  await application.firstWindow();
  await expect
    .poll(() =>
      application.windows().some((w) => w.url().includes("window=main")),
    )
    .toBe(true);
  page = application.windows().find((w) => w.url().includes("window=main"))!;
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "今天，把事情一件件做好" }),
  ).toBeVisible();
});
test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
  if (dataDir)
    rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  expect(errors).toEqual([]);
});

test("今日事项、中文输入保护、完成结果和汇报去重", async () => {
  await page.getByRole("button", { name: "＋ 新建事项", exact: true }).click();
  await page.getByLabel("事项标题").fill("检查测试环境");
  await page.getByLabel("类型", { exact: true }).selectOption("checklist");
  await page.getByLabel("检查子项").fill("检查告警\n记录异常");
  await page.getByRole("button", { name: "保存事项", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /检查测试环境.*待处理/ }),
  ).toBeVisible();
  const capture = page.getByLabel("快速工作记录");
  await capture.fill("排查接口超时，定位到慢查询");
  await capture.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await expect(capture).toHaveValue("排查接口超时，定位到慢查询");
  await capture.press("Enter");
  await expect(capture).toHaveValue("");
  await page.getByRole("button", { name: /检查测试环境.*待处理/ }).click();
  await page.getByLabel("检查告警", { exact: true }).check();
  await page.getByLabel("记录异常", { exact: true }).check();
  await page.getByLabel("处理结果").fill("服务正常，清理了旧日志");
  await page.getByRole("button", { name: "确认完成", exact: true }).click();
  await page.getByRole("button", { name: "整理汇报 →" }).click();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.getByRole("button", { name: "生成素材预览" }).click();
  await expect(page.getByText("选中 2 / 2 条")).toBeVisible();
  await expect(
    page.locator(".report-entry").filter({ hasText: "服务正常，清理了旧日志" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "复制素材", exact: true }).click();
  const clipboard = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  expect(clipboard).toContain("服务正常，清理了旧日志");
  await page.getByRole("button", { name: "关闭对话框" }).click();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/today.png" });
});

test("项目和笔记、配置导入以及窗口安全设置", async () => {
  await page.locator("nav").getByRole("button", { name: "项目" }).click();
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("项目名称").fill("内部运维工具");
  await page.getByLabel("进度 %").fill("35");
  await page.getByLabel("最新进展").fill("完成需求确认，开始实施");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect(
    page.getByRole("heading", { name: /内部运维工具/ }),
  ).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "记录" }).click();
  await page.getByRole("button", { name: "普通笔记", exact: true }).click();
  await page.getByRole("button", { name: "＋ 普通笔记" }).click();
  await page.getByLabel("标题", { exact: true }).fill("私人备忘");
  await page
    .getByLabel("正文")
    .fill(
      '# 个人想法\n\n<script>throw Error("unsafe")</script>\n\n![远程图片](https://example.com/image.png)',
    );
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".note-preview img")).toHaveCount(0);
  await page.getByRole("button", { name: "保存笔记" }).click();
  await page.getByRole("button", { name: "↧ Agent 配置导入" }).click();
  await page.getByRole("button", { name: "填入示例" }).click();
  await page.getByRole("button", { name: "校验并预览" }).click();
  await expect(page.getByText("即将应用的变更")).toBeVisible();
  await page.getByRole("button", { name: "确认应用整批配置" }).click();
  const snapshot = await page.evaluate(() =>
    (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
  );
  expect(snapshot.templates).toHaveLength(1);
  expect(snapshot.projects[0].progress).toBe(35);
  expect(await page.evaluate(() => typeof (window as any).require)).toBe(
    "undefined",
  );
  expect(await page.evaluate(() => typeof (window as any).process)).toBe(
    "undefined",
  );
});

test("提醒不抢焦点、托盘驻留、稍后与完成取消", async () => {
  const snapshot = await page.evaluate(() =>
    (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
  );
  await page.evaluate(async (date) => {
    await (window as unknown as { kanban: DesktopAPI }).kanban.items.save({
      id: "reminder-smoke",
      type: "task",
      title: "到点提醒测试",
      project_id: null,
      content_markdown: "",
      checklist: [],
      schedule: {
        frequency: "once",
        date,
        time: "00:00",
        timezone: "Asia/Shanghai",
      },
      reminder: { popup: true, snooze_minutes: 10 },
    });
  }, snapshot.today);
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "到点提醒")
          ?.isVisible(),
      ),
    )
    .toBe(true);
  const state = await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === "到点提醒",
    )!;
    return { top: w.isAlwaysOnTop(), focus: w.isFocused() };
  });
  expect(state.top).toBe(true);
  expect(state.focus).toBe(false);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "本地工作看板")!
      .close(),
  );
  expect(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "本地工作看板")
        ?.isVisible(),
    ),
  ).toBe(false);
  const reminder = application
    .windows()
    .find((w) => w.url().includes("window=reminder"))!;
  await reminder.getByRole("button", { name: "10 分钟后" }).click();
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "到点提醒")
          ?.isVisible(),
      ),
    )
    .toBe(false);
  const after = await page.evaluate(async () => {
    const a = (window as unknown as { kanban: DesktopAPI }).kanban;
    const s = await a.snapshot();
    await a.items.state(s.runs[0].id, "completed");
    return a.snapshot();
  });
  expect(after.runs[0].state).toBe("completed");
});

test("备份预览与恢复完整闭环，快速记录窗口和快捷键注册", async () => {
  // The user's running app may already own the default shortcut. Configure an
  // independent shortcut in this test's isolated profile and verify it directly.
  const testShortcut = await page.evaluate(async () => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    for (const shortcut of ["Ctrl+Alt+Shift+F9", "Ctrl+Alt+Shift+F10", "Ctrl+Alt+Shift+F11"]) {
      try {
        await api.settings.save({ shortcut, autoStart: false });
        return shortcut;
      } catch { /* Try another shortcut without touching the user's profile. */ }
    }
    throw new Error("No isolated test shortcut is available");
  });
  const backupPath = join(dataDir, "ui-backup.kanban-backup");
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backupPath);
  const quick = application
    .windows()
    .find((w) => w.url().includes("window=quick"))!;
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "随手记")!
      .show(),
  );
  await quick.getByLabel("随手记内容").fill("快捷窗口记录");
  await quick.getByLabel("随手记内容").press("Enter");
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "随手记")
          ?.isVisible(),
      ),
    )
    .toBe(false);
  expect(
    await application.evaluate(({ globalShortcut }, shortcut) =>
      globalShortcut.isRegistered(shortcut), testShortcut),
  ).toBe(true);
  await page.getByRole("button", { name: "⚙ 设置与备份" }).click();
  await page.getByRole("button", { name: "导出完整备份" }).click();
  await expect(page.getByRole("status")).toContainText("备份已保存");
  await page.evaluate(async () => {
    const a = (window as unknown as { kanban: DesktopAPI }).kanban;
    const d = await a.snapshot();
    await a.records.saveLog({ body: "恢复后应消失", date: d.today });
  });
  await page.getByRole("button", { name: "选择备份并预览" }).click();
  await expect(page.getByRole("heading", { name: "恢复预览" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("数据已恢复");
  const restored = await page.evaluate(() =>
    (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
  );
  expect(restored.logs.map((l) => l.body)).toEqual(["快捷窗口记录"]);
});

test("单实例启动只打开原程序，重新启动数据保留", async () => {
  await page.evaluate(async () => {
    const a = (window as unknown as { kanban: DesktopAPI }).kanban;
    const s = await a.snapshot();
    await a.records.saveLog({ body: "重启后仍在", date: s.today });
  });
  const windowsBefore = await application.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
  const child = require("node:child_process").spawn(
    process.env.KANBAN_TEST_EXE || require("electron"),
    process.env.KANBAN_TEST_EXE ? [] : ["."],
    {
      env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code: number) =>
      code === 0
        ? resolve()
        : reject(new Error(`Second instance exit ${code}`)),
    );
    child.once("error", reject);
  });
  expect(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(windowsBefore);
  await application.close();
  application = await electron.launch({
    executablePath: process.env.KANBAN_TEST_EXE || require("electron"),
    args: process.env.KANBAN_TEST_EXE ? [] : ["."],
    env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
  });
  await expect
    .poll(() =>
      application.windows().some((w) => w.url().includes("window=main")),
    )
    .toBe(true);
  page = application.windows().find((w) => w.url().includes("window=main"))!;
  await expect(
    page.getByRole("button").filter({ hasText: "重启后仍在" }),
  ).toBeVisible();
});

test("锁屏与恢复事件合并提醒，快捷键冲突保持原设置", async () => {
  await application.evaluate(({ powerMonitor, globalShortcut }) => {
    powerMonitor.emit("lock-screen");
    globalShortcut.register("Ctrl+Alt+K", () => {});
  });
  const date = await page.evaluate(
    async () =>
      (await (window as unknown as { kanban: DesktopAPI }).kanban.snapshot())
        .today,
  );
  await page.evaluate(async (day) => {
    const a = (window as unknown as { kanban: DesktopAPI }).kanban;
    for (const id of ["locked-1", "locked-2"])
      await a.items.save({
        id,
        type: "task",
        title: id,
        checklist: [],
        project_id: null,
        content_markdown: "",
        schedule: {
          frequency: "once",
          date: day,
          time: "00:00",
          timezone: "Asia/Shanghai",
        },
        reminder: { popup: true, snooze_minutes: 10 },
      });
  }, date);
  expect(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "到点提醒")
        ?.isVisible(),
    ),
  ).toBe(false);
  await application.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("resume");
    powerMonitor.emit("unlock-screen");
  });
  const reminder = application
    .windows()
    .find((w) => w.url().includes("window=reminder"))!;
  await expect(reminder.locator("article")).toHaveCount(2);
  const boundsOk = await application.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "到点提醒")!
      .getBounds();
    const area = screen.getDisplayNearestPoint({ x: w.x, y: w.y }).workArea;
    return (
      w.x >= area.x &&
      w.y >= area.y &&
      w.x + w.width <= area.x + area.width &&
      w.y + w.height <= area.y + area.height
    );
  });
  expect(boundsOk).toBe(true);
  const conflict = await page.evaluate(async () => {
    try {
      await (window as unknown as { kanban: DesktopAPI }).kanban.settings.save({
        shortcut: "Ctrl+Alt+K",
        autoStart: false,
      });
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(conflict).toContain("快捷键不可用");
  expect(
    await page.evaluate(
      async () =>
        (await (window as unknown as { kanban: DesktopAPI }).kanban.snapshot())
          .settings.shortcut,
    ),
  ).toBe("Ctrl+Alt+J");
});

test("数据库暂时不可写时保留输入，解除后可以保存", async () => {
  const db = new DatabaseSync(join(dataDir, "kanban.db"));
  try {
    db.exec("BEGIN IMMEDIATE");
    await page.getByLabel("快速工作记录").fill("保存失败后不能丢失的内容");
    await page.getByLabel("快速工作记录").press("Enter");
    await expect(page.getByRole("alert")).toContainText("locked", {
      timeout: 10000,
    });
    await expect(page.getByLabel("快速工作记录")).toHaveValue(
      "保存失败后不能丢失的内容",
    );
    db.exec("ROLLBACK");
    await page.getByRole("button", { name: "记下来 ↵", exact: true }).click();
    await expect(page.getByLabel("快速工作记录")).toHaveValue("");
  } finally {
    db.close();
  }
});

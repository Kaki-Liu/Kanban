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

let app: ElectronApplication, page: Page, widget: Page, dataDir: string;
const errors: string[] = [];

async function launch() {
  app = await electron.launch({
    executablePath: process.env.KANBAN_TEST_EXE || (require("electron") as string),
    args: process.env.KANBAN_TEST_EXE ? [] : ["."],
    env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
  });
  await expect.poll(() => app.windows().some((w) => w.url().includes("window=widget"))).toBe(true);
  page = app.windows().find((w) => w.url().includes("window=main"))!;
  widget = app.windows().find((w) => w.url().includes("window=widget"))!;
  for (const window of [page, widget])
    window.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByRole("heading", { name: "今天，把事情一件件做好" })).toBeVisible();
}

const widgetState = () => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "桌面便签")!;
  return { visible: w.isVisible(), focused: w.isFocused(), pinned: w.isAlwaysOnTop(), bounds: w.getBounds() };
});

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "kanban-widget-e2e-"));
  errors.length = 0;
  await launch();
});
test.afterEach(async () => {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (dataDir)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(errors).toEqual([]);
});

test("便签常驻且不抢焦点，清单跨窗口同步，最近两条提醒只读预告", async () => {
  const original = await page.evaluate(async () => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    const { today } = await api.snapshot();
    const nextDay = new Date(`${today}T12:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const tomorrow = nextDay.toISOString().slice(0, 10);
    await api.items.save({
      id: "widget-checklist", type: "checklist", title: "晨间运维检查",
      project_id: null, content_markdown: "",
      checklist: [
        { id: "status", text: "确认服务状态" },
        { id: "alerts", text: "查看异常告警" },
        { id: "handoff", text: "确认生产服务、告警通知和最近备份均正常，发现异常时记录现象与处理结果，再与值班同事确认交接事项。" },
      ],
      schedule: { frequency: "daily", start_date: today, timezone: "Asia/Shanghai" },
      reminder: { popup: false, snooze_minutes: 10 },
    });
    for (const [index, time] of ["08:00", "09:00", "10:00"].entries())
      await api.items.save({
        id: `widget-future-${index}`, type: "task", title: `明日提醒 ${index + 1}`,
        project_id: null, content_markdown: "", checklist: [],
        schedule: { frequency: "daily", start_date: tomorrow, time, timezone: "Asia/Shanghai" },
        reminder: { popup: true, snooze_minutes: 10 },
      });
    await api.records.saveNote({ title: "私人笔记", body: "WIDGET-MUST-NOT-READ-PRIVATE-NOTE" });
    return api.snapshot();
  });
  expect(original.runs).toHaveLength(1);
  await page.getByRole("button", { name: /桌面便签/ }).click();
  await expect.poll(async () => (await widgetState()).visible).toBe(true);
  const state = await widgetState();
  expect(state.focused).toBe(false);
  expect(state.pinned).toBe(true);
  expect(state.bounds.width).toBe(380);
  expect(state.bounds.height).toBe(560);
  expect(await widget.locator(".sticky-titlebar").evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("drag");
  expect(await widget.getByRole("button", { name: "取消置顶", exact: true }).evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
  await expect(widget.getByRole("heading", { name: "今日检查", exact: true })).toBeVisible();
  await expect(widget.getByRole("heading", { name: "接下来", exact: true })).toBeVisible();
  await expect(widget.getByText("明日提醒 1", { exact: true })).toBeVisible();
  await expect(widget.getByText("明日提醒 2", { exact: true })).toBeVisible();
  await expect(widget.getByText("明日提醒 3", { exact: true })).toHaveCount(0);

  const limited = await widget.evaluate(async () => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    let denied = false;
    try { await api.snapshot(); } catch { denied = true; }
    return { data: await api.widget.get(), denied };
  });
  expect(limited.denied).toBe(true);
  expect(limited.data.upcoming).toHaveLength(2);
  expect(JSON.stringify(limited.data)).not.toContain("WIDGET-MUST-NOT-READ-PRIVATE-NOTE");
  const afterPreview = await page.evaluate(() => (window as unknown as { kanban: DesktopAPI }).kanban.snapshot());
  expect(afterPreview.runs).toEqual(original.runs);

  await widget.getByLabel("确认服务状态", { exact: true }).check();
  await widget.getByRole("button", { name: "晨间运维检查", exact: true }).click();
  await expect(page.getByLabel("确认服务状态", { exact: true })).toBeChecked();
  await page.getByLabel("确认服务状态", { exact: true }).uncheck();
  await expect(widget.getByLabel("确认服务状态", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "本地工作看板")!.close());
  expect((await widgetState()).visible).toBe(true);
  await widget.getByLabel("查看异常告警", { exact: true }).check();
  await expect.poll(async () => (await widget.evaluate(() => (window as unknown as { kanban: DesktopAPI }).kanban.widget.get())).checklists[0].checks.alerts).toBe(true);
  mkdirSync("test-results", { recursive: true });
  await widget.screenshot({ path: "test-results/widget.png" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "桌面便签")!.setSize(340, 420));
  const longItem = widget.locator(".sticky-check").filter({ hasText: "确认生产服务、告警通知和最近备份" });
  await longItem.scrollIntoViewIfNeeded();
  const textLayout = await longItem.locator("span").evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    clipped: el.scrollWidth > el.clientWidth,
    ellipsis: getComputedStyle(el).textOverflow === "ellipsis",
  }));
  expect(textLayout.height).toBeGreaterThan(textLayout.lineHeight * 1.5);
  expect(textLayout.clipped).toBe(false);
  expect(textLayout.ellipsis).toBe(false);
  await expect(widget.getByRole("heading", { name: "接下来", exact: true })).toBeVisible();
  await expect(widget.getByRole("button", { name: /打开看板/ })).toBeInViewport();
  await widget.screenshot({ path: "test-results/widget-small.png" });
});

test("便签置顶、位置和显隐状态跨重启保留，操作不改变业务版本", async () => {
  await page.getByRole("button", { name: /桌面便签/ }).click();
  const revision = await page.evaluate(async () => (await (window as unknown as { kanban: DesktopAPI }).kanban.snapshot()).revision);
  await widget.getByRole("button", { name: "取消置顶", exact: true }).click();
  await expect.poll(async () => (await widgetState()).pinned).toBe(false);
  const expectedBounds = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "桌面便签")!;
    const area = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: area.x + 45, y: area.y + 65, width: 380, height: 560 });
    return w.getBounds();
  });
  expect(await page.evaluate(async () => (await (window as unknown as { kanban: DesktopAPI }).kanban.snapshot()).revision)).toBe(revision);
  // Normal quit flushes the position debounce before the database is closed.
  await app.close();
  await launch();
  await expect.poll(async () => (await widgetState()).visible).toBe(true);
  expect(await widgetState()).toMatchObject({ pinned: false, bounds: expectedBounds });
  await expect(widget.getByRole("button", { name: "置顶便签", exact: true })).toBeVisible();
  await widget.getByRole("button", { name: "隐藏便签", exact: true }).click();
  await expect.poll(async () => (await widgetState()).visible).toBe(false);
  await app.close();
  await launch();
  expect((await widgetState()).visible).toBe(false);
  await page.getByRole("button", { name: /桌面便签/ }).click();
  await expect.poll(async () => (await widgetState()).visible).toBe(true);
  expect((await widgetState()).bounds).toEqual(expectedBounds);
});

test("便签勾选写入失败回滚，解除数据库占用后可以重新保存", async () => {
  await page.evaluate(async () => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    const { today } = await api.snapshot();
    await api.items.save({
      id: "rollback-checklist", type: "checklist", title: "保存失败检查",
      project_id: null, content_markdown: "",
      checklist: [{ id: "rollback", text: "验证勾选可以恢复" }],
      schedule: { frequency: "daily", start_date: today, timezone: "Asia/Shanghai" },
      reminder: { popup: false, snooze_minutes: 10 },
    });
  });
  await page.getByRole("button", { name: /桌面便签/ }).click();
  const checkbox = widget.getByLabel("验证勾选可以恢复", { exact: true });
  await expect(checkbox).not.toBeChecked();
  const db = new DatabaseSync(join(dataDir, "kanban.db"));
  try {
    db.exec("BEGIN IMMEDIATE");
    // A failed write intentionally ends unchecked; check() would require the
    // opposite final state after Electron's synchronous SQLite timeout.
    await checkbox.click();
    await expect(widget.getByRole("alert")).toContainText("locked", { timeout: 10_000 });
    await expect(checkbox).not.toBeChecked();
    db.exec("ROLLBACK");
    await checkbox.check();
    await expect.poll(async () => (await widget.evaluate(() =>
      (window as unknown as { kanban: DesktopAPI }).kanban.widget.get(),
    )).checklists[0].checks.rollback).toBe(true);
    await expect(widget.getByRole("alert")).toHaveCount(0);
  } finally {
    db.close();
  }
});

test("便签读取补建当天检查时，主窗口也收到刷新通知", async () => {
  const date = await page.evaluate(async () =>
    (await (window as unknown as { kanban: DesktopAPI }).kanban.snapshot()).today,
  );
  // Model a recurrence whose current-day instance has not yet been generated.
  // Direct fixture writes stay entirely within this test's isolated profile.
  const db = new DatabaseSync(join(dataDir, "kanban.db"));
  try {
    db.prepare("INSERT INTO templates(id,config) VALUES(?,?)").run(
      "missing-today",
      JSON.stringify({
        id: "missing-today", type: "checklist", title: "补建今日巡检",
        project_id: null, content_markdown: "",
        checklist: [{ id: "service", text: "核对服务" }],
        schedule: { frequency: "daily", start_date: date, timezone: "Asia/Shanghai" },
        reminder: { popup: false, snooze_minutes: 10 },
      }),
    );
    const generated = await widget.evaluate(() =>
      (window as unknown as { kanban: DesktopAPI }).kanban.widget.get(),
    );
    expect(generated.checklists.map((run) => run.config.title)).toContain("补建今日巡检");
    // No popup reminder exists to incidentally notify the main window later.
    await expect(page.getByRole("button", { name: /补建今日巡检.*待处理/ })).toBeVisible();
  } finally {
    db.close();
  }
});

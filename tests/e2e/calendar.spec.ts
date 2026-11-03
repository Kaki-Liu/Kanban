import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopAPI } from "../../src/shared/contracts";
import { today } from "../../src/shared/time";

test("日历回顾历史事项、补记归属日期，并管理未来计划而不预生成周期记录", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kanban-calendar-e2e-"));
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: process.env.KANBAN_TEST_EXE || (require("electron") as string),
      args: process.env.KANBAN_TEST_EXE ? [] : ["."],
      env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
    });
    await expect.poll(() => app!.windows().some((w) => w.url().includes("window=main"))).toBe(true);
    const page = app.windows().find((w) => w.url().includes("window=main"))!;
    page.on("pageerror", (e) => errors.push(e.message));
    const dates = await page.evaluate(async () => {
      const api = (window as unknown as { kanban: DesktopAPI }).kanban;
      const current = (await api.snapshot()).today;
      const previous = new Date(`${current.slice(0, 7)}-15T12:00:00Z`);
      previous.setUTCMonth(previous.getUTCMonth() - 1);
      const next = new Date(`${current.slice(0, 7)}-15T12:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const past = previous.toISOString().slice(0, 10);
      const future = next.toISOString().slice(0, 10);
      await api.items.save({
        id: "historical-calendar-task", type: "task", title: "历史部署检查",
        project_id: null, content_markdown: "历史任务说明", checklist: [],
        schedule: { frequency: "once", date: past, timezone: "Asia/Shanghai" },
        reminder: { popup: false, snooze_minutes: 10 },
      });
      const run = (await api.snapshot()).runs.find((r) => r.templateId === "historical-calendar-task")!;
      await api.items.state(run.id, "completed");
      await api.records.saveLog({ body: "历史记录：完成部署验证", date: past, runId: run.id });
      await api.items.save({
        id: "future-calendar-check", type: "checklist", title: "未来例行巡检",
        project_id: null, content_markdown: "", checklist: [{ id: "service", text: "检查服务" }],
        schedule: { frequency: "daily", start_date: future, time: "09:00", timezone: "Asia/Shanghai" },
        reminder: { popup: true, snooze_minutes: 10 },
      });
      return { current, past, future, runs: (await api.snapshot()).runs };
    });
    expect(dates.runs).toHaveLength(1);
    await page.getByRole("button", { name: "日历回顾", exact: true }).click();
    await expect(page.getByRole("heading", { name: "日历回顾", exact: true })).toBeVisible();
    await page.getByLabel("查看月份", { exact: true }).fill(dates.past.slice(0, 7));
    await page.getByRole("button", { name: dates.past, exact: true }).click();
    const agenda = page.getByRole("region", { name: "当天事项", exact: true });
    const logs = page.getByRole("region", { name: "工作记录", exact: true });
    await expect(agenda).toContainText("历史部署检查");
    await expect(agenda).toContainText("已完成");
    await expect(logs).toContainText("历史记录：完成部署验证");
    await agenda.getByRole("button", { name: /历史部署检查/ }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "历史部署检查", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(dates.past);
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

    await page.getByRole("button", { name: "＋ 补记工作", exact: true }).click();
    await expect(page.getByLabel("归属日期", { exact: true })).toHaveValue(dates.past);
    await page.getByRole("textbox", { name: "做了什么", exact: true }).fill("补记：整理上线说明");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(logs).toContainText("补记：整理上线说明");
    const savedLog = await page.evaluate(async () =>
      (await (window as unknown as { kanban: DesktopAPI }).kanban.snapshot()).logs.find((log) => log.body === "补记：整理上线说明")!,
    );
    expect(savedLog.date).toBe(dates.past);
    expect(today(new Date(savedLog.createdAt))).toBe(dates.current);
    await logs.getByRole("button", { name: /补记：整理上线说明/ }).click();
    await page.getByRole("textbox", { name: "做了什么", exact: true }).fill("补记：整理上线说明并交接");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(logs).toContainText("补记：整理上线说明并交接");

    await page.getByLabel("查看月份", { exact: true }).fill(dates.future.slice(0, 7));
    await page.getByRole("button", { name: dates.future, exact: true }).click();
    await expect(agenda.locator(".is-planned")).toContainText("未来例行巡检");
    const afterPreview = await page.evaluate(() => (window as unknown as { kanban: DesktopAPI }).kanban.snapshot());
    expect(afterPreview.runs).toEqual(dates.runs);
    await page.getByRole("button", { name: "＋ 新增事项", exact: true }).click();
    await expect(page.getByLabel("计划日期", { exact: true })).toHaveValue(dates.future);
    await page.getByLabel("事项标题", { exact: true }).fill("按日期安排项目评审");
    await page.getByRole("button", { name: "保存事项", exact: true }).click();
    await expect(agenda).toContainText("按日期安排项目评审");
    await expect(agenda).toContainText("未来例行巡检");
    await expect(page.getByRole("button", { name: dates.future, exact: true })).toHaveAttribute("aria-pressed", "true");
    const final = await page.evaluate(() => (window as unknown as { kanban: DesktopAPI }).kanban.snapshot());
    expect(final.runs.filter((run) => run.templateId === "future-calendar-check")).toHaveLength(0);
    expect(final.runs.find((run) => run.config.title === "按日期安排项目评审")?.date).toBe(dates.future);
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/calendar.png" });
    expect(errors).toEqual([]);
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

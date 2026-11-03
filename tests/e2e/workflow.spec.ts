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
import type { DesktopAPI } from "../../src/shared/contracts";
import { createWorkflow } from "../../src/shared/workflow-templates";
import { workflowTaskSchema } from "../../src/shared/workflow";

let app: ElectronApplication, page: Page, dataDir: string;
const errors: string[] = [];
const projectId = "workflow-e2e";
const snapshot = () =>
  page.evaluate(() =>
    (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
  );
const panel = () => page.locator(".workflow-panel");
async function openProjects() {
  await page.locator("nav").getByRole("button", { name: "项目" }).click();
  await expect(panel()).toBeVisible();
  const expand = panel().getByRole("button", { name: "展开开发工作台", exact: true });
  if (await expand.isVisible()) await expand.click();
}
async function saveFlow() {
  await panel()
    .getByRole("button", { name: "保存开发流程", exact: true })
    .click();
  await expect(panel().getByRole("status")).toHaveText("开发流程已保存");
  await expect(
    panel().getByRole("button", { name: "保存开发流程", exact: true }),
  ).toBeDisabled();
}

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "kanban-workflow-e2e-"));
  errors.length = 0;
  app = await electron.launch({
    executablePath:
      process.env.KANBAN_TEST_EXE || (require("electron") as string),
    args: process.env.KANBAN_TEST_EXE ? [] : ["."],
    env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
  });
  await app.firstWindow();
  await expect
    .poll(() => app.windows().some((w) => w.url().includes("window=main")))
    .toBe(true);
  page = app.windows().find((w) => w.url().includes("window=main"))!;
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "今天，把事情一件件做好" }),
  ).toBeVisible();
  await page.evaluate(async (id) => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    await api.projects.save({
      id,
      name: "开发协作验收项目",
      owner: "小林",
      progress: 25,
    });
    await api.records.saveNote({
      title: "私人想法",
      body: "PRIVATE-NOTE-DO-NOT-EXPORT",
      projectId: id,
    });
  }, projectId);
});

test.afterEach(async () => {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
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

test("开发路线、任务交接验证、保存和重新打开", async () => {
  await openProjects();
  await expect(panel().locator(".wf-mode")).toHaveCount(6);
  await panel()
    .getByRole("button", { name: /每周交付一点/ })
    .click();
  await panel().getByLabel("项目目标").fill("让值班人员完成检查并交接结果");
  await panel().getByLabel("协作方式").selectOption("team");
  await panel()
    .getByRole("button", { name: "启用开发流程", exact: true })
    .click();
  await expect(panel().getByRole("status")).toHaveText("开发流程已保存");
  const enabled = (await snapshot()).projects[0];
  expect(enabled.progress).toBe(25);
  expect(enabled.workflow?.mode).toBe("agile");
  expect(enabled.workflow?.milestones.length).toBe(4);
  if (!(await panel().getByLabel("开发路线").isVisible()))
    await panel().getByText("目标、范围与流程设置", { exact: true }).click();
  await panel().getByLabel("开发路线").selectOption("kanban");
  await saveFlow();
  expect((await snapshot()).projects[0].workflow?.milestones).toEqual(enabled.workflow?.milestones);
  await panel().getByLabel("开发路线").selectOption("agile");
  await saveFlow();
  await panel().getByText("目标、范围与流程设置", { exact: true }).click();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/workflow-route.png",
    fullPage: true,
  });

  await panel().getByRole("button", { name: "开发任务", exact: true }).click();
  await panel()
    .getByRole("button", { name: "＋ 开发任务", exact: true })
    .click();
  const editor = panel().locator(".wf-task-editor");
  await editor.getByLabel("任务名称", { exact: true }).fill("交付值班检查演示");
  await editor
    .getByLabel("验收标准")
    .fill("创建检查、完成并重新打开后结果保留");
  await editor.getByLabel("结果与验证依据").fill("已使用测试检查走通完整流程");
  await editor.getByLabel("接收人", { exact: true }).fill("值班负责人");
  await editor.getByLabel("任务状态").selectOption("done");
  await panel()
    .getByRole("button", { name: "保存开发流程", exact: true })
    .click();
  await expect(panel().getByRole("alert")).toContainText("交接验收通过");
  expect((await snapshot()).projects[0].workflow?.tasks).toHaveLength(0);
  await expect(editor.getByLabel("任务名称", { exact: true })).toHaveValue(
    "交付值班检查演示",
  );

  await editor.getByLabel("任务状态").selectOption("review");
  await editor
    .getByLabel("交付物及版本")
    .fill("测试演示 v1，项目文档中的操作步骤");
  await editor.getByLabel("交接状态").selectOption("submitted");
  await saveFlow();
  await editor.getByLabel("交接状态").selectOption("received");
  await saveFlow();
  await editor
    .getByLabel("交接验证结果")
    .fill("值班负责人已试用并确认流程符合预期");
  await editor.getByLabel("交接状态").selectOption("accepted");
  await editor.getByLabel("任务状态").selectOption("done");
  await saveFlow();
  let data = await snapshot();
  expect(data.projects[0].workflow?.tasks[0].handoff.status).toBe("accepted");
  expect(data.logs).toHaveLength(1);

  await editor.getByLabel("任务状态").selectOption("review");
  await saveFlow();
  await editor.getByLabel("任务状态").selectOption("done");
  await saveFlow();
  expect((await snapshot()).logs).toHaveLength(1);
  await page.reload();
  await openProjects();
  await panel().getByRole("button", { name: "开发任务", exact: true }).click();
  await panel()
    .locator(".wf-task")
    .filter({ hasText: "交付值班检查演示" })
    .click();
  await expect(panel().getByLabel("任务状态")).toHaveValue("done");
  await expect(panel().getByLabel("交接状态")).toHaveValue("accepted");
  data = await snapshot();
  expect(data.notes[0].body).toBe("PRIVATE-NOTE-DO-NOT-EXPORT");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/workflow.png", fullPage: true });
});

test("流程导出不含私人笔记，Agent 导入保护已有结果并降级待验收", async () => {
  const workflow = createWorkflow("novice", "team");
  workflow.goal = "通过明确目标推进开发";
  workflow.tasks = [
    workflowTaskSchema.parse({
      id: "finished",
      title: "已验收任务",
      state: "done",
      acceptance: "按步骤运行成功",
      evidence: "人工确认的实际结果",
      milestoneId: workflow.milestones[0].id,
    }),
  ];
  await page.evaluate(
    async ({ id, workflow }) => {
      const api = (window as unknown as { kanban: DesktopAPI }).kanban;
      await api.projects.saveWorkflow(
        id,
        workflow,
        (await api.snapshot()).revision,
      );
    },
    { id: projectId, workflow },
  );
  await openProjects();
  await panel()
    .getByRole("button", { name: "Agent 配置", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "预览配置导出", exact: true })
    .click();
  const exportedText = await panel().getByLabel("导出内容预览").inputValue();
  expect(exportedText).not.toContain("PRIVATE-NOTE-DO-NOT-EXPORT");
  await panel()
    .getByRole("button", { name: "复制预览内容", exact: true })
    .click();
  await expect(panel().getByRole("status")).toHaveText(
    "已复制，可以粘贴到外部工具",
  );
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(exportedText);
  const incoming = JSON.parse(exportedText);
  incoming.workflow.tasks[0].evidence = "Agent 试图覆盖已有验收";
  incoming.workflow.tasks.push(
    workflowTaskSchema.parse({
      id: "agent-new",
      title: "Agent 新增结果",
      state: "done",
      acceptance: "启动成功",
      evidence: "Agent 自报运行通过",
    }),
  );
  await panel().getByLabel("粘贴开发流程 JSON").fill(JSON.stringify(incoming));
  await panel()
    .getByRole("button", { name: "校验并预览导入", exact: true })
    .click();
  await expect(panel().locator(".wf-import-preview")).toBeVisible();
  await panel()
    .locator(".wf-import-preview")
    .getByRole("button", { name: /确认.*保存/ })
    .click();
  await expect(panel().getByRole("status")).toHaveText("开发流程已保存");
  const saved = (await snapshot()).projects[0].workflow!;
  expect(saved.tasks.find((t) => t.id === "finished")?.evidence).toBe(
    "人工确认的实际结果",
  );
  expect(saved.tasks.find((t) => t.id === "agent-new")?.state).toBe("review");
  expect((await snapshot()).logs).toHaveLength(1);
});

test("数据变化后拒绝过期流程保存并保留草稿", async () => {
  const workflow = createWorkflow("kanban");
  workflow.goal = "原始目标";
  await page.evaluate(
    async ({ id, workflow }) => {
      const api = (window as unknown as { kanban: DesktopAPI }).kanban;
      await api.projects.saveWorkflow(
        id,
        workflow,
        (await api.snapshot()).revision,
      );
    },
    { id: projectId, workflow },
  );
  await openProjects();
  await panel().getByText("目标、范围与流程设置", { exact: true }).click();
  await panel().getByLabel("项目目标").fill("尚未保存的重要修改");
  await page.evaluate(async () => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    const data = await api.snapshot();
    await api.records.saveLog({ body: "另一个窗口的新记录", date: data.today });
  });
  await panel()
    .getByRole("button", { name: "保存开发流程", exact: true })
    .click();
  await expect(panel().getByRole("alert")).toContainText(/变化|更新|重新/);
  await expect(panel().getByLabel("项目目标")).toHaveValue(
    "尚未保存的重要修改",
  );
  expect((await snapshot()).projects[0].workflow?.goal).toBe("原始目标");
});

test("切换归档筛选后仍保护草稿，离开和编辑项目均有边界", async () => {
  const workflow = createWorkflow("novice");
  workflow.goal = "保存前的目标";
  await page.evaluate(
    async ({ id, workflow }) => {
      const api = (window as unknown as { kanban: DesktopAPI }).kanban;
      await api.projects.saveWorkflow(id, workflow, (await api.snapshot()).revision);
    },
    { id: projectId, workflow },
  );
  await openProjects();
  await panel().getByText("目标、范围与流程设置", { exact: true }).click();
  await panel().getByLabel("项目目标").fill("需要保留的未保存目标");
  await page.getByLabel("显示归档项目").check();
  await expect(panel().getByLabel("项目目标")).toHaveValue("需要保留的未保存目标");

  const dialogPromise = page.waitForEvent("dialog");
  const navigate = page.locator("nav").getByRole("button", { name: "记录" }).click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toContain("未保存的开发流程修改");
  await dialog.dismiss();
  await navigate;
  await expect(panel()).toBeVisible();
  await expect(panel().getByLabel("项目目标")).toHaveValue("需要保留的未保存目标");
  await expect(page.locator("nav").getByRole("button", { name: "项目" })).toHaveClass(/selected/);

  await page.getByRole("button", { name: "编辑项目", exact: true }).click();
  await expect(page.locator(".error-banner")).toContainText("请先保存或放弃开发流程修改，再编辑项目基本信息。");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel().getByLabel("项目目标")).toHaveValue("需要保留的未保存目标");
  expect((await snapshot()).projects[0].workflow?.goal).toBe("保存前的目标");
});

test("开发工作台默认折叠、按项目记忆，折叠保留草稿并支持减少动态效果", async () => {
  const workflow = createWorkflow("kanban");
  workflow.goal = "原始目标";
  await page.evaluate(async ({ id, workflow }) => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    await api.projects.saveWorkflow(id, workflow, (await api.snapshot()).revision);
    await api.projects.save({ id: "second-project", name: "第二个项目", workflow });
  }, { id: projectId, workflow });
  await page.locator("nav").getByRole("button", { name: "项目" }).click();
  await page.locator(".project-selector").getByRole("button", { name: /开发协作验收项目/ }).click();
  const toggle = () => panel().locator(".wf-collapse-toggle");
  await expect(toggle()).toHaveAttribute("aria-expanded", "false");
  await expect(panel().getByRole("button", { name: "开发任务", exact: true })).not.toBeVisible();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/workbench-collapsed.png" });
  await toggle().click();
  await panel().getByText("目标、范围与流程设置", { exact: true }).click();
  await panel().getByLabel("项目目标").fill("折叠时也要保留的草稿");
  await toggle().click();
  await expect(toggle()).toHaveAttribute("aria-expanded", "false");
  await expect(panel().getByLabel("项目目标")).not.toBeVisible();
  expect((await snapshot()).projects.find((p) => p.id === projectId)?.workflow?.goal).toBe("原始目标");
  await toggle().click();
  await expect(panel().getByLabel("项目目标")).toHaveValue("折叠时也要保留的草稿");
  await saveFlow();

  await page.locator(".project-selector").getByRole("button", { name: /第二个项目/ }).click();
  await expect(toggle()).toHaveAttribute("aria-expanded", "false");
  await page.locator(".project-selector").getByRole("button", { name: /开发协作验收项目/ }).click();
  await expect(toggle()).toHaveAttribute("aria-expanded", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const durations = await panel().locator(".wf-collapse-body").evaluate((el) =>
    getComputedStyle(el).transitionDuration.split(",").map((value) => parseFloat(value)),
  );
  expect(durations.every((duration) => duration <= 0.001)).toBe(true);

  // A real application restart checks persistence beyond the component lifetime.
  await app.close();
  app = await electron.launch({
    executablePath: process.env.KANBAN_TEST_EXE || (require("electron") as string),
    args: process.env.KANBAN_TEST_EXE ? [] : ["."],
    env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
  });
  await expect.poll(() => app.windows().some((w) => w.url().includes("window=main"))).toBe(true);
  page = app.windows().find((w) => w.url().includes("window=main"))!;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("nav").getByRole("button", { name: "项目" }).click();
  await page.locator(".project-selector").getByRole("button", { name: /开发协作验收项目/ }).click();
  await expect(toggle()).toHaveAttribute("aria-expanded", "true");
  await page.locator(".project-selector").getByRole("button", { name: /第二个项目/ }).click();
  await expect(toggle()).toHaveAttribute("aria-expanded", "false");
});

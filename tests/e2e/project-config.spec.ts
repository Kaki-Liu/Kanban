import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopAPI } from "../../src/shared/contracts";
import { createWorkflow } from "../../src/shared/workflow-templates";
import { workflowTaskSchema } from "../../src/shared/workflow";

let app: ElectronApplication, page: Page, dataDir: string;
const errors: string[] = [];
const snapshot = () =>
  page.evaluate(() =>
    (window as unknown as { kanban: DesktopAPI }).kanban.snapshot(),
  );
const dialog = () => page.getByRole("dialog", { name: "Agent 填写项目信息" });
async function openProjects() {
  await page.locator("nav").getByRole("button", { name: "项目" }).click();
}

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "kanban-project-config-e2e-"));
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
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "今天，把事情一件件做好" }),
  ).toBeVisible();
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

test("保存模板文件，导入 Agent 文件，一次填写完整项目与协作字段", async () => {
  const path = join(dataDir, "agent-project.json");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await openProjects();
  await page
    .getByRole("button", { name: "Agent 填写项目", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "保存模板文件", exact: true })
    .click();
  await expect(dialog().getByRole("status")).toContainText("文件已保存");
  expect(existsSync(path)).toBe(true);
  const config = JSON.parse(readFileSync(path, "utf8"));
  expect(config.kind).toBe("kanban-project");
  expect(config.project.workflow.tasks[0].handoff).toHaveProperty(
    "instructions",
  );
  await dialog()
    .getByRole("button", { name: "复制给 Agent", exact: true })
    .click();
  await expect(dialog().getByRole("status")).toContainText("已复制");
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toContain("kanban-project");
  expect(copied).toContain("不要猜测真实人员");

  Object.assign(config.project, {
    name: "Agent 完整填空项目",
    description: "文件一次填写全部项目表单",
    owner: "小王",
    state: "active",
    progress: 30,
    update: "完成需求梳理",
    archived: false,
  });
  delete config.project.id;
  Object.assign(config.project.workflow, {
    goal: "值班人员能完成检查并交接",
    scope: "本地检查、记录、提醒",
    outOfScope: "不做同步",
    acceptance: "创建、提醒、完成、重启可见",
    collaboration: "team",
    wipLimit: 2,
  });
  config.project.workflow.milestones[0].dueDate = "2027-01-15";
  config.project.workflow.participants = [
    { id: "person-1", name: "小王", role: "负责人", contact: "团队联系方式" },
  ];
  const task = config.project.workflow.tasks[0];
  Object.assign(task, {
    title: "确认交接边界",
    owner: "小王",
    reviewer: "小陈",
    receiver: "小陈",
    input: "值班样例",
    output: "场景说明",
    boundary: "只确认首版",
    acceptance: "有可操作的检查步骤",
    followUpDate: "2027-01-14",
  });
  Object.assign(task.handoff, {
    artifacts: "场景说明 v1",
    instructions: "阅读操作步骤",
    verification: "尚未试用",
    risks: "等待反馈",
    nextAction: "小陈试用",
    note: "待确认",
  });
  config.project.workflow.decisions = [
    {
      id: "interface-1",
      kind: "interface",
      topic: "确认检查输入",
      people: "小王、小陈",
      conclusion: "待讨论字段",
      impact: "影响数据表单",
      date: "2027-01-10",
      followUpDate: "2027-01-12",
      status: "pending",
    },
  ];
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  await dialog()
    .getByRole("button", { name: "选择 JSON 文件", exact: true })
    .click();
  await expect(
    dialog().getByLabel("完整项目 JSON", { exact: true }),
  ).toHaveValue(/Agent 完整填空项目/);
  expect((await snapshot()).projects).toHaveLength(0);
  await dialog()
    .getByRole("button", { name: "校验并预览", exact: true })
    .click();
  await expect(dialog().getByLabel("项目导入预览")).toContainText(
    "Agent 完整填空项目",
  );
  expect((await snapshot()).projects).toHaveLength(0);
  mkdirSync("test-results", { recursive: true });
  await dialog()
    .getByRole("button", { name: "确认创建项目", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/project-config-preview.png" });
  await dialog()
    .getByRole("button", { name: "确认创建项目", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  const project = (await snapshot()).projects[0];
  expect(project).toMatchObject({
    name: "Agent 完整填空项目",
    owner: "小王",
    description: "文件一次填写全部项目表单",
    progress: 30,
    state: "active",
    update: "完成需求梳理",
  });
  expect(project.workflow).toMatchObject({
    goal: "值班人员能完成检查并交接",
    collaboration: "team",
    wipLimit: 2,
  });
  expect(project.workflow?.tasks[0]).toMatchObject({
    input: "值班样例",
    output: "场景说明",
    receiver: "小陈",
    handoff: { instructions: "阅读操作步骤", nextAction: "小陈试用" },
  });
  expect(project.workflow?.decisions[0].kind).toBe("interface");
  expect(project.workflow?.milestones[0].dueDate).toBe("2027-01-15");
  await page.reload();
  expect((await snapshot()).projects[0]).toEqual(project);
});

test("完整项目更新预览与导出隐私，已执行任务结果受保护", async () => {
  const workflow = createWorkflow("agile", "team");
  workflow.goal = "原目标";
  workflow.tasks = [
    workflowTaskSchema.parse({
      id: "worked",
      title: "真实验收任务",
      state: "done",
      acceptance: "启动成功",
      evidence: "人工验证结果",
    }),
  ];
  await page.evaluate(async (workflow) => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    await api.projects.save({
      id: "existing",
      name: "已有项目",
      owner: "原负责人",
      workflow,
    });
    await api.records.saveNote({
      title: "私人笔记",
      body: "PRIVATE-NOTE-SECRET",
      projectId: "existing",
    });
  }, workflow);
  await openProjects();
  await page
    .getByRole("button", { name: "导入 / 导出项目信息", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "预览完整项目模板", exact: true })
    .click();
  const exported = await dialog().getByLabel("完整项目模板预览").inputValue();
  expect(exported).not.toContain("PRIVATE-NOTE-SECRET");
  const config = JSON.parse(exported);
  Object.assign(config.project, {
    name: "Agent 更新后的项目",
    owner: "新负责人",
    description: "补全项目说明",
    progress: 60,
  });
  config.project.workflow.goal = "文件填入的新目标";
  config.project.workflow.tasks[0].evidence = "不能覆盖人工结果";
  await dialog()
    .getByLabel("完整项目 JSON", { exact: true })
    .fill(JSON.stringify(config));
  await dialog()
    .getByRole("button", { name: "校验并预览", exact: true })
    .click();
  await expect(dialog().getByLabel("项目导入预览")).toContainText("原负责人");
  await expect(dialog().getByLabel("项目导入预览")).toContainText("新负责人");
  expect((await snapshot()).projects[0].owner).toBe("原负责人");
  await dialog()
    .getByRole("button", { name: "确认更新项目", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  const data = await snapshot();
  expect(data.projects[0]).toMatchObject({
    name: "Agent 更新后的项目",
    description: "补全项目说明",
    owner: "新负责人",
    progress: 60,
  });
  expect(data.projects[0].workflow?.goal).toBe("文件填入的新目标");
  expect(data.projects[0].workflow?.tasks[0].evidence).toBe("人工验证结果");
  expect(data.notes[0].body).toBe("PRIVATE-NOTE-SECRET");
});

test("错误和过期项目导入不写入，文本保留并可重新预览", async () => {
  await page.evaluate(async () =>
    (window as unknown as { kanban: DesktopAPI }).kanban.projects.save({
      id: "target",
      name: "保持原样",
    }),
  );
  await openProjects();
  await page
    .getByRole("button", { name: "导入 / 导出项目信息", exact: true })
    .click();
  const input = dialog().getByLabel("完整项目 JSON", { exact: true });
  await input.fill(
    JSON.stringify({
      schema_version: 1,
      kind: "kanban-project",
      project: { name: "不应写入", unknown: true },
    }),
  );
  await dialog()
    .getByRole("button", { name: "校验并预览", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toBeVisible();
  expect((await snapshot()).projects[0].name).toBe("保持原样");
  const text = JSON.stringify({
    schema_version: 1,
    kind: "kanban-project",
    project: { name: "确认后修改" },
  });
  await input.fill(text);
  await dialog()
    .getByRole("button", { name: "校验并预览", exact: true })
    .click();
  await expect(dialog().getByLabel("项目导入预览")).toBeVisible();
  await page.evaluate(async () => {
    const api = (window as unknown as { kanban: DesktopAPI }).kanban;
    const data = await api.snapshot();
    await api.records.saveLog({ body: "其他窗口写入", date: data.today });
  });
  await dialog()
    .getByRole("button", { name: "确认更新项目", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(/变化|重新/);
  await expect(input).toHaveValue(text);
  expect((await snapshot()).projects[0].name).toBe("保持原样");
  await dialog()
    .getByRole("button", { name: "校验并预览", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "确认更新项目", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  expect((await snapshot()).projects[0].name).toBe("确认后修改");
});

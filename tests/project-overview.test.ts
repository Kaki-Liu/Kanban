import { expect, test } from "vitest";
import { projectOverview } from "../src/shared/project-overview";
import { projectSchema, itemSchema, type Run } from "../src/shared/contracts";
import { createWorkflow } from "../src/shared/workflow-templates";
import { workflowTaskSchema } from "../src/shared/workflow";

test("开发项目展示验收进度、待验收和真实受阻任务", () => {
  const workflow = createWorkflow("kanban");
  workflow.milestones[0].state = "completed";
  workflow.milestones[0].evidence = "已检查";
  workflow.tasks = [
    workflowTaskSchema.parse({ id: "a", title: "待验收", state: "review" }),
    workflowTaskSchema.parse({ id: "b", title: "等待前置任务", dependsOn: ["a"] }),
    workflowTaskSchema.parse({ id: "c", title: "等待账号", blocker: "缺少账号" }),
    workflowTaskSchema.parse({ id: "d", title: "已完成", state: "done", evidence: "通过" }),
  ];
  const project = { ...projectSchema.parse({ name: "开发项目" }), id: "project", workflow };
  expect(projectOverview(project, [])).toMatchObject({ total: 4, done: 1, review: 1, blocked: 2, next: { id: "a", workflow: true } });
  expect(projectOverview(project, []).progress).toBe(Math.round(100 / workflow.milestones.length));
});

test("普通项目保留人工进度且不混入检查、撤销事项或其他项目", () => {
  const project = { ...projectSchema.parse({ name: "普通项目", progress: 35 }), id: "project" };
  const run = (id: string, state: Run["state"]): Run => ({
    id, templateId: id, date: "2026-11-04", state, checks: {},
    startedAt: null, completedAt: null, changedAt: "", manual: false, skipReason: "",
    config: itemSchema.parse({ id, title: id, type: "task", project_id: project.id, schedule: { frequency: "once", date: "2026-11-04" } }),
  });
  const other = run("other", "pending");
  other.config.project_id = "another";
  const check = run("check", "pending");
  check.config.type = "checklist";
  const summary = projectOverview(project, [run("done", "completed"), run("doing", "doing"), run("pending", "pending"), run("cancel", "withdrawn"), other, check]);
  expect(summary).toMatchObject({ progress: 35, total: 3, done: 1, doing: 1, review: 0, blocked: 0, next: { id: "doing", workflow: false } });
});

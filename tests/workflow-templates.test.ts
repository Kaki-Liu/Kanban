import { describe, expect, test } from "vitest";
import { workflowTaskSchema } from "../src/shared/workflow";
import {
  agentBrief,
  createWorkflow,
  guidanceFor,
  mergeWorkflowImport,
  nextActions,
  parseWorkflowImport,
  workflowExport,
  workflowModes,
} from "../src/shared/workflow-templates";

describe("开发路线与 Agent 交换", () => {
  test.each(workflowModes)("$label 可创建、导出和导回", ({ id }) => {
    const workflow = createWorkflow(id);
    expect(workflow.milestones.length).toBeGreaterThan(2);
    expect(workflow.tasks).toHaveLength(0);
    expect(parseWorkflowImport(workflowExport("p", workflow), "p")).toEqual(
      workflow,
    );
    expect(mergeWorkflowImport(workflow, workflow).workflow).toEqual(workflow);
  });
  test("推荐先做已开工的可执行任务，排除受阻、未满足依赖和后续阶段", () => {
    const w = createWorkflow("novice");
    const make = (id: string, extra = {}) =>
      workflowTaskSchema.parse({
        id,
        title: id,
        milestoneId: w.milestones[0].id,
        ...extra,
      });
    w.tasks = [
      make("later", { milestoneId: w.milestones[1].id }),
      make("blocked", { blocker: "等资料" }),
      make("dependent", { dependsOn: ["active"] }),
      make("urgent", { priority: "high" }),
      make("active", { state: "doing" }),
    ];
    expect(nextActions(w).map((t) => t.id)).toEqual(["active", "urgent"]);
    w.milestones[1].state = "active";
    expect(nextActions(w).map((t) => t.id)).toEqual([
      "active",
      "urgent",
      "later",
    ]);
  });
  test("切换路线和自定义名称不会套用无关步骤说明", () => {
    expect(guidanceFor("agile", 0, "说清要解决的问题").example).toContain(
      "值班",
    );
    expect(guidanceFor("agile", 0, "自定义交付").title).toBe(
      "推进自定义里程碑",
    );
  });
  test("拒绝其他项目、未知字段、循环依赖和不存在日期", () => {
    const w = createWorkflow("novice");
    expect(() => parseWorkflowImport(workflowExport("other", w), "p")).toThrow(
      "项目 ID",
    );
    expect(() =>
      parseWorkflowImport(
        JSON.stringify({
          schema_version: 1,
          kind: "development-workflow",
          project_id: "p",
          workflow: w,
          notes: [],
        }),
        "p",
      ),
    ).toThrow();
    w.tasks = [
      workflowTaskSchema.parse({ id: "a", title: "a", dependsOn: ["b"] }),
      workflowTaskSchema.parse({ id: "b", title: "b", dependsOn: ["a"] }),
    ];
    expect(() => workflowExport("p", w)).toThrow();
    expect(() =>
      workflowTaskSchema.parse({
        id: "a",
        title: "a",
        followUpDate: "2026-02-30",
      }),
    ).toThrow();
  });
  test("导入保护已操作任务与沟通，未出现的记录不删除", () => {
    const w = createWorkflow("novice");
    w.tasks = [
      workflowTaskSchema.parse({ id: "worked", title: "保留", state: "doing" }),
      workflowTaskSchema.parse({ id: "missing", title: "不删除" }),
      workflowTaskSchema.parse({
        id: "returned-to-todo",
        title: "曾开始",
        hasStarted: true,
      }),
    ];
    const incoming = structuredClone(w);
    incoming.tasks = [
      { ...w.tasks[0], title: "不能覆盖" },
      { ...w.tasks[2], title: "不能覆盖曾开始" },
    ];
    const merged = mergeWorkflowImport(w, incoming);
    expect(merged.protectedCount).toBe(2);
    expect(merged.workflow.tasks.map((t) => t.title)).toEqual([
      "保留",
      "不删除",
      "曾开始",
    ]);
  });
  test("Agent 自报完成和接收仍需本地验收，说明只含显式项目上下文", () => {
    const w = createWorkflow("novice");
    const incoming = structuredClone(w);
    incoming.tasks = [
      workflowTaskSchema.parse({
        id: "agent",
        title: "实现",
        state: "done",
        acceptance: "可运行",
        evidence: "Agent 报告",
        receiver: "同事",
        handoff: {
          status: "accepted",
          artifacts: "安装包",
          verification: "Agent 声称",
        },
      }),
    ];
    const merged = mergeWorkflowImport(w, incoming).workflow;
    expect(merged.tasks[0].state).toBe("review");
    expect(merged.tasks[0].handoff.status).toBe("submitted");
    const text = agentBrief("项目", { ...w, privateNotes: "秘密" } as typeof w);
    expect(text).not.toContain("秘密");
    expect(text).toContain("不要代替其他人确认接收");
  });
});

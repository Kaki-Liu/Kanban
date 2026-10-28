import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const text = z.string().max(100000).default("");
const short = z.string().max(500).default("");
const date = z
  .string()
  .refine((value) => {
    if (value === "") return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "日期不存在，请使用 YYYY-MM-DD")
  .default("");

export const participantSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(200),
    role: short,
    contact: short,
  })
  .strict();
export const milestoneSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(200),
    goal: text,
    acceptance: text,
    state: z.enum(["pending", "active", "completed"]).default("pending"),
    dueDate: date.optional(),
    evidence: text,
  })
  .strict();
export const handoffSchema = z
  .object({
    status: z
      .enum(["draft", "submitted", "received", "accepted", "returned"])
      .default("draft"),
    artifacts: text,
    instructions: text,
    verification: text,
    risks: text,
    nextAction: text,
    note: text,
  })
  .strict();
export const workflowTaskSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(200),
    milestoneId: z.string().max(200).default(""),
    owner: short,
    contributors: short,
    reviewer: short,
    receiver: short,
    boundary: text,
    input: text,
    output: text,
    acceptance: text,
    dependsOn: z.array(id).max(500).default([]),
    state: z.enum(["todo", "doing", "review", "done"]).default("todo"),
    hasStarted: z.boolean().default(false),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    blocker: text,
    followUpDate: date,
    evidence: text,
    handoff: handoffSchema.prefault({}),
  })
  .strict();
export const decisionSchema = z
  .object({
    id,
    kind: z.enum(["decision", "change", "interface"]).default("decision"),
    topic: z.string().trim().min(1).max(500),
    people: short,
    conclusion: text,
    impact: text,
    date,
    followUpDate: date,
    status: z.enum(["pending", "confirmed"]).default("pending"),
  })
  .strict();

export const workflowSchema = z
  .object({
    mode: z.enum([
      "novice",
      "prototype",
      "agile",
      "kanban",
      "staged",
      "shapeup",
    ]),
    collaboration: z.enum(["solo", "team", "cross"]).default("solo"),
    guidance: z.enum(["detailed", "compact"]).default("detailed"),
    wipLimit: z.number().int().min(1).max(20).optional(),
    goal: text,
    scope: text,
    outOfScope: text,
    acceptance: text,
    participants: z.array(participantSchema).max(100).default([]),
    milestones: z.array(milestoneSchema).max(100).default([]),
    tasks: z.array(workflowTaskSchema).max(500).default([]),
    decisions: z.array(decisionSchema).max(500).default([]),
  })
  .strict()
  .superRefine((workflow, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    for (const key of [
      "participants",
      "milestones",
      "tasks",
      "decisions",
    ] as const) {
      const seen = new Set<string>();
      workflow[key].forEach((entry, index) => {
        if (seen.has(entry.id))
          issue([key, index, "id"], "同类记录的 id 不能重复");
        seen.add(entry.id);
      });
    }
    const milestones = new Set(workflow.milestones.map((entry) => entry.id));
    const tasks = new Map(workflow.tasks.map((entry) => [entry.id, entry]));
    workflow.tasks.forEach((task, index) => {
      const path = ["tasks", index];
      if (task.milestoneId && !milestones.has(task.milestoneId))
        issue([...path, "milestoneId"], "关联的里程碑不存在");
      if (new Set(task.dependsOn).size !== task.dependsOn.length)
        issue([...path, "dependsOn"], "依赖不能重复");
      task.dependsOn.forEach((dependency, dependencyIndex) => {
        if (!tasks.has(dependency))
          issue([...path, "dependsOn", dependencyIndex], "依赖任务不存在");
        else if (dependency === task.id)
          issue([...path, "dependsOn", dependencyIndex], "任务不能依赖自己");
        else if (
          task.state === "done" &&
          tasks.get(dependency)?.state !== "done"
        )
          issue(
            [...path, "dependsOn", dependencyIndex],
            "依赖完成后才能完成此任务",
          );
      });
      if (task.state === "done") {
        if (!task.acceptance.trim())
          issue([...path, "acceptance"], "完成前需要填写验收标准");
        if (!task.evidence.trim())
          issue([...path, "evidence"], "完成前需要记录验证结果");
        if (task.blocker.trim())
          issue([...path, "blocker"], "请先解除阻碍再完成任务");
        if (task.receiver.trim() && task.handoff.status !== "accepted")
          issue(
            [...path, "handoff", "status"],
            "有接收人的任务需要交接验收通过后才能完成",
          );
      }
      if (["submitted", "received", "accepted"].includes(task.handoff.status)) {
        if (!task.receiver.trim())
          issue([...path, "receiver"], "提交交接前需要填写接收人");
        if (!task.handoff.artifacts.trim())
          issue([...path, "handoff", "artifacts"], "请提供交付物及版本或位置");
      }
      if (
        task.handoff.status === "accepted" &&
        !task.handoff.verification.trim()
      )
        issue(
          [...path, "handoff", "verification"],
          "交接验收通过需要记录验证结果",
        );
      if (task.handoff.status === "returned" && !task.handoff.note.trim())
        issue([...path, "handoff", "note"], "退回交接时请说明需要补充的内容");
    });
    const visited = new Set<string>(),
      visiting = new Set<string>();
    function visit(taskId: string): boolean {
      if (visiting.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visiting.add(taskId);
      for (const dependency of tasks.get(taskId)?.dependsOn || []) {
        if (visit(dependency)) return true;
      }
      visiting.delete(taskId);
      visited.add(taskId);
      return false;
    }
    if (workflow.tasks.some((task) => visit(task.id)))
      issue(["tasks"], "任务依赖存在循环，请调整依赖关系");
    workflow.milestones.forEach((milestone, index) => {
      if (milestone.state !== "completed") return;
      if (!milestone.evidence.trim())
        issue(["milestones", index, "evidence"], "里程碑完成需要验收依据");
      if (
        workflow.tasks.some(
          (task) => task.milestoneId === milestone.id && task.state !== "done",
        )
      )
        issue(["milestones", index, "state"], "里程碑仍有未完成的任务");
    });
    workflow.decisions.forEach((decision, index) => {
      if (decision.status === "confirmed" && !decision.conclusion.trim())
        issue(["decisions", index, "conclusion"], "确认沟通前请记录结论");
    });
  });

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowMode = Workflow["mode"];
export type WorkflowTask = z.infer<typeof workflowTaskSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type Decision = z.infer<typeof decisionSchema>;

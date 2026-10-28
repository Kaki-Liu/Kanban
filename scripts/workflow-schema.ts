import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  createWorkflow,
  workflowImportSchema,
} from "../src/shared/workflow-templates";
import { workflowTaskSchema } from "../src/shared/workflow";

mkdirSync("examples", { recursive: true });
writeFileSync(
  "examples/workflow.schema.json",
  JSON.stringify(
    z.toJSONSchema(workflowImportSchema, { target: "draft-7", io: "input" }),
    null,
    2,
  ) + "\n",
  "utf8",
);

const workflow = createWorkflow("novice", "team", "detailed");
workflow.goal = "让值班人员按时完成检查，并记录结果供负责人查看。";
workflow.scope = "本地创建检查、定时提醒、完成记录和工作素材导出。";
workflow.outOfScope = "首版不做账号、服务器、跨电脑同步或自动发送消息。";
workflow.acceptance =
  "关闭主窗口仍会提醒；重启后结果保留；可整理一周工作素材。";
workflow.participants = [
  {
    id: "project-owner",
    name: "项目负责人",
    role: "确认范围和优先级",
    contact: "由本地操作者联系",
  },
  {
    id: "reviewer",
    name: "值班负责人",
    role: "提供检查样例并试用验收",
    contact: "",
  },
];
workflow.milestones.forEach((milestone, index) => {
  milestone.id = `milestone-${index + 1}`;
});
workflow.tasks = [
  workflowTaskSchema.parse({
    id: "confirm-first-scenario",
    title: "确认一次值班检查的完整场景",
    milestoneId: "milestone-1",
    owner: "项目负责人",
    reviewer: "值班负责人",
    receiver: "值班负责人",
    boundary: "确认首版使用场景与验收条件，不承诺未来同步能力。",
    input: "值班负责人提供检查内容和时间样例。",
    output: "一份双方能理解的场景说明和验收清单。",
    acceptance: "说明谁在什么时候检查什么，以及怎样判断已完成。",
    priority: "high",
  }),
];
workflow.decisions = [
  {
    id: "confirm-offline-scope",
    kind: "decision",
    topic: "确认首版仅在本机使用",
    people: "项目负责人、值班负责人",
    conclusion: "",
    impact: "影响账户、服务器和数据同步是否进入本版。",
    date: "",
    followUpDate: "",
    status: "pending",
  },
];
const example = workflowImportSchema.parse({
  schema_version: 1,
  kind: "development-workflow",
  project_id: "replace-with-exported-project-id",
  workflow,
});
writeFileSync(
  "examples/development-workflow.json",
  JSON.stringify(example, null, 2) + "\n",
  "utf8",
);

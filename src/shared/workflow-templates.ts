import { z } from "zod";
import {
  workflowSchema,
  type Workflow,
  type WorkflowMode,
  type WorkflowTask,
} from "./workflow";

export const workflowModes: {
  id: WorkflowMode;
  label: string;
  subtitle: string;
  description: string;
}[] = [
  {
    id: "novice",
    label: "新手带做",
    subtitle: "完成第一个版本",
    description: "一步一步明确目标、做通核心流程，直到安装试用。",
  },
  {
    id: "prototype",
    label: "先验证想法",
    subtitle: "原型 / 精益验证",
    description: "先做小样并收集反馈，再决定是否投入开发。",
  },
  {
    id: "agile",
    label: "每周交付一点",
    subtitle: "敏捷迭代 · 参考 Scrum",
    description: "每轮一个可验证目标，演示反馈后调整下一轮。",
  },
  {
    id: "kanban",
    label: "有空推进一项",
    subtitle: "Kanban 持续改进",
    description: "按优先级拉取任务，减少同时开工，先完成再开始。",
  },
  {
    id: "staged",
    label: "按阶段完成交付",
    subtitle: "阶段式开发",
    description: "范围明确时，按需求、方案、实现、验收逐步交付。",
  },
  {
    id: "shapeup",
    label: "限定投入做功能",
    subtitle: "参考 Shape Up",
    description: "先限定时间投入，再取舍范围，避免功能无限膨胀。",
  },
];

type Step = {
  title: string;
  action: string;
  example: string;
  done: string;
  blocked: string;
};
const step = (
  title: string,
  action: string,
  example: string,
  done: string,
  blocked: string,
): Step => ({ title, action, example, done, blocked });
const routes: Record<WorkflowMode, Step[]> = {
  novice: [
    step(
      "说清要解决的问题",
      "写下谁在什么情况下遇到什么麻烦，以及想得到的结果。",
      "值班时容易忘记查告警，希望到点提醒并记录检查结果。",
      "有一个真实场景、一句目标，并知道谁来试用。",
      "先选最常发生或最费时间的一件事，不必列全所有功能。",
    ),
    step(
      "划定首版范围",
      "选一条核心使用流程，列出本次不做的功能与验收条件。",
      "首版只做创建检查 → 提醒 → 完成记录，暂不做账户同步。",
      "能按实际操作判断首版成功与否。",
      "把愿望分成必须有和以后再做，只保留支持核心流程的内容。",
    ),
    step(
      "确认界面与操作",
      "画草图或让 Agent 做演示，按使用者身份走一遍。",
      "从哪里新增检查、如何改时间、在哪里看完成结果。",
      "能够描述每一步操作和对应结果，疑问有记录。",
      "先画纸面草图，不确定的地方标出来找使用者确认。",
    ),
    step(
      "让程序第一次运行",
      "让 Agent 根据已确定范围提出实现方案并运行基础程序，记录启动方式。",
      "在 Windows 打开程序，看到主页面并能再次启动。",
      "程序可运行，启动方法已记录，关键技术风险有验证。",
      "把报错、运行环境和复现步骤复制给 Agent，先解决运行问题。",
    ),
    step(
      "做通核心流程",
      "完成一个从输入到结果的真实场景，立即验证保存与重启。",
      "创建两分钟后的提醒 → 关闭窗口 → 收到提醒 → 完成 → 重启查看。",
      "真实样例跑通，预期结果和异常情况有验证记录。",
      "一次只排查一个失败步骤，避免同时补所有功能。",
    ),
    step(
      "分批补齐功能",
      "每次添加一个必要功能，验证正常与失败情况，再继续下一项。",
      "新增编辑检查项，同时验证取消、空内容和保存失败。",
      "本次范围逐项有实现结果和验收依据。",
      "拆小任务；新想法先记入下一版，不直接扩大本版。",
    ),
    step(
      "验收与安装交付",
      "按清单试用打包版本，检查安装、数据保留和使用说明。",
      "安装新版，重启后原检查记录仍可查看。",
      "有可使用版本、实际验证记录、已知问题及启动说明。",
      "未通过的项目转成修复任务；不能用开发版结果代替安装版验证。",
    ),
    step(
      "试用反馈与下一版",
      "收集真实使用问题，确认下一轮最值得改的一件事。",
      "用一周后发现查找历史不方便，下一版优先改善查询。",
      "本版有结论，反馈进入下一轮，不无限延长当前版本。",
      "先区分故障、使用困难与新功能，选择影响最大的一个。",
    ),
  ],
  prototype: [
    step(
      "提出待验证的问题",
      "写下最不确定的假设和观察标准。",
      "同事能否不看说明完成一次值班检查？",
      "有明确问题、试用对象和判断依据。",
      "先问现在怎么做，不急着设计所有页面。",
    ),
    step(
      "制作最小原型",
      "只演示验证问题需要的页面和操作。",
      "画出创建、提醒、完成三个画面。",
      "可以让试用者走完目标场景；明确它只是原型。",
      "用纸面或静态页面替代复杂后台。",
    ),
    step(
      "观察真实试用",
      "请试用者自己操作，记录卡点和实际反应。",
      "观察对方是否找到完成按钮，不先口头教操作。",
      "有具体观察和问题，而不只有好不好看的评价。",
      "找不到试用者时先安排时间，不把自己的猜测当结论。",
    ),
    step(
      "决定下一步",
      "根据观察选择继续开发、修改假设或停止。",
      "核心流程容易理解，进入新手带做完成可运行首版。",
      "决定、依据与下一步已记录；原型通过不等于软件交付。",
      "结论不清楚就缩小验证问题，再做一轮。",
    ),
  ],
  agile: [
    step(
      "准备需求与验收",
      "收集场景并排序，给近期需求补充验收标准。",
      "本周优先解决关闭窗口后无法提醒。",
      "近期需求可解释、可验证，首轮环境能运行。",
      "不清楚的需求先澄清，不直接放进开发。",
    ),
    step(
      "确定本轮目标",
      "约定本轮结束日期和一个可演示结果，挑选支持它的任务。",
      "本周五前，用户能在关闭主窗口后收到提醒。",
      "目标、范围与验收清楚，任务适合本轮容量。",
      "减小范围，不靠增加同时开工数量追进度。",
    ),
    step(
      "实现并持续验证",
      "完成一个小任务就检查结果，每天先处理阻碍和待验收项。",
      "先验证后台调度，再接提醒窗口并验证完整流程。",
      "目标能力可运行，任务都有验证结果。",
      "新增需求记录影响，与负责人确认是否影响本轮目标。",
    ),
    step(
      "演示与回顾",
      "实际演示结果，记录反馈及下一轮的一项改进。",
      "请值班人员试用，确认提醒是否打断输入。",
      "通过项和遗留项明确，下一轮重新评估未完成工作。",
      "未完成不算通过；添加下一轮里程碑保留历史。",
    ),
  ],
  kanban: [
    step(
      "整理与准备工作",
      "收集问题，明确优先级、输入和完成条件。",
      "保存失败是故障，导出图表是后续改进。",
      "任务已分类，有负责人和可执行的下一步。",
      "信息不足的任务先补资料，暂不开始。",
    ),
    step(
      "限量开始与推进",
      "优先完成已开工项，个人建议同时推进一项主要任务。",
      "先修完保存失败，再开始导出功能。",
      "每项在做工作都有明确动作，阻碍及时记录。",
      "优先解除阻碍或完成验收，避免不断新开任务。",
    ),
    step(
      "验证并发布",
      "按验收标准验证，必要时交接，记录可使用的版本。",
      "验证正常保存和失败提示，把安装包交给试用者。",
      "功能通过验证，接收人与遗留事项明确。",
      "退回项写明补充内容，修复后再验证。",
    ),
    step(
      "回顾与补充队列",
      "查看长期停留的任务和新反馈，重新排序，添加下一批里程碑。",
      "发现联调等待太久，下次提前确认接口与时间。",
      "有明确下一项工作和一项流程改进。",
      "删减低价值承诺，未确定的需求留在候选清单。",
    ),
  ],
  staged: [
    step(
      "确认需求与边界",
      "与需求提出者确认范围、交付日期和验收材料。",
      "部门确认首版只在一台 Windows 电脑使用。",
      "范围、验收人、标准和暂不做事项有记录。",
      "有分歧先记录待确认决定，不替别人作出承诺。",
    ),
    step(
      "确定方案与接口",
      "确认页面、数据和协作接口，尽早验证主要风险。",
      "约定输入样例、返回格式、错误处理及联调时间。",
      "方案可实施，依赖明确，关键风险已有验证。",
      "先做小范围验证，把未知变成可回答的问题。",
    ),
    step(
      "分批实现与检查",
      "按照依赖实现小块可运行功能，并持续核对需求。",
      "先做创建与保存，再接提醒和历史查询。",
      "约定范围都有可检查的实现结果。",
      "变更单独记录影响，经确认后再调整计划。",
    ),
    step(
      "系统验收",
      "按完整使用场景检查功能、异常和安装，修复发现的问题。",
      "从安装到一整天的值班流程，逐项记录结果。",
      "验收标准通过，遗留问题明确且有处理决定。",
      "验收失败转成可复现的任务，关联原验收项。",
    ),
    step(
      "交接与维护",
      "整理版本、使用方法、验证结果和后续责任，登记接收与验收。",
      "交给值班负责人，说明备份方法和问题反馈位置。",
      "接收和验收分别确认，维护责任明确。",
      "缺少材料按交接退回原因补齐。",
    ),
  ],
  shapeup: [
    step(
      "界定问题与投入",
      "确定值得解决的问题、愿意投入的时间，以及成功结果。",
      "投入一周，让工作记录能够按日期汇总并复制。",
      "问题、投入上限与预期收益明确。",
      "先缩小问题，避免把投入期限当成所有愿望的承诺。",
    ),
    step(
      "划定必做与可裁减范围",
      "给出大致方案，区分必须交付和可推迟内容，排查关键风险。",
      "汇总和复制必须有，图表和美化可以推迟。",
      "范围边界、取舍和风险明确。",
      "关键未知先验证，再决定是否投入。",
    ),
    step(
      "实现完整功能",
      "从一条能用的完整流程开始，持续检查剩余时间和范围。",
      "先完成一周素材的筛选与复制，再补导出。",
      "核心功能可用，必要检查通过。",
      "优先裁减非必要范围，保留质量和核心验收要求。",
    ),
    step(
      "交付或重新评估",
      "到期演示结果，决定交付、缩小范围或重新立项。",
      "交付汇总复制功能，图表单独列入后续候选。",
      "结果及决定有记录，未完成工作不会无条件顺延。",
      "说明剩余问题和重新投入的理由，再做决定。",
    ),
  ],
};

export function createWorkflow(
  mode: WorkflowMode,
  collaboration: Workflow["collaboration"] = "solo",
  guidance: Workflow["guidance"] = "detailed",
): Workflow {
  return workflowSchema.parse({
    mode,
    collaboration,
    guidance,
    milestones: routes[mode].map((s, i) => ({
      id: crypto.randomUUID(),
      title: s.title,
      goal: s.action,
      acceptance: s.done,
      state: i === 0 ? "active" : "pending",
    })),
  });
}

export function guidanceFor(
  mode: WorkflowMode,
  index: number,
  title?: string,
): Step {
  const matched =
    title === undefined
      ? routes[mode][index]
      : Object.values(routes)
          .flat()
          .find((s) => s.title === title);
  return (
    matched ||
    step(
      "推进自定义里程碑",
      "围绕本里程碑目标，拆出下一项可执行任务。",
      "写出一个具体动作和实际检查方法。",
      "里程碑的验收标准满足，并留下结果依据。",
      "先明确缺失的资料、决定或依赖，联系对应负责人。",
    )
  );
}

export function nextActions(workflow: Workflow): WorkflowTask[] {
  const completed = new Set(
    workflow.tasks.filter((t) => t.state === "done").map((t) => t.id),
  );
  const active = workflow.milestones.filter((m) => m.state === "active");
  const currentIds = new Set(
    (active.length
      ? active
      : workflow.milestones.filter((m) => m.state === "pending").slice(0, 1)
    ).map((m) => m.id),
  );
  const priority = { high: 0, normal: 1, low: 2 };
  const state = { doing: 0, review: 1, todo: 2, done: 3 };
  return workflow.tasks
    .filter(
      (t) =>
        t.state !== "done" &&
        !t.blocker.trim() &&
        t.dependsOn.every((id) => completed.has(id)) &&
        (t.state !== "todo" ||
          !currentIds.size ||
          currentIds.has(t.milestoneId) ||
          !t.milestoneId),
    )
    .sort(
      (a, b) =>
        state[a.state] - state[b.state] ||
        priority[a.priority] - priority[b.priority] ||
        (a.followUpDate || "9999").localeCompare(b.followUpDate || "9999"),
    )
    .slice(0, 3);
}

export function agentBrief(
  projectName: string,
  workflow: Workflow,
  task?: WorkflowTask,
): string {
  const milestone = task
    ? workflow.milestones.find((m) => m.id === task.milestoneId)
    : workflow.milestones.find((m) => m.state === "active") ||
      workflow.milestones.find((m) => m.state !== "completed");
  return [
    `# ${projectName} · 开发任务说明`,
    `项目目标：${workflow.goal || "待澄清"}`,
    `本次范围：${workflow.scope || "待澄清"}`,
    `本次不做：${workflow.outOfScope || "待确认"}`,
    `项目验收：${workflow.acceptance || "待补充"}`,
    `当前里程碑：${milestone?.title || "待确定"}\n目标：${milestone?.goal || "待确定"}\n验收：${milestone?.acceptance || "待补充"}`,
    task
      ? `## 本次任务\n${task.title}\n任务 id：${task.id}\n负责人：${task.owner || "待指定"}\n协助：${task.contributors || "无"}\n负责到哪里：${task.boundary || "待明确"}\n所需输入：${task.input || "待明确"}\n预期输出：${task.output || "待明确"}\n验收标准：${task.acceptance || "请先补充"}\n依赖：${task.dependsOn.map((id) => workflow.tasks.find((t) => t.id === id)?.title || id).join("、") || "无"}\n阻碍：${task.blocker || "无"}\n验收人：${task.reviewer || "待指定"}\n接收人：${task.receiver || "无"}`
      : "请先澄清当前步骤所需信息，再拆分少量可执行任务。不要一次生成全部占位任务。",
    `## 已确认的协作约定\n${
      workflow.decisions
        .filter((d) => d.status === "confirmed")
        .map(
          (d) =>
            `- ${d.topic}：${d.conclusion}\n  影响：${d.impact || "未记录"}`,
        )
        .join("\n") || "暂无"
    }`,
    "## 返回要求\n请返回修改内容、验证方法与实际结果、遗留问题和建议下一步。未实际运行的检查请明确说明。不要把代码已生成当作用户验收通过；不要代替其他人确认接收。涉及范围或接口变化时先列出影响。",
  ].join("\n\n");
}

export const workflowImportSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("development-workflow"),
    project_id: z.string().trim().min(1).max(200),
    workflow: workflowSchema,
  })
  .strict();

export function workflowExport(projectId: string, workflow: Workflow): string {
  return JSON.stringify(
    workflowImportSchema.parse({
      schema_version: 1,
      kind: "development-workflow",
      project_id: projectId,
      workflow,
    }),
    null,
    2,
  );
}

export function parseWorkflowImport(text: string, projectId: string): Workflow {
  if (text.length > 2_000_000)
    throw new Error("配置过大，请控制在 2 MB 以内。");
  try {
    const parsed = workflowImportSchema.parse(JSON.parse(text));
    if (parsed.project_id !== projectId)
      throw new Error("项目 ID 不匹配，请使用当前项目导出的配置。");
    return parsed.workflow;
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error(
        error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    throw error;
  }
}

// Agent configurations update planned work; performed work remains a local record.
export function mergeWorkflowImport(
  current: Workflow,
  incoming: Workflow,
): { workflow: Workflow; protectedCount: number } {
  let protectedCount = 0;
  const tasks = new Map(current.tasks.map((t) => [t.id, t]));
  for (const task of incoming.tasks) {
    const previous = tasks.get(task.id);
    if (
      previous &&
      (previous.hasStarted ||
        previous.state !== "todo" ||
        previous.evidence.trim() ||
        previous.blocker.trim() ||
        previous.handoff.status !== "draft")
    ) {
      protectedCount++;
      continue;
    }
    tasks.set(task.id, {
      ...task,
      state: task.state === "done" ? "review" : task.state,
      handoff: {
        ...task.handoff,
        status: ["accepted", "received"].includes(task.handoff.status)
          ? "submitted"
          : task.handoff.status,
      },
    });
  }
  const milestones = new Map(current.milestones.map((m) => [m.id, m]));
  for (const m of incoming.milestones) {
    if (milestones.get(m.id)?.state === "completed") {
      protectedCount++;
      continue;
    }
    milestones.set(m.id, {
      ...m,
      state: m.state === "completed" ? "active" : m.state,
    });
  }
  const decisions = new Map(current.decisions.map((d) => [d.id, d]));
  for (const d of incoming.decisions) {
    if (decisions.get(d.id)?.status === "confirmed") {
      protectedCount++;
      continue;
    }
    decisions.set(d.id, { ...d, status: "pending" });
  }
  const participants = new Map(current.participants.map((p) => [p.id, p]));
  incoming.participants.forEach((p) => participants.set(p.id, p));
  return {
    workflow: workflowSchema.parse({
      ...incoming,
      tasks: [...tasks.values()],
      milestones: [...milestones.values()],
      decisions: [...decisions.values()],
      participants: [...participants.values()],
    }),
    protectedCount,
  };
}

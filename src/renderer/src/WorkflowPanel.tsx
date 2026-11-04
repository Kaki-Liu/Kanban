import React, { useEffect, useId, useRef, useState } from "react";
import type { Project } from "../../shared/contracts";
import {
  workflowSchema,
  type Workflow,
  type WorkflowMode,
  type WorkflowTask,
  type Milestone,
  type Decision,
} from "../../shared/workflow";
import {
  workflowModes,
  createWorkflow,
  guidanceFor,
  nextActions,
  agentBrief,
  workflowExport,
  parseWorkflowImport,
  mergeWorkflowImport,
} from "../../shared/workflow-templates";
import "./workflow.css";
import { workflowFieldHelp } from "./workflow-field-help";
import { projectConfigAgentPrompt, projectConfigText } from "../../shared/project-config";

const taskStates = {
  todo: "待开始",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
};
const handoffStates = {
  draft: "准备交接",
  submitted: "已提交",
  received: "已接收",
  accepted: "验收通过",
  returned: "退回补充",
};
const collabNames = {
  solo: "个人开发",
  team: "小组合作",
  cross: "跨部门／委托开发",
};
const priorities = { high: "优先", normal: "普通", low: "稍后" };
const uuid = () => crypto.randomUUID();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function WorkbenchDisclosure({
  projectId,
  summary,
  dirty,
  children,
}: {
  projectId: string;
  summary: string;
  dirty: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `kanban:workbench:${projectId}:expanded`;
  const contentId = useId();
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // A local display preference must not block editing if storage is unavailable.
    }
  };
  return (
    <section className="workflow-panel" aria-label="项目开发流程">
      <button
        className="wf-collapse-toggle"
        aria-label={expanded ? "收起开发工作台" : "展开开发工作台"}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={toggle}
      >
        <span className="wf-disclosure-chevron" aria-hidden="true">
          ›
        </span>
        <span className="wf-disclosure-label">
          <strong>开发工作台</strong>
          <small>{summary}</small>
        </span>
        {dirty && <span className="wf-disclosure-dirty">有未保存的修改</span>}
        <span className="wf-disclosure-action">
          {expanded ? "收起" : "展开"}
        </span>
      </button>
      <div
        id={contentId}
        className={`wf-collapse-body${expanded ? " is-open" : ""}`}
        inert={!expanded}
        aria-hidden={!expanded}
      >
        <div className="wf-collapse-content">
          <div className="wf-content">{children}</div>
        </div>
      </div>
    </section>
  );
}

function FieldCaption({ label }: { label: string }) {
  return (
    <span className="wf-field-label" title={workflowFieldHelp[label]?.description}>
      {label}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline = false,
  placeholder = "",
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  const help = workflowFieldHelp[label];
  return (
    <label>
      <FieldCaption label={label} />
      {multiline ? (
        <textarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={help?.example || placeholder}
          aria-description={help?.description}
          rows={3}
          required={required}
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={help?.example || placeholder}
          aria-description={help?.description}
          required={required}
        />
      )}
    </label>
  );
}

function newTask(
  milestone: Milestone | undefined,
  owner: string,
): WorkflowTask {
  return {
    id: uuid(),
    title: "",
    milestoneId: milestone?.id || "",
    owner,
    contributors: "",
    reviewer: "",
    receiver: "",
    boundary: "",
    input: "",
    output: "",
    acceptance: milestone?.acceptance || "",
    dependsOn: [],
    state: "todo",
    hasStarted: false,
    priority: "normal",
    blocker: "",
    followUpDate: "",
    evidence: "",
    handoff: {
      status: "draft",
      artifacts: "",
      instructions: "",
      verification: "",
      risks: "",
      nextAction: "",
      note: "",
    },
  };
}

export function WorkflowPanel({
  project,
  revision,
  today,
  onReminder,
  onDirty,
  onProjectConfig,
}: {
  project: Project;
  revision: number;
  today: string;
  onReminder: (title: string, body: string, date: string) => void;
  onDirty?: (dirty: boolean) => void;
  onProjectConfig?: () => void;
}) {
  const [workflow, setWorkflow] = useState<Workflow>(
    () => project.workflow || createWorkflow("novice"),
  );
  const [enabled, setEnabled] = useState(Boolean(project.workflow));
  const [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("overview");
  const [milestoneId, setMilestoneId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [decisionId, setDecisionId] = useState("");
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<{
    workflow: Workflow;
    revision: number;
    protectedCount: number;
  } | null>(null);
  const [exportText, setExportText] = useState("");
  const [exportTitle, setExportTitle] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(
    !project.workflow?.goal.trim(),
  );
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(
    () => () => {
      dirtyCallback.current?.(false);
    },
    [],
  );
  useEffect(() => {
    if (!dirty && !busy && revision >= baseRevision) {
      if (project.workflow) {
        setWorkflow(project.workflow);
        setEnabled(true);
      } else if (enabled) {
        setWorkflow(createWorkflow("novice"));
        setEnabled(false);
        setSettingsOpen(true);
        setMilestoneId("");
        setTaskId("");
        setDecisionId("");
        setPreview(null);
        setExportText("");
      }
      setBaseRevision(revision);
    }
  }, [project.workflow, revision, dirty, busy, baseRevision, enabled]);

  function change(next: Workflow) {
    setWorkflow(next);
    setDirty(true);
    setNotice("");
    setError("");
    setPreview(null);
  }
  function update(patch: Partial<Workflow>) {
    change({ ...workflow, ...patch });
  }
  function updateTask(task: WorkflowTask) {
    update({ tasks: workflow.tasks.map((t) => (t.id === task.id ? task : t)) });
  }
  function updateMilestone(milestone: Milestone) {
    update({
      milestones: workflow.milestones.map((m) =>
        m.id === milestone.id ? milestone : m,
      ),
    });
  }
  function updateDecision(decision: Decision) {
    update({
      decisions: workflow.decisions.map((d) =>
        d.id === decision.id ? decision : d,
      ),
    });
  }
  async function save(next = workflow, expected = baseRevision) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const checked = workflowSchema.safeParse(next);
      if (!checked.success)
        throw new Error(
          checked.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("\n"),
        );
      await window.kanban.projects.saveWorkflow(
        project.id,
        checked.data,
        expected,
      );
      setWorkflow(checked.data);
      setEnabled(true);
      setDirty(false);
      setPreview(null);
      setBaseRevision(expected + 1);
      setNotice("开发流程已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function reload() {
    if (
      dirty &&
      !window.confirm("重新载入会放弃当前未保存的流程修改，是否继续？")
    )
      return;
    setWorkflow(project.workflow || createWorkflow("novice"));
    setEnabled(Boolean(project.workflow));
    setSettingsOpen(!project.workflow?.goal.trim());
    setBaseRevision(revision);
    setDirty(false);
    setError("");
    setPreview(null);
    setTaskId("");
    setDecisionId("");
    setMilestoneId("");
    setExportText("");
  }
  function showExport(title: string, text: string | (() => string)) {
    try {
      setExportText(typeof text === "function" ? text() : text);
      setExportTitle(title);
    } catch (e) {
      setError(`请先补全当前配置：${errorText(e)}`);
    }
  }
  function askAgent() {
    showExport("让 Agent 通过问答补全项目", () =>
      projectConfigAgentPrompt(projectConfigText({ ...project, workflow })),
    );
  }
  async function copy(text: string) {
    try {
      await window.kanban.window.copyText(text);
      setNotice("已复制，可以粘贴到外部工具");
    } catch {
      setError("复制失败，请在预览文本中全选并复制。");
    }
  }
  function addTask(milestone?: Milestone, guided = false) {
    const task = newTask(milestone, project.owner);
    if (guided && milestone) {
      task.title = milestone.title;
      task.boundary = milestone.goal;
    }
    update({ tasks: [...workflow.tasks, task] });
    setTaskId(task.id);
    setTab("tasks");
  }
  function removeTask(task: WorkflowTask) {
    if (
      task.hasStarted ||
      task.state !== "todo" ||
      task.evidence ||
      task.handoff.status !== "draft"
    ) {
      setError("已处理的任务需要保留记录，可补充说明或重新打开。");
      return;
    }
    if (workflow.tasks.some((t) => t.dependsOn.includes(task.id))) {
      setError("其他任务依赖此任务，请先调整依赖关系。");
      return;
    }
    if (task.title && !window.confirm(`移除尚未开始的任务“${task.title}”？`))
      return;
    update({ tasks: workflow.tasks.filter((t) => t.id !== task.id) });
    setTaskId("");
  }
  function remind(title: string, body: string, date: string) {
    if (dirty) {
      setError("请先保存开发流程，再创建跟进提醒。");
      return;
    }
    onReminder(title, body, date || today);
  }
  const activeStep =
    workflow.milestones.find((m) => m.state === "active") ||
    workflow.milestones.find((m) => m.state !== "completed");
  const current =
    workflow.milestones.find((m) => m.id === milestoneId) ||
    activeStep ||
    workflow.milestones[0];
  const currentIndex = Math.max(
    0,
    workflow.milestones.findIndex((m) => m.id === current?.id),
  );
  const guide = guidanceFor(workflow.mode, currentIndex, current?.title);
  const selectedTask = workflow.tasks.find((t) => t.id === taskId);
  const selectedDecision = workflow.decisions.find((d) => d.id === decisionId);
  const actions = nextActions(workflow);
  const activeMode = workflowModes.find((m) => m.id === workflow.mode);
  const waiting = workflow.tasks.filter(
    (t) =>
      t.state !== "done" &&
      (t.blocker ||
        t.state === "review" ||
        ["submitted", "received", "returned"].includes(t.handoff.status)),
  );
  const openDecisions = workflow.decisions.filter(
    (d) => d.status === "pending",
  );
  const stepHasPendingTasks = workflow.tasks.some(
    (task) => task.milestoneId === activeStep?.id && task.state !== "done",
  );

  return (
    <WorkbenchDisclosure
      projectId={project.id}
      summary={
        enabled
          ? `${activeMode?.label} · ${workflow.milestones.filter((m) => m.state === "completed").length}/${workflow.milestones.length} 个里程碑已验收`
          : "按需展开，选择开发路线与协作方式"
      }
      dirty={dirty}
    >
      {error && (
        <div className="wf-error" role="alert">
          <p>{error}</p>
          <button onClick={reload} disabled={busy}>
            重新载入已保存内容
          </button>
        </div>
      )}
      {notice && (
        <p className="wf-notice" role="status">
          {notice}
        </p>
      )}
      {enabled && dirty && revision !== baseRevision && (
        <p className="wf-warning">
          数据在编辑期间发生变化。当前草稿仍保留，保存时会检查冲突；可先复制
          Agent 配置留存，再重新载入。
        </p>
      )}
      <fieldset disabled={busy}>
        {!enabled ? (
          <div className="wf-setup">
            <Field
              label="项目目标"
              value={workflow.goal}
              onChange={(goal) => update({ goal })}
              placeholder="谁会使用？希望解决什么问题？"
              multiline
              required
            />
            <details className="wf-details">
              <summary>开发方式 · {activeMode?.label}</summary>
              <div className="wf-mode-grid">
                {workflowModes.map((mode) => (
                  <button
                    key={mode.id}
                    className={`wf-mode ${workflow.mode === mode.id ? "selected" : ""}`}
                    aria-pressed={workflow.mode === mode.id}
                    onClick={() => {
                      const created = createWorkflow(
                        mode.id,
                        workflow.collaboration,
                        workflow.guidance,
                      );
                      change({
                        ...created,
                        goal: workflow.goal,
                        scope: workflow.scope,
                        outOfScope: workflow.outOfScope,
                        acceptance: workflow.acceptance,
                      });
                    }}
                  >
                    <strong>{mode.label}</strong>
                    <small>{mode.subtitle}</small>
                    <span>{mode.description}</span>
                  </button>
                ))}
              </div>
              <div className="wf-grid">
                <label>
                  <FieldCaption label="协作方式" />
                  <select
                    value={workflow.collaboration}
                    onChange={(e) =>
                      update({
                        collaboration: e.target
                          .value as Workflow["collaboration"],
                      })
                    }
                  >
                    {Object.entries(collabNames).map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <FieldCaption label="引导程度" />
                  <select
                    value={workflow.guidance}
                    onChange={(e) =>
                      update({ guidance: e.target.value as Workflow["guidance"] })
                    }
                  >
                    <option value="detailed">详细：每一步带着做</option>
                    <option value="compact">精简：提示关键节点</option>
                  </select>
                </label>
              </div>
            </details>
            <button
              className="primary"
              disabled={!workflow.goal.trim()}
              onClick={() => void save()}
            >
              开始规划
            </button>
            <button className="text-button" onClick={askAgent}>让 Agent 帮我补全</button>
          </div>
        ) : (
          <>
            <div className="wf-tabs" aria-label="开发流程视图">
              {[
                ["overview", "当前行动"],
                ["tasks", "开发任务"],
                ["route", "计划与设置"],
                ["collaboration", "协作与交接"],
                ["agent", "Agent 配置"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={tab === id}
                  onClick={() => {
                    setTab(id);
                    if (id === "tasks") setTaskId("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "overview" && (
              <div className="wf-tab-content">
                <p className="wf-project-goal">
                  {workflow.goal || "先说明想为谁解决什么问题。"}
                </p>
                <div className="wf-focus">
                  <span className="wf-kicker">下一步</span>
                  {!workflow.goal.trim() ? (
                    <>
                      <h3>先补充项目目标</h3>
                      <p>
                        描述谁在什么情况下遇到什么麻烦，以及希望得到的结果。
                      </p>
                      <button
                        className="primary"
                        onClick={() => {
                          setTab("route");
                          setSettingsOpen(true);
                        }}
                      >
                        填写项目目标
                      </button>
                    </>
                  ) : actions.length ? (
                    <>
                      <h3>{actions[0].title}</h3>
                      <p>
                        {actions[0].state === "review"
                          ? "实现已提交，下一步按验收标准检查结果，并记录实际验证依据。"
                          : actions[0].state === "doing"
                            ? "继续当前正在处理的事项，先完成再开始下一项。"
                            : "这项任务的依赖已满足，可以开始处理。"}
                      </p>
                      <div className="wf-actions">
                        <button
                          className="primary"
                          onClick={() => {
                            setTaskId(actions[0].id);
                            setTab("tasks");
                          }}
                        >
                          {actions[0].state === "review"
                            ? "查看并验收"
                            : "查看并处理"}
                        </button>
                        <button
                          onClick={() =>
                            showExport(
                              "给 Agent 的任务说明",
                              agentBrief(project.name, workflow, actions[0]),
                            )
                          }
                        >
                          复制给 Agent 前预览
                        </button>
                      </div>
                    </>
                  ) : activeStep ? (
                    <>
                      <h3>{activeStep.title}</h3>
                      <p>
                        {stepHasPendingTasks
                          ? "当前事项可能受阻或等待验收。先查看依赖和等待项，再安排下一步。"
                          : "把这个里程碑拆成一项可以开始的小任务。"}
                      </p>
                      <div className="wf-actions">
                        <button
                          className="primary"
                          onClick={() => {
                            if (stepHasPendingTasks) {
                              setTaskId("");
                              setTab("tasks");
                            } else {
                              addTask(activeStep, true);
                            }
                          }}
                        >
                          {stepHasPendingTasks ? "查看受阻任务" : "开始这一步"}
                        </button>
                        <button onClick={() => setTab("collaboration")}>
                          查看等待事项
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>本轮里程碑已完成</h3>
                      <p>确认交付结果，收集试用反馈，或添加下一轮目标。</p>
                    </>
                  )}
                </div>
                <button onClick={askAgent}>让 Agent 帮我补全</button>
              </div>
            )}
            {tab === "route" && (
              <div className="wf-tab-content">
                <details
                  className="wf-details"
                  open={settingsOpen}
                  onToggle={(e) => setSettingsOpen(e.currentTarget.open)}
                >
                  <summary>目标、范围与流程设置</summary>
                  <Field
                    label="项目目标"
                    value={workflow.goal}
                    onChange={(goal) => update({ goal })}
                    multiline
                  />
                  <div className="wf-grid">
                    <Field
                      label="本次要交付什么"
                      value={workflow.scope}
                      onChange={(scope) => update({ scope })}
                      multiline
                      placeholder="首版必须完成的使用场景"
                    />
                    <Field
                      label="本次暂不做"
                      value={workflow.outOfScope}
                      onChange={(outOfScope) => update({ outOfScope })}
                      multiline
                      placeholder="明确留到以后处理的功能"
                    />
                  </div>
                  <Field
                    label="项目验收清单"
                    value={workflow.acceptance}
                    onChange={(acceptance) => update({ acceptance })}
                    multiline
                    placeholder="每行一个能实际检查的结果"
                  />
                  <div className="wf-grid">
                    <label>
                      <FieldCaption label="开发路线" />
                      <select
                        value={workflow.mode}
                        onChange={(e) =>
                          update({ mode: e.target.value as WorkflowMode })
                        }
                      >
                        {workflowModes.map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <FieldCaption label="协作方式" />
                      <select
                        value={workflow.collaboration}
                        onChange={(e) =>
                          update({
                            collaboration: e.target
                              .value as Workflow["collaboration"],
                          })
                        }
                      >
                        {Object.entries(collabNames).map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <FieldCaption label="引导程度" />
                      <select
                        value={workflow.guidance}
                        onChange={(e) =>
                          update({
                            guidance: e.target.value as Workflow["guidance"],
                          })
                        }
                      >
                        <option value="detailed">详细引导</option>
                        <option value="compact">精简引导</option>
                      </select>
                    </label>
                    <label>
                      <FieldCaption label="同时进行的任务上限" />
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={workflow.wipLimit ?? 1}
                        onChange={(e) =>
                          update({ wipLimit: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <p className="hint">
                    切换路线会改变引导方式，保留已有里程碑、任务和记录。可以编辑里程碑或添加下一轮目标。
                  </p>
                </details>
                <div className="wf-section-heading">
                  <h3>交付路线</h3>
                  <button
                    onClick={() => {
                      const m: Milestone = {
                        id: uuid(),
                        title: "下一轮目标",
                        goal: "",
                        acceptance: "",
                        state: "pending",
                        evidence: "",
                      };
                      update({ milestones: [...workflow.milestones, m] });
                      setMilestoneId(m.id);
                    }}
                  >
                    ＋ 里程碑
                  </button>
                </div>
                <div className="wf-route">
                  {workflow.milestones.map((m, index) => (
                    <button
                      key={m.id}
                      className={m.id === current?.id ? "selected" : ""}
                      onClick={() => setMilestoneId(m.id)}
                    >
                      <span className={`wf-step ${m.state}`}>
                        {m.state === "completed" ? "✓" : index + 1}
                      </span>
                      <span>
                        <strong>{m.title}</strong>
                        <small>
                          {m.state === "completed"
                            ? "已验收"
                            : m.state === "active"
                              ? "当前推进"
                              : "待推进"}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                {current && milestoneId && (
                  <div className="wf-milestone">
                    <div className="wf-section-heading">
                      <h3>{current.title}</h3>
                      <button onClick={() => setMilestoneId("")}>收起里程碑详情</button>
                    </div>
                    <div className="wf-grid">
                      <Field
                        label="里程碑名称"
                        value={current.title}
                        onChange={(title) =>
                          updateMilestone({ ...current, title })
                        }
                      />
                      <label>
                        <FieldCaption label="里程碑状态" />
                        <select
                          value={current.state}
                          onChange={(e) =>
                            updateMilestone({
                              ...current,
                              state: e.target.value as Milestone["state"],
                            })
                          }
                        >
                          <option value="pending">待推进</option>
                          <option value="active">当前推进</option>
                          <option value="completed">已验收</option>
                        </select>
                      </label>
                    </div>
                    {workflow.mode === "agile" && (
                      <p className="hint">
                        目标日期作为本轮结束日期，届时演示结果、记录反馈，再安排下一轮。
                      </p>
                    )}
                    {workflow.mode === "shapeup" && (
                      <p className="hint">
                        到期交付或重新评估范围与投入，不自动延期。
                      </p>
                    )}
                    {current.dueDate &&
                      current.dueDate <= today &&
                      current.state !== "completed" && (
                        <p className="wf-warning">
                          已到本里程碑目标日期，请检查交付结果或记录调整决定。
                        </p>
                      )}
                    <Field
                      label="这一阶段要得到什么"
                      value={current.goal}
                      onChange={(goal) => updateMilestone({ ...current, goal })}
                      multiline
                    />
                    {workflow.guidance === "detailed" && (
                      <details className="wf-details">
                        <summary>填写参考</summary>
                        <div className="wf-guide">
                          <dl>
                            <dt>现在做</dt>
                            <dd>{guide.action}</dd>
                            <dt>参考例子</dt>
                            <dd>{guide.example}</dd>
                            <dt>完成依据</dt>
                            <dd>{guide.done}</dd>
                            <dt>卡住了</dt>
                            <dd>{guide.blocked}</dd>
                          </dl>
                        </div>
                      </details>
                    )}
                    <Field
                      label="里程碑验收条件"
                      value={current.acceptance}
                      onChange={(acceptance) =>
                        updateMilestone({ ...current, acceptance })
                      }
                      multiline
                    />
                    <details className="wf-details" open={current.state === "completed"}>
                      <summary>日期与验证记录</summary>
                      <Field
                        label="目标日期"
                        type="date"
                        value={current.dueDate || ""}
                        onChange={(dueDate) => updateMilestone({ ...current, dueDate })}
                      />
                      <Field
                        label="里程碑验证依据"
                        value={current.evidence}
                        onChange={(evidence) =>
                          updateMilestone({ ...current, evidence })
                        }
                        multiline
                        placeholder="实际结果、测试记录、交付物位置；标记已验收前填写"
                      />
                    </details>
                    <div className="wf-actions">
                      <button onClick={() => addTask(current)}>
                        为这个里程碑添加任务
                      </button>
                      {current.dueDate && (
                        <button
                          onClick={() =>
                            remind(
                              `里程碑目标：${current.title}`,
                              `${current.goal}\n验收条件：${current.acceptance}`,
                              current.dueDate || today,
                            )
                          }
                        >
                          设置目标日期提醒
                        </button>
                      )}
                      <span className="meta">
                        {
                          workflow.tasks.filter(
                            (t) =>
                              t.milestoneId === current.id &&
                              t.state === "done",
                          ).length
                        }
                        /
                        {
                          workflow.tasks.filter(
                            (t) => t.milestoneId === current.id,
                          ).length
                        }{" "}
                        项任务完成
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "tasks" && (
              <div className="wf-tab-content">
                {!selectedTask && <>
                  <div className="wf-section-heading">
                    <div>
                      <h3>开发任务</h3>
                    </div>
                    <button className="primary" onClick={() => addTask(current)}>
                      ＋ 开发任务
                    </button>
                  </div>
                  {workflow.tasks.filter((t) => t.state === "doing").length >
                    (workflow.wipLimit ?? 1) && (
                    <p className="wf-warning">
                      当前有{" "}
                      {workflow.tasks.filter((t) => t.state === "doing").length}{" "}
                      项任务在进行中，超过约定的 {workflow.wipLimit ?? 1}{" "}
                      项上限。先完成或解除阻碍，再开始下一项；团队可按负责人检查分工。
                    </p>
                  )}
                  <div className="wf-board">
                    {Object.entries(taskStates).map(([state, label]) => (
                      <section key={state} className="wf-column">
                        <h3>
                          {label}
                          <span>
                            {
                              workflow.tasks.filter((t) => t.state === state)
                                .length
                            }
                          </span>
                        </h3>
                        {workflow.tasks
                          .filter((t) => t.state === state)
                          .map((t) => (
                            <button
                              key={t.id}
                              className={`wf-task ${taskId === t.id ? "selected" : ""}`}
                              onClick={() => setTaskId(t.id)}
                            >
                              <strong>{t.title || "填写任务名称"}</strong>
                              <small>
                                {workflow.milestones.find(
                                  (m) => m.id === t.milestoneId,
                                )?.title || "未关联里程碑"}
                              </small>
                              <span>
                                {t.owner || "待分工"} · {priorities[t.priority]}
                              </span>
                              {t.blocker && <em>受阻：{t.blocker}</em>}
                              {t.receiver && (
                                <small>
                                  {handoffStates[t.handoff.status]} → {t.receiver}
                                </small>
                              )}
                            </button>
                          ))}
                      </section>
                    ))}
                  </div>
                  {!workflow.tasks.length && (
                    <p className="wf-empty">
                      还没有任务。添加一个能实际验证的小结果，例如“创建提醒后能按时弹出”。
                    </p>
                  )}
                </>}
                {selectedTask && (
                  <div className="wf-task-editor">
                    <div className="wf-section-heading">
                      <h3>{selectedTask.title || "新任务"}</h3>
                      <div className="wf-actions">
                        {!selectedTask.hasStarted &&
                          selectedTask.state === "todo" &&
                          !selectedTask.evidence &&
                          selectedTask.handoff.status === "draft" && (
                            <button
                              className="danger"
                              onClick={() => removeTask(selectedTask)}
                            >
                              移除未开始任务
                            </button>
                          )}
                        <button onClick={() => setTaskId("")}>返回任务列表</button>
                      </div>
                    </div>
                    <TaskEditor
                      key={selectedTask.id}
                      task={selectedTask}
                      workflow={workflow}
                      onChange={updateTask}
                    />
                    <button
                      onClick={() => showExport(
                        "给 Agent 的任务说明",
                        agentBrief(project.name, workflow, selectedTask),
                      )}
                    >
                      预览任务说明
                    </button>
                    <details className="wf-details">
                      <summary>交接与提醒</summary>
                      <div className="wf-actions">
                        <button
                          onClick={() =>
                            showExport(
                              "交接清单",
                              handoffBrief(project.name, selectedTask),
                            )
                          }
                        >
                          预览交接清单
                        </button>
                        <button
                          onClick={() =>
                            remind(
                              `跟进：${selectedTask.title}`,
                              `${selectedTask.blocker || selectedTask.acceptance}\n负责人：${selectedTask.owner}\n接收人：${selectedTask.receiver}`,
                              selectedTask.followUpDate,
                            )
                          }
                        >
                          创建跟进提醒
                        </button>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            )}

            {tab === "collaboration" && (
              <div className="wf-tab-content">
                <p className="wf-local-note">
                  协作信息保存在本机。接收、确认和验收状态由你依据实际沟通登记，不会自动通知对方。
                </p>
                <div className="wf-grid wf-waiting">
                  <section>
                    <h3>
                      等待处理与交接{" "}
                      <span className="badge">{waiting.length}</span>
                    </h3>
                    {waiting.length ? (
                      waiting.map((t) => (
                        <div className="wf-wait-item" key={t.id}>
                          <strong>{t.title}</strong>
                          <p>
                            {t.blocker ||
                              `${handoffStates[t.handoff.status]} · ${t.receiver || t.reviewer || t.owner || "待指定人员"}`}
                          </p>
                          <small>
                            {t.followUpDate
                              ? `跟进日期：${t.followUpDate}${t.followUpDate < today ? " · 已到跟进时间" : ""}`
                              : "尚未约定跟进日期"}
                          </small>
                          <div className="wf-actions">
                            <button
                              onClick={() => {
                                setTaskId(t.id);
                                setTab("tasks");
                              }}
                            >
                              查看交接
                            </button>
                            <button
                              onClick={() =>
                                remind(
                                  `跟进：${t.title}`,
                                  `${t.blocker}\n验收人：${t.reviewer}\n接收人：${t.receiver}`,
                                  t.followUpDate,
                                )
                              }
                            >
                              创建提醒
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="hint">暂时没有受阻或等待交接的任务。</p>
                    )}
                  </section>
                  <section>
                    <h3>
                      需要确认{" "}
                      <span className="badge">{openDecisions.length}</span>
                    </h3>
                    {openDecisions.length ? (
                      openDecisions.map((d) => (
                        <div className="wf-wait-item" key={d.id}>
                          <strong>{d.topic}</strong>
                          <p>{d.people || "待指定确认人"}</p>
                          <small>
                            {d.followUpDate
                              ? `跟进日期：${d.followUpDate}`
                              : "尚未约定跟进日期"}
                          </small>
                          <div className="wf-actions">
                            <button onClick={() => setDecisionId(d.id)}>
                              记录结论
                            </button>
                            <button
                              onClick={() =>
                                remind(
                                  `确认：${d.topic}`,
                                  `相关人员：${d.people}\n影响：${d.impact}`,
                                  d.followUpDate,
                                )
                              }
                            >
                              创建提醒
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="hint">
                        尚无待确认事项。范围变化、接口约定和重要决定都可以记在这里。
                      </p>
                    )}
                  </section>
                </div>
                <details className="wf-details">
                  <summary>
                    参与人及责任分工（{workflow.participants.length}）
                  </summary>
                  <p className="hint">
                    姓名为本地文字记录。每个任务明确一位主要负责人，协助人可有多位。
                  </p>
                  {workflow.participants.map((p) => (
                    <div key={p.id}>
                      <div className="wf-person">
                        <Field
                          label="姓名"
                          value={p.name}
                          onChange={(name) =>
                            update({
                              participants: workflow.participants.map((x) =>
                                x.id === p.id ? { ...x, name } : x,
                              ),
                            })
                          }
                        />
                        <Field
                          label="角色与责任"
                          value={p.role}
                          onChange={(role) =>
                            update({
                              participants: workflow.participants.map((x) =>
                                x.id === p.id ? { ...x, role } : x,
                              ),
                            })
                          }
                        />
                        <Field
                          label="联系方式或备注"
                          value={p.contact}
                          onChange={(contact) =>
                            update({
                              participants: workflow.participants.map((x) =>
                                x.id === p.id ? { ...x, contact } : x,
                              ),
                            })
                          }
                        />
                      </div>
                      <button
                        className="text-button danger"
                        onClick={() => {
                          if (
                            !p.name ||
                            window.confirm(
                              `移除参与人“${p.name}”？已填写的任务负责人文字会保留。`,
                            )
                          )
                            update({
                              participants: workflow.participants.filter(
                                (x) => x.id !== p.id,
                              ),
                            });
                        }}
                      >
                        移除此参与人
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      update({
                        participants: [
                          ...workflow.participants,
                          { id: uuid(), name: "", role: "", contact: "" },
                        ],
                      })
                    }
                  >
                    ＋ 参与人
                  </button>
                </details>
                <div className="wf-section-heading">
                  <h3>沟通、变更与接口约定</h3>
                  <button
                    onClick={() => {
                      const d: Decision = {
                        id: uuid(),
                        kind: "decision",
                        topic: "",
                        people: "",
                        conclusion: "",
                        impact: "",
                        date: today,
                        followUpDate: "",
                        status: "pending",
                      };
                      update({ decisions: [...workflow.decisions, d] });
                      setDecisionId(d.id);
                    }}
                  >
                    ＋ 沟通记录
                  </button>
                </div>
                <div className="wf-records">
                  {workflow.decisions.map((d) => (
                    <button
                      key={d.id}
                      className={d.id === decisionId ? "selected" : ""}
                      onClick={() => setDecisionId(d.id)}
                    >
                      <span>{d.topic || "填写沟通主题"}</span>
                      <small>
                        {d.date} ·{" "}
                        {d.status === "confirmed" ? "已登记确认" : "待确认"}
                      </small>
                    </button>
                  ))}
                </div>
                {selectedDecision && (
                  <div className="wf-editor">
                    {selectedDecision.status === "pending" && (
                      <div className="wf-actions">
                        <button
                          className="text-button danger"
                          onClick={() => {
                            if (
                              !selectedDecision.topic ||
                              window.confirm(
                                `移除未确认的记录“${selectedDecision.topic}”？`,
                              )
                            ) {
                              update({
                                decisions: workflow.decisions.filter(
                                  (d) => d.id !== selectedDecision.id,
                                ),
                              });
                              setDecisionId("");
                            }
                          }}
                        >
                          移除未确认记录
                        </button>
                      </div>
                    )}
                    <div className="wf-grid">
                      <Field
                        label="沟通主题"
                        value={selectedDecision.topic}
                        onChange={(topic) =>
                          updateDecision({ ...selectedDecision, topic })
                        }
                      />
                      <label>
                        <FieldCaption label="记录类型" />
                        <select
                          value={selectedDecision.kind}
                          onChange={(e) =>
                            updateDecision({
                              ...selectedDecision,
                              kind: e.target.value as Decision["kind"],
                            })
                          }
                        >
                          <option value="decision">需求／决定</option>
                          <option value="change">范围变更</option>
                          <option value="interface">接口约定</option>
                        </select>
                      </label>
                    </div>
                    <Field
                      label="相关人员与确认人"
                      value={selectedDecision.people}
                      onChange={(people) =>
                        updateDecision({ ...selectedDecision, people })
                      }
                    />
                    <Field
                      label="沟通结论"
                      value={selectedDecision.conclusion}
                      onChange={(conclusion) =>
                        updateDecision({ ...selectedDecision, conclusion })
                      }
                      multiline
                      placeholder={
                        selectedDecision.kind === "interface"
                          ? "给什么、返回什么、格式样例、失败处理、联调时间、变更通知人"
                          : "确认了什么？还没达成一致的内容请保留待确认。"
                      }
                    />
                    <Field
                      label="影响与后续动作"
                      value={selectedDecision.impact}
                      onChange={(impact) =>
                        updateDecision({ ...selectedDecision, impact })
                      }
                      multiline
                      placeholder="对范围、时间、已有工作和后续责任的影响"
                    />
                    <div className="wf-grid">
                      <Field
                        label="沟通日期"
                        value={selectedDecision.date}
                        onChange={(date) =>
                          updateDecision({ ...selectedDecision, date })
                        }
                        type="date"
                      />
                      <Field
                        label="沟通跟进日期"
                        value={selectedDecision.followUpDate}
                        onChange={(followUpDate) =>
                          updateDecision({ ...selectedDecision, followUpDate })
                        }
                        type="date"
                      />
                      <label>
                        <FieldCaption label="确认情况" />
                        <select
                          value={selectedDecision.status}
                          onChange={(e) =>
                            updateDecision({
                              ...selectedDecision,
                              status: e.target.value as Decision["status"],
                            })
                          }
                        >
                          <option value="pending">待确认</option>
                          <option value="confirmed">已登记确认</option>
                        </select>
                      </label>
                    </div>
                    <div className="wf-actions">
                      <button
                        className="primary"
                        disabled={!dirty}
                        onClick={() => void save()}
                      >
                        保存沟通记录
                      </button>
                      <button
                        onClick={() =>
                          showExport(
                            "沟通说明",
                            `# ${selectedDecision.topic}\n\n相关人员：${selectedDecision.people}\n日期：${selectedDecision.date}\n确认情况：${selectedDecision.status === "confirmed" ? "已登记确认" : "待确认"}\n\n${selectedDecision.conclusion}\n\n影响与后续动作：\n${selectedDecision.impact}`,
                          )
                        }
                      >
                        预览沟通说明
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "agent" && (
              <div className="wf-tab-content">
                <div className="wf-focus">
                  <h3>把上下文交给 Agent，再把结果带回来</h3>
                  <p>
                    导出当前项目的目标、流程和任务。普通笔记、个人流水不会混入。参与人信息和你填写在流程中的内容会包含在内，请先检查预览。
                  </p>
                  <div className="wf-actions">
                    <button onClick={askAgent}>让 Agent 帮我补全</button>
                    {onProjectConfig && (
                      <button onClick={onProjectConfig}>
                        完整项目信息文件
                      </button>
                    )}
                    <button
                      onClick={() =>
                        showExport(
                          "给 Agent 的项目说明",
                          agentBrief(project.name, workflow),
                        )
                      }
                    >
                      预览项目说明
                    </button>
                    <button
                      onClick={() =>
                        showExport("开发流程 JSON", () =>
                          workflowExport(project.id, workflow),
                        )
                      }
                    >
                      预览配置导出
                    </button>
                  </div>
                </div>
                <Field
                  label="粘贴开发流程 JSON"
                  value={importText}
                  onChange={(text) => {
                    setImportText(text);
                    setPreview(null);
                  }}
                  multiline
                  placeholder="让外部 Agent 基于导出的配置修改，保留项目和任务 ID 后粘贴回来。"
                />
                <button
                  onClick={() => {
                    try {
                      const merged = mergeWorkflowImport(
                        workflow,
                        parseWorkflowImport(importText, project.id),
                      );
                      setPreview({ ...merged, revision: baseRevision });
                      setError("");
                    } catch (e) {
                      setError(errorText(e));
                      setPreview(null);
                    }
                  }}
                >
                  校验并预览导入
                </button>
                {preview && (
                  <div className="wf-import-preview">
                    <h3>导入变更预览</h3>
                    <p>
                      同 ID
                      更新尚未开始的配置，未出现的记录保留。已操作任务、已完成里程碑和已确认沟通受保护，本次保护{" "}
                      {preview.protectedCount} 项。Agent
                      声称完成的任务将进入待验收，接收与确认仍由你登记。
                    </p>
                    <div className="wf-grid">
                      <p>
                        里程碑 {workflow.milestones.length} →{" "}
                        {preview.workflow.milestones.length}
                      </p>
                      <p>
                        任务 {workflow.tasks.length} →{" "}
                        {preview.workflow.tasks.length}
                      </p>
                      <p>
                        沟通记录 {workflow.decisions.length} →{" "}
                        {preview.workflow.decisions.length}
                      </p>
                    </div>
                    <div className="wf-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>任务</th>
                            <th>变更</th>
                            <th>导入后状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.workflow.tasks.map((t) => {
                            const old = workflow.tasks.find(
                              (x) => x.id === t.id,
                            );
                            return (
                              <tr key={t.id}>
                                <td>{t.title}</td>
                                <td>
                                  {!old
                                    ? "新增"
                                    : JSON.stringify(old) === JSON.stringify(t)
                                      ? "未变化"
                                      : "修改"}
                                </td>
                                <td>{taskStates[t.state]}</td>
                              </tr>
                            );
                          })}
                          {workflow.tasks
                            .filter(
                              (t) =>
                                !preview.workflow.tasks.some(
                                  (x) => x.id === t.id,
                                ),
                            )
                            .map((t) => (
                              <tr key={t.id}>
                                <td>{t.title}</td>
                                <td>移除</td>
                                <td>—</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    <details className="wf-details">
                      <summary>查看完整导入内容</summary>
                      <textarea
                        aria-label="完整导入预览"
                        readOnly
                        value={workflowExport(project.id, preview.workflow)}
                        rows={12}
                      />
                    </details>
                    <button
                      className="primary"
                      onClick={() =>
                        void save(preview.workflow, preview.revision)
                      }
                    >
                      确认导入并保存
                    </button>
                  </div>
                )}
              </div>
            )}
            {dirty && (
              <div className="wf-savebar">
                <span>修改尚未保存到本机</span>
                <div className="wf-actions">
                  <button onClick={reload}>放弃修改</button>
                  <button className="primary" onClick={() => void save()}>
                    保存全部修改
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {exportText && (
          <div className="wf-export">
            <div className="wf-section-heading">
              <h3>{exportTitle}</h3>
              <button onClick={() => setExportText("")}>关闭预览</button>
            </div>
            <textarea
              aria-label="导出内容预览"
              readOnly
              value={exportText}
              rows={12}
            />
            <button className="primary" onClick={() => void copy(exportText)}>
              复制预览内容
            </button>
          </div>
        )}
      </fieldset>
    </WorkbenchDisclosure>
  );
}

function handoffBrief(projectName: string, task: WorkflowTask): string {
  return `# ${projectName} · ${task.title} · 交接清单\n\n负责人：${task.owner || "待指定"}\n验收人：${task.reviewer || "待指定"}\n接收人：${task.receiver || "待指定"}\n本机登记状态：${handoffStates[task.handoff.status]}\n\n## 负责范围\n${task.boundary || "待补充"}\n\n## 验收标准\n${task.acceptance || "待补充"}\n\n## 交付物及版本\n${task.handoff.artifacts || "待补充"}\n\n## 启动与使用方法\n${task.handoff.instructions || "待补充"}\n\n## 验证结果\n${task.handoff.verification || task.evidence || "尚未验证"}\n\n## 已知问题\n${task.handoff.risks || "未记录，请确认"}\n\n## 后续责任与下一步\n${task.handoff.nextAction || task.output || "待明确"}\n\n## 接收或退回记录\n${task.handoff.note || "尚无记录"}`;
}

function TaskEditor({
  task,
  workflow,
  onChange,
}: {
  task: WorkflowTask;
  workflow: Workflow;
  onChange: (task: WorkflowTask) => void;
}) {
  const set = (patch: Partial<WorkflowTask>) => onChange({ ...task, ...patch });
  const handoff = (patch: Partial<WorkflowTask["handoff"]>) =>
    set({ handoff: { ...task.handoff, ...patch } });
  return (
    <>
      <Field
        label="任务名称"
        value={task.title}
        onChange={(title) => set({ title })}
        required
        placeholder="一个能验证的小结果"
      />
      <label>
        <FieldCaption label="任务状态" />
        <select
          value={task.state}
          onChange={(e) =>
            set({ state: e.target.value as WorkflowTask["state"] })
          }
        >
          {Object.entries(taskStates).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Field
        label="验收标准"
        value={task.acceptance}
        onChange={(acceptance) => set({ acceptance })}
        multiline
        placeholder="使用什么样例、做什么操作、期待得到什么结果"
      />
      <details className="wf-details" open={task.state === "review" || task.state === "done"}>
        <summary>结果与验证</summary>
        <Field
          label="结果与验证依据"
          value={task.evidence}
          onChange={(evidence) => set({ evidence })}
          multiline
          placeholder="实际测试结果、截图或文档位置；标记完成前填写"
        />
      </details>
      <details className="wf-details">
        <summary>安排与分工</summary>
          <div className="wf-grid">
            <label>
              <FieldCaption label="所属里程碑" />
              <select
                value={task.milestoneId}
                onChange={(e) => set({ milestoneId: e.target.value })}
              >
                <option value="">未关联</option>
                {workflow.milestones.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
            </label>
            <label>
              <FieldCaption label="优先级" />
              <select
                value={task.priority}
                onChange={(e) => set({ priority: e.target.value as WorkflowTask["priority"] })}
              >
                {Object.entries(priorities).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>
        <div className="wf-grid">
          <Field
            label="负责人"
            value={task.owner}
            onChange={(owner) => set({ owner })}
            placeholder="一位主要负责人"
          />
          <Field
            label="验收人"
            value={task.reviewer}
            onChange={(reviewer) => set({ reviewer })}
          />
          <Field
            label="接收人"
            value={task.receiver}
            onChange={(receiver) => set({ receiver })}
          />
        </div>
      </details>
      <details className="wf-details">
        <summary>责任边界、依赖与卡点</summary>
        <Field
          label="协助人"
          value={task.contributors}
          onChange={(contributors) => set({ contributors })}
        />
        <Field
          label="我负责到哪里"
          value={task.boundary}
          onChange={(boundary) => set({ boundary })}
          multiline
          placeholder="本任务负责的范围及边界"
        />
        <div className="wf-grid">
          <Field
            label="需要谁提供什么"
            value={task.input}
            onChange={(input) => set({ input })}
            multiline
          />
          <Field
            label="交出什么、交给谁继续"
            value={task.output}
            onChange={(output) => set({ output })}
            multiline
          />
        </div>
        <fieldset className="wf-dependencies">
          <legend>前置任务（完成后才开始）</legend>
          {workflow.tasks
            .filter((t) => t.id !== task.id)
            .map((t) => (
              <label className="inline-check" key={t.id}>
                <input
                  type="checkbox"
                  checked={task.dependsOn.includes(t.id)}
                  onChange={(e) =>
                    set({
                      dependsOn: e.target.checked
                        ? [...task.dependsOn, t.id]
                        : task.dependsOn.filter((id) => id !== t.id),
                    })
                  }
                />
                {t.title || "未命名任务"} · {taskStates[t.state]}
              </label>
            ))}
          {workflow.tasks.length < 2 && (
            <p className="hint">添加其他任务后，可以指定前置任务。</p>
          )}
        </fieldset>
        <Field
          label="卡点与解除条件"
          value={task.blocker}
          onChange={(blocker) => set({ blocker })}
          multiline
          placeholder="缺什么资料或决定？需要找谁？怎样可以继续？"
        />
        <Field
          label="任务跟进日期"
          value={task.followUpDate}
          onChange={(followUpDate) => set({ followUpDate })}
          type="date"
        />
      </details>
      <details className="wf-details">
        <summary>交接包与接收记录</summary>
        <p className="hint">
          提交、接收和验收是不同事实。按实际沟通登记；指定接收人的任务，需要验收通过后才能完成。
        </p>
        <label>
          <FieldCaption label="交接状态" />
          <select
            value={task.handoff.status}
            onChange={(e) =>
              handoff({
                status: e.target.value as WorkflowTask["handoff"]["status"],
              })
            }
          >
            {Object.entries(handoffStates).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="交付物及版本"
          value={task.handoff.artifacts}
          onChange={(artifacts) => handoff({ artifacts })}
          multiline
          placeholder="安装包、代码版本、设计稿或文档位置"
        />
        <Field
          label="启动与使用方法"
          value={task.handoff.instructions}
          onChange={(instructions) => handoff({ instructions })}
          multiline
        />
        <Field
          label="交接验证结果"
          value={task.handoff.verification}
          onChange={(verification) => handoff({ verification })}
          multiline
        />
        <Field
          label="已知问题与限制"
          value={task.handoff.risks}
          onChange={(risks) => handoff({ risks })}
          multiline
        />
        <Field
          label="接手后的下一步"
          value={task.handoff.nextAction}
          onChange={(nextAction) => handoff({ nextAction })}
          multiline
        />
        <Field
          label="接收／退回说明"
          value={task.handoff.note}
          onChange={(note) => handoff({ note })}
          multiline
          placeholder="谁在何时确认；退回需要补充什么"
        />
      </details>
    </>
  );
}

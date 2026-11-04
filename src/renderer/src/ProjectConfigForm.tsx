import React, { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/contracts";
import type { ProjectConfigPreview } from "../../shared/project-config";
import { projectConfigAgentPrompt } from "../../shared/project-config";
import "./project-config.css";

const api = window.kanban;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const fieldNames: Record<string, string> = {
  project: "项目",
  id: "ID",
  name: "名称",
  description: "说明",
  owner: "负责人",
  state: "状态",
  progress: "进度",
  update: "最新进展",
  archived: "归档",
  workflow: "开发流程",
  mode: "路线",
  collaboration: "协作方式",
  guidance: "引导程度",
  goal: "目标",
  scope: "本次范围",
  outOfScope: "暂不做",
  acceptance: "验收标准",
  participants: "参与人",
  role: "角色与责任",
  contact: "联系方式",
  milestones: "里程碑",
  title: "名称",
  evidence: "验证依据",
  dueDate: "目标日期",
  tasks: "任务",
  milestoneId: "所属里程碑 ID",
  contributors: "协助人",
  reviewer: "验收人",
  receiver: "接收人",
  boundary: "责任边界",
  input: "所需输入",
  output: "预期输出",
  dependsOn: "依赖任务 ID",
  priority: "优先级",
  blocker: "卡点",
  followUpDate: "跟进日期",
  hasStarted: "已操作标记",
  handoff: "交接",
  status: "确认状态",
  artifacts: "交付物与版本",
  instructions: "使用方法",
  verification: "验证结果",
  risks: "已知问题",
  nextAction: "后续动作",
  note: "接收或退回说明",
  decisions: "沟通记录",
  kind: "类型",
  topic: "主题",
  people: "相关人员",
  conclusion: "结论",
  impact: "影响",
  date: "日期",
  wipLimit: "同时进行任务上限",
};
function fieldLabel(path: string) {
  return (path.match(/[^.\[\]]+(?:\[[^\]]*\])?/g) || [path])
    .map((part) => {
      const split = part.indexOf("[");
      const name = split < 0 ? part : part.slice(0, split);
      return `${fieldNames[name] || name}${split < 0 ? "" : part.slice(split)}`;
    })
    .join(" / ");
}

export function ProjectConfigForm({
  project,
  onDone,
  onDirty,
  onBusy,
  initialStage = "assist",
}: {
  project?: Project;
  onDone: (id: string) => void;
  onDirty: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
  initialStage?: "assist" | "import";
}) {
  const [template, setTemplate] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ProjectConfigPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stage, setStage] = useState(initialStage);
  const [request, setRequest] = useState("");
  const [prompt, setPrompt] = useState("");
  const busyRef = useRef(false);
  const callbacks = useRef({ onDirty, onBusy });
  callbacks.current = { onDirty, onBusy };

  useEffect(() => {
    callbacks.current.onDirty(Boolean(text.trim() || request.trim()));
  }, [text, request]);
  useEffect(
    () => () => {
      callbacks.current.onDirty(false);
      callbacks.current.onBusy?.(false);
    },
    [],
  );

  async function act(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    callbacks.current.onBusy?.(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
      callbacks.current.onBusy?.(false);
    }
  }
  async function getTemplate() {
    const value = await api.projects.exportConfig(project?.id);
    setTemplate(value);
    return value;
  }
  function change(value: string) {
    setText(value);
    setPreview(null);
    setError("");
    setNotice("");
  }
  async function chooseFile() {
    await act(async () => {
      const value = await api.imports.readFile();
      if (value === null) return;
      if (value.length > 2_000_000)
        throw new Error("文件过大，请使用不超过 2 MB 的项目配置。");
      change(value);
      setPreview(await api.projects.previewConfig(value, project?.id));
      setNotice("文件已校验，请确认变更。");
    });
  }

  return (
    <div className="project-config-form">
      <div className="pc-tabs" aria-label="Agent 协助步骤">
        <button disabled={busy} aria-pressed={stage === "assist"} onClick={() => setStage("assist")}>交给 Agent 规划</button>
        <button disabled={busy} aria-pressed={stage === "import"} onClick={() => setStage("import")}>导入 Agent 结果</button>
      </div>
      {error && (
        <div className="pc-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="pc-notice" role="status">
          {notice}
        </p>
      )}
      <fieldset disabled={busy}>
        <section className="pc-step" hidden={stage !== "assist"}>
          <label htmlFor="agent-project-request">这次想做什么？</label>
          <textarea id="agent-project-request" className="pc-request" value={request}
            onChange={(event) => { setRequest(event.target.value); setPrompt(""); }}
            rows={3} maxLength={10000}
            placeholder="例如：给值班同事做一个检查工具，先实现每天提醒和检查结果记录。"
          />
          <p className="hint">
            {project ? `会带上「${project.name}」的现有信息。` : "先用一句话描述想法。"}
            复制给外部 Agent 对话，补齐信息后将生成的文件导入。
          </p>
          <div className="pc-actions">
            <button className="primary" type="button" onClick={() => void act(async () => {
              const value = await getTemplate();
              const content = projectConfigAgentPrompt(value, request);
              setPrompt(content);
              await api.window.copyText(content);
              setNotice("已复制，粘贴给外部 Agent 即可开始。拿到文件后选择“导入 Agent 结果”。");
            })}>复制给 Agent</button>
            <button type="button" onClick={() => void act(async () => {
              setPrompt(projectConfigAgentPrompt(await getTemplate(), request));
            })}>预览发送内容</button>
          </div>
          {prompt && <details className="pc-template">
            <summary>发送内容</summary>
            <textarea aria-label="Agent 发送内容" readOnly value={prompt} rows={10} />
          </details>}
          <details className="pc-template">
            <summary>模板与配置文件</summary>
          <div className="pc-actions">
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  await getTemplate();
                })
              }
            >
              预览完整项目模板
            </button>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  const value = template || (await getTemplate());
                  if (await api.projects.saveConfigFile(value))
                    setNotice("项目模板文件已保存，可交给 Agent 填写。");
                })
              }
            >
              保存模板文件
            </button>
          </div>
          {template && (
            <details className="pc-template" open>
              <summary>完整模板预览</summary>
              <textarea
                aria-label="完整项目模板预览"
                readOnly
                value={template}
                rows={10}
                spellCheck={false}
              />
            </details>
          )}
          </details>
        </section>

        <section className="pc-step" hidden={stage !== "import"}>
          <div className="pc-actions">
            <button type="button" onClick={() => void chooseFile()}>
              选择 JSON 文件
            </button>
            <span className="hint">也可以直接粘贴 JSON 内容</span>
          </div>
          <label htmlFor="project-config-input">完整项目 JSON</label>
          <textarea
            id="project-config-input"
            value={text}
            rows={10}
            maxLength={2_000_000}
            spellCheck={false}
            onChange={(e) => change(e.target.value)}
            placeholder='{"schema_version":1,"kind":"kanban-project","project":{...}}'
          />
          <details className="pc-template"><summary>导入规则</summary><p className="hint">
            同 ID 更新现有项目；新建项目可省略项目
            ID。未出现的流程条目保留，已操作的任务和已确认记录受保护。项目基本信息按完整配置填写，省略的可选基本字段会恢复默认值。
          </p></details>
          <button
            type="button"
            className="primary"
            disabled={!text.trim()}
            onClick={() =>
              void act(async () => {
                setPreview(null);
                const value = await api.projects.previewConfig(
                  text,
                  project?.id,
                );
                setPreview(value);
              })
            }
          >
            校验并预览
          </button>
        </section>

        {stage === "import" && preview && (
          <section className="pc-step pc-preview" aria-label="项目导入预览">
            <h3>
              确认{preview.action === "create" ? "创建" : "更新"}
              「{preview.name}」
            </h3>
            <p className="hint">
              项目 ID：{preview.projectId} · {preview.changes.length} 项字段变更
              · {preview.protectedCount} 项已有记录受到保护。尚未写入数据。
            </p>
            <p className="hint">
              Agent
              自报完成的任务仍需验收；接收与确认由你根据实际沟通登记。没有提供
              workflow 时保留现有开发流程。
            </p>
            <div className="pc-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>原内容</th>
                    <th>导入后</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((change, i) => (
                    <tr key={`${change.field}-${i}`}>
                      <th scope="row">{fieldLabel(change.field)}</th>
                      <td>
                        <pre>{change.before || "（空）"}</pre>
                      </td>
                      <td>
                        <pre>{change.after || "（清空）"}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!preview.changes.length && <p>没有需要修改的字段。</p>}
            <button
              type="button"
              className="primary"
              onClick={() =>
                void act(async () => {
                  const id = await api.projects.commitConfig(preview.token);
                  setText("");
                  setPreview(null);
                  callbacks.current.onDirty(false);
                  onDone(id);
                })
              }
            >
              {preview.action === "create" ? "确认创建项目" : "确认更新项目"}
            </button>
          </section>
        )}
      </fieldset>
    </div>
  );
}

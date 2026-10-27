import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DesktopAPI,
  Snapshot,
  Run,
  ItemConfig,
  Project,
  WorkLog,
  Note,
  ImportPreview,
  ReportEntry,
  BackupPreview,
} from "../../shared/contracts";
import { today } from "../../shared/time";
import "./styles.css";

declare global {
  interface Window {
    kanban: DesktopAPI;
  }
}
const api = window.kanban;
const states: Record<string, string> = {
  pending: "待处理",
  doing: "进行中",
  completed: "已完成",
  skipped: "已跳过",
  withdrawn: "已撤销",
  unstarted: "未开始",
  active: "进行中",
  paused: "暂停",
};
const freq: Record<string, string> = {
  once: "一次性",
  daily: "每天",
  weekdays: "工作日",
  weekly: "每周指定日期",
};
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: () => <span className="muted">[图片不加载]</span>,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void api.window.openExternal(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
function ProjectSelect({
  data,
  value,
  onChange,
}: {
  data: Snapshot;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      aria-label="关联项目"
      value={value || ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">未关联项目</option>
      {data.projects
        .filter((p) => !p.archived || p.id === value)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.archived ? "（已归档）" : ""}
          </option>
        ))}
    </select>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">✓</span>
      <p>{children}</p>
    </div>
  );
}
function useSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const load = async () => {
    try {
      setData(await api.snapshot());
      setError("");
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    void load();
    return api.onChange(() => void load());
  }, []);
  return { data, error, load };
}
function Dialog({
  title,
  children,
  close,
  dirty,
  onDirty,
  wide = false,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  dirty: boolean;
  onDirty: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const dismiss = () => {
    if (!dirty || confirm("放弃未保存的修改？")) close();
  };
  useEffect(() => {
    const cb = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", cb);
    return () => document.removeEventListener("keydown", cb);
  }, [dirty]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) dismiss();
      }}
    >
      <section
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button
            aria-label="关闭对话框"
            className="icon-button"
            disabled={busy}
            onClick={dismiss}
          >
            ×
          </button>
        </div>
        <div className="dialog-body" onChangeCapture={onDirty}>
          <fieldset disabled={busy}>{children}</fieldset>
        </div>
      </section>
    </div>
  );
}
type Modal =
  | { type: "item"; config?: ItemConfig; noteId?: string }
  | { type: "run"; id: string }
  | { type: "project"; project?: Project }
  | { type: "log"; log?: WorkLog }
  | { type: "note"; note?: Note }
  | { type: "templates" | "import" | "report" | "settings" };
type Actions = {
  data: Snapshot;
  finish: () => void;
  notify: (message: string) => void;
  perform: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
};

function App() {
  const { data, error, load } = useSnapshot();
  const [view, setView] = useState<"today" | "projects" | "records">("today"),
    [modal, setModal] = useState<Modal | null>(null);
  const [dirty, setDirty] = useState(false),
    [quickText, setQuickText] = useState(""),
    [toast, setToast] = useState(""),
    [failure, setFailure] = useState("");
  const [menu, setMenu] = useState(false),
    [saving, setSaving] = useState(false);
  const operation = useRef(false);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    api.window.dirty(dirty || Boolean(quickText));
    return () => api.window.dirty(false);
  }, [dirty, quickText]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const open = (m: Modal) => {
    if (dirty && !confirm("放弃未保存的修改？")) return;
    setDirty(false);
    setFailure("");
    setModal(m);
    setMenu(false);
  };
  useEffect(() => api.onOpenRun((id) => open({ type: "run", id })), [dirty]);
  const perform = async (fn: () => Promise<unknown>, success = "") => {
    if (operation.current) return false;
    operation.current = true;
    setWorking(true);
    setFailure("");
    try {
      await fn();
      await load();
      if (success) setToast(success);
      return true;
    } catch (e) {
      setFailure(message(e));
      return false;
    } finally {
      operation.current = false;
      setWorking(false);
    }
  };
  const finish = () => {
    setModal(null);
    setDirty(false);
  };
  const quickSave = async () => {
    if (!quickText.trim() || saving || !data) return;
    setSaving(true);
    if (
      await perform(
        () => api.records.saveLog({ body: quickText, date: data.today }),
        "已记录",
      )
    )
      setQuickText("");
    setSaving(false);
  };
  if (!data)
    return (
      <div className="loading">
        {error || "正在打开工作看板…"}
        {error && <button onClick={() => void load()}>重试</button>}
      </div>
    );
  const actions: Actions = { data, finish, notify: setToast, perform };
  const projectName = (id: string | null) =>
    data.projects.find((p) => p.id === id)?.name || "个人事项";
  const todayRuns = data.runs.filter(
    (r) => r.date === data.today && r.state !== "withdrawn",
  );
  const pending = todayRuns.filter((r) =>
    ["pending", "doing"].includes(r.state),
  );
  const overdue = data.runs.filter(
    (r) => r.date < data.today && ["pending", "doing"].includes(r.state),
  );
  const done = data.runs.filter(
    (r) =>
      (r.state === "completed" &&
        r.completedAt &&
        today(new Date(r.completedAt)) === data.today) ||
      (r.state === "skipped" && today(new Date(r.changedAt)) === data.today),
  );
  const card = (r: Run) => (
    <button
      className={`task-card ${r.state === "completed" ? "is-done" : ""}`}
      key={r.id}
      onClick={() => open({ type: "run", id: r.id })}
    >
      <span className={`task-marker ${r.state}`}>
        {r.state === "completed" ? "✓" : r.state === "skipped" ? "−" : ""}
      </span>
      <span className="task-content">
        <strong>{r.config.title}</strong>
        <span className="meta">
          {projectName(r.config.project_id)} ·{" "}
          {r.date < data.today ? `${r.date} · ` : ""}
          {r.config.schedule.time || "全天"}
          {r.config.checklist.length > 0
            ? ` · ${r.config.checklist.filter((c) => r.checks[c.id]).length}/${r.config.checklist.length} 项`
            : ""}
        </span>
      </span>
      <span className={`badge ${r.state}`}>{states[r.state]}</span>
      <span className="chevron">›</span>
    </button>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">▥</div>
          <div>
            工作看板<small>让每一天有迹可循</small>
          </div>
        </div>
        <nav>
          {[
            ["today", "◷", "今天"],
            ["projects", "▦", "项目"],
            ["records", "≡", "记录"],
          ].map(([key, icon, label]) => (
            <button
              key={key}
              className={view === key ? "selected" : ""}
              onClick={() => setView(key as typeof view)}
            >
              <span>{icon}</span>
              {label}
              {key === "today" && pending.length > 0 && <b>{pending.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => open({ type: "import" })}>
            ↧ Agent 配置导入
          </button>
          <button onClick={() => open({ type: "settings" })}>
            ⚙ 设置与备份
          </button>
          <div className="local-status">
            <i />
            数据仅存本机
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <span>
            {view === "today"
              ? "我的工作台"
              : view === "projects"
                ? "项目空间"
                : "个人记录"}
          </span>
          <div>
            <span className="muted">{data.today}</span>
            <div className="menu-wrap">
              <button
                className="icon-button"
                aria-label="更多操作"
                onClick={() => setMenu(!menu)}
              >
                ···
              </button>
              {menu && (
                <div className="dropdown">
                  <button onClick={() => open({ type: "templates" })}>
                    管理例行事项
                  </button>
                  <button onClick={() => open({ type: "report" })}>
                    汇报素材
                  </button>
                  <button onClick={() => open({ type: "import" })}>
                    导入配置
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {failure && (
          <div className="error-banner" role="alert">
            {failure}
            <button onClick={() => setFailure("")}>×</button>
          </div>
        )}
        {view === "today" && (
          <div className="page">
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  TODAY ·{" "}
                  {new Date(`${data.today}T12:00:00+08:00`).toLocaleDateString(
                    "zh-CN",
                    { weekday: "long" },
                  )}
                </p>
                <h1>今天，把事情一件件做好</h1>
                <p className="muted">待办有提醒，做过的工作有记录。</p>
              </div>
              <button
                className="primary"
                onClick={() => open({ type: "item" })}
              >
                ＋ 新建事项
              </button>
            </div>
            <section className="quick-capture">
              <div className="capture-title">
                <span>✎</span>
                <strong>刚刚做了什么？记一句。</strong>
                <small>Ctrl + Alt + J 随时唤出</small>
              </div>
              <textarea
                aria-label="快速工作记录"
                placeholder="处理了一个告警，推进了一次沟通，或解决了一个小问题…"
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault();
                    void quickSave();
                  }
                }}
              />
              <div className="capture-footer">
                <span>Enter 保存 · Shift + Enter 换行</span>
                <button
                  className="primary small"
                  disabled={!quickText.trim() || saving}
                  onClick={() => void quickSave()}
                >
                  记下来 ↵
                </button>
              </div>
            </section>
            <div className="metrics">
              <div>
                <span>今日待处理</span>
                <strong>
                  {pending.length}
                  <small>项</small>
                </strong>
              </div>
              <div>
                <span>今日已完成</span>
                <strong>
                  {done.filter((r) => r.state === "completed").length}
                  <small>项</small>
                </strong>
              </div>
              <div>
                <span>今天的工作流水</span>
                <strong>
                  {data.logs.filter((l) => l.date === data.today).length}
                  <small>条</small>
                </strong>
              </div>
            </div>
            <div className="today-grid">
              <section>
                <div className="section-heading">
                  <h2>
                    今日事项 <small>{todayRuns.length}</small>
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => open({ type: "templates" })}
                  >
                    管理例行事项
                  </button>
                </div>
                <div className="task-list">
                  {pending
                    .sort((a, b) =>
                      (a.config.schedule.time || "99").localeCompare(
                        b.config.schedule.time || "99",
                      ),
                    )
                    .map(card)}
                  {!pending.length && (
                    <Empty>今天的待办已处理好，留点空间给新的进展。</Empty>
                  )}
                </div>
                {overdue.length > 0 && (
                  <details className="section-details">
                    <summary>
                      往日未完成{" "}
                      <span className="badge warning">{overdue.length}</span>
                    </summary>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (
                          confirm(
                            `将 ${overdue.length} 条往日未完成事项标记为跳过？`,
                          )
                        )
                          void perform(async () => {
                            for (const r of overdue)
                              await api.items.state(
                                r.id,
                                "skipped",
                                "",
                                "批量跳过",
                              );
                          });
                      }}
                    >
                      批量跳过
                    </button>
                    {overdue.map(card)}
                  </details>
                )}
                {done.length > 0 && (
                  <details className="section-details">
                    <summary>
                      今日已处理 <span>{done.length}</span>
                    </summary>
                    {done.map(card)}
                  </details>
                )}
              </section>
              <section className="day-log">
                <div className="section-heading">
                  <h2>最近工作流水</h2>
                  <button
                    className="text-button"
                    onClick={() => open({ type: "report" })}
                  >
                    整理汇报 →
                  </button>
                </div>
                {data.logs
                  .filter((l) => l.date === data.today)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .slice(0, 10)
                  .map((l) => (
                    <button
                      key={l.id}
                      className="timeline-entry"
                      onClick={() => open({ type: "log", log: l })}
                    >
                      <span className="meta">
                        {formatTime(l.createdAt)} · {projectName(l.projectId)}
                      </span>
                      <p>{l.body}</p>
                    </button>
                  ))}
                {!data.logs.some((l) => l.date === data.today) && (
                  <div className="quiet-empty">
                    随手留下今天的第一条记录。
                    <br />
                    汇报时，就不用再靠回忆了。
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
        {view === "projects" && (
          <Projects data={data} open={open} card={card} perform={perform} />
        )}
        {view === "records" && <Records data={data} open={open} />}
      </main>
      {toast && (
        <div className="toast" role="status">
          ✓ {toast}
        </div>
      )}
      {modal && (
        <Dialog
          busy={working}
          title={
            {
              item:
                modal.type === "item" && modal.config
                  ? "编辑事项配置"
                  : "新建事项",
              run: "事项详情",
              project: "项目设置",
              log: "工作流水",
              note: "普通笔记",
              templates: "例行事项与配置",
              import: "Agent 配置导入",
              report: "汇报素材",
              settings: "设置与数据管理",
            }[modal.type]
          }
          close={finish}
          dirty={dirty}
          onDirty={() => {
            if (
              ["item", "project", "log", "note", "settings"].includes(
                modal.type,
              )
            )
              setDirty(true);
          }}
          wide={["import", "report", "templates"].includes(modal.type)}
        >
          {failure && (
            <div className="error-banner" role="alert">
              {failure}
            </div>
          )}
          {modal.type === "item" && (
            <ItemForm
              {...actions}
              config={modal.config}
              noteId={modal.noteId}
            />
          )}
          {modal.type === "run" && (
            <RunDetails
              {...actions}
              run={data.runs.find((r) => r.id === modal.id)!}
              open={open}
              onDirty={setDirty}
            />
          )}
          {modal.type === "project" && (
            <ProjectForm {...actions} project={modal.project} />
          )}
          {modal.type === "log" && <LogForm {...actions} log={modal.log} />}
          {modal.type === "note" && (
            <NoteForm {...actions} note={modal.note} open={open} />
          )}
          {modal.type === "templates" && <Templates {...actions} open={open} />}
          {modal.type === "import" && <ImportPanel {...actions} />}
          {modal.type === "report" && <ReportPanel {...actions} />}
          {modal.type === "settings" && <SettingsPanel {...actions} />}
        </Dialog>
      )}
    </div>
  );
}

function ItemForm({
  data,
  config,
  noteId,
  perform,
  finish,
}: Actions & { config?: ItemConfig; noteId?: string }) {
  const note = data.notes.find((n) => n.id === noteId);
  const [title, setTitle] = useState(config?.title || note?.title || ""),
    [body, setBody] = useState(config?.content_markdown || "");
  const [owner, setOwner] = useState(config?.owner || "");
  const [kind, setKind] = useState(config?.type || "task"),
    [project, setProject] = useState(
      config?.project_id || note?.projectId || null,
    );
  const [frequency, setFrequency] = useState(
    config?.schedule.frequency || "once",
  );
  const [date, setDate] = useState(
    config
      ? config.schedule.frequency === "once"
        ? config.schedule.date
        : config.schedule.start_date
      : data.today,
  );
  const [time, setTime] = useState(config?.schedule.time || ""),
    [popup, setPopup] = useState(config?.reminder.popup || false);
  const [days, setDays] = useState(
    config?.schedule.frequency === "weekly" ? config.schedule.weekdays : [1],
  );
  const [checks, setChecks] = useState(
      config?.checklist.map((c) => c.text).join("\n") || "",
    ),
    [snooze, setSnooze] = useState(config?.reminder.snooze_minutes || 10),
    [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const schedule = {
      frequency,
      timezone: "Asia/Shanghai",
      ...(time ? { time } : {}),
      ...(frequency === "once" ? { date } : { start_date: date }),
      ...(frequency === "weekly" ? { weekdays: days } : {}),
    };
    const value = {
      id: config?.id || crypto.randomUUID(),
      title,
      type: kind,
      owner,
      project_id: project,
      content_markdown: body,
      checklist:
        kind === "checklist"
          ? checks
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((text, i) => ({
                id: config?.checklist[i]?.id || crypto.randomUUID(),
                text,
              }))
          : [],
      schedule,
      reminder: { popup, snooze_minutes: snooze },
    } as ItemConfig;
    const ok = await perform(async () => {
      if (config) {
        const p = await api.imports.preview(
          JSON.stringify({ schema_version: 1, items: [value] }),
        );
        const c = p.changes[0];
        if (
          c.action === "update" &&
          !confirm(
            `修改：${c.fields.join("、")}\n同步 ${c.syncCount} 条未开始记录；保留 ${c.protectedCount} 条已操作记录。\n${c.warnings.join("\n")}\n确定保存？`,
          )
        )
          throw new Error("已取消修改");
      }
      await api.items.save(value, noteId);
    }, "事项已保存");
    setBusy(false);
    if (ok) finish();
  };
  return (
    <form onSubmit={submit}>
      <label>
        事项标题
        <input
          autoFocus
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：检查运维状态"
        />
      </label>
      <div className="form-row">
        <label>
          类型
          <select
            aria-label="类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="task">普通任务</option>
            <option value="checklist">检查清单</option>
          </select>
        </label>
        <label>
          关联项目
          <ProjectSelect data={data} value={project} onChange={setProject} />
        </label>
      </div>
      <label>
        负责人 · 可选，仅文字记录
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          maxLength={200}
        />
      </label>
      <label>
        说明 · Markdown
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
        />
      </label>
      {kind === "checklist" && (
        <label>
          检查子项 · 每行一项
          <textarea
            required
            value={checks}
            onChange={(e) => setChecks(e.target.value)}
            rows={4}
            placeholder={"查看告警\n检查服务状态\n记录异常"}
          />
        </label>
      )}
      <div className="form-row">
        <label>
          重复规则
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as typeof frequency)}
          >
            {Object.entries(freq).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          {frequency === "once" ? "计划日期" : "开始日期"}
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>
      {frequency === "weekly" && (
        <div className="weekdays">
          {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
            <label key={d}>
              <input
                type="checkbox"
                checked={days.includes(i + 1)}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, i + 1].sort()
                      : days.filter((v) => v !== i + 1),
                  )
                }
              />
              周{d}
            </label>
          ))}
        </div>
      )}
      <div className="form-row">
        <label>
          时间 · 可留空
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <label>
          稍后提醒分钟数
          <input
            type="number"
            min={1}
            max={1440}
            required
            value={snooze}
            onChange={(e) => setSnooze(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={popup}
          onChange={(e) => setPopup(e.target.checked)}
        />
        到点弹出置顶提醒
      </label>
      <p className="hint">
        时间采用北京时间。工作日为周一至周五，不包含节假日调休规则。
      </p>
      <footer className="form-footer">
        <button type="submit" className="primary" disabled={busy}>
          保存事项
        </button>
      </footer>
    </form>
  );
}

function RunDetails({
  data,
  run,
  perform,
  finish,
  open,
  onDirty,
}: Actions & {
  run: Run;
  open: (m: Modal) => void;
  onDirty: (value: boolean) => void;
}) {
  const [result, setResult] = useState(""),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(run?.config.title || ""),
    [body, setBody] = useState(run?.config.content_markdown || ""),
    [skipMode, setSkipMode] = useState(false),
    [reason, setReason] = useState("");
  useEffect(() => {
    onDirty(Boolean(result) || editing || skipMode);
  }, [result, editing, skipMode]);
  if (!run) return <Empty>记录不存在</Empty>;
  const template = data.templates.find((t) => t.id === run.templateId);
  const pending = ["pending", "doing"].includes(run.state);
  return (
    <div>
      <div className="detail-title">
        <h2>{run.config.title}</h2>
        <span className={`badge ${run.state}`}>{states[run.state]}</span>
      </div>
      <p className="meta">
        {run.date} {run.config.schedule.time || "全天"} ·{" "}
        {data.projects.find((p) => p.id === run.config.project_id)?.name ||
          "个人事项"}
        {run.config.owner ? ` · 负责人：${run.config.owner}` : ""}
        {run.startedAt ? " · 已开始，配置更新将保留本记录" : ""}
      </p>
      {template?.paused && (
        <p className="hint">此配置已暂停，当前记录仍可处理，提醒已停止。</p>
      )}
      {editing ? (
        <div>
          <label>
            本次标题
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            本次说明
            <textarea value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <button
            onClick={async () => {
              if (
                await perform(
                  () => api.items.editRun(run.id, title, body),
                  "本次记录已更新",
                )
              )
                setEditing(false);
            }}
          >
            保存本次修改
          </button>
        </div>
      ) : (
        <Markdown text={run.config.content_markdown} />
      )}
      {run.config.checklist.length > 0 && (
        <div className="checklist">
          {run.config.checklist.map((c) => (
            <label key={c.id} className="check-row">
              <RunCheck
                checked={Boolean(run.checks[c.id])}
                disabled={!pending}
                save={(value) =>
                  perform(() => api.items.check(run.id, c.id, value))
                }
              />
              <span>{c.text}</span>
            </label>
          ))}
        </div>
      )}
      {run.skipReason && <p className="hint">跳过原因：{run.skipReason}</p>}
      <label>
        处理结果 · 可选
        <textarea
          value={result}
          onChange={(e) => setResult(e.target.value)}
          placeholder="做了什么、发现什么、下一步是什么…"
          rows={3}
        />
      </label>
      {result.trim() && (
        <button
          onClick={async () => {
            if (
              await perform(
                () =>
                  api.records.saveLog({
                    body: result,
                    date: data.today,
                    runId: run.id,
                    projectId: run.config.project_id,
                  }),
                "结果已记录",
              )
            )
              setResult("");
          }}
        >
          仅保存结果
        </button>
      )}
      <div className="related-logs">
        {data.logs
          .filter((l) => l.runId === run.id)
          .map((l) => (
            <div key={l.id}>
              <small>{l.date}</small>
              <Markdown text={l.body} />
            </div>
          ))}
      </div>
      <div className="detail-tools">
        <button className="text-button" onClick={() => setEditing(!editing)}>
          编辑本次内容
        </button>
        {template && (
          <button
            className="text-button"
            onClick={() => open({ type: "item", config: template.config })}
          >
            编辑配置
          </button>
        )}
        {template?.noteId && (
          <button
            className="text-button"
            onClick={() =>
              open({
                type: "note",
                note: data.notes.find((n) => n.id === template.noteId),
              })
            }
          >
            查看关联笔记
          </button>
        )}
      </div>
      {skipMode && (
        <label>
          跳过原因 · 可留空
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </label>
      )}
      <footer className="form-footer">
        {pending ? (
          <>
            {skipMode ? (
              <>
                <button onClick={() => setSkipMode(false)}>取消跳过</button>
                <button
                  onClick={async () => {
                    if (
                      await perform(
                        () =>
                          api.items.state(run.id, "skipped", result, reason),
                        "已跳过",
                      )
                    )
                      finish();
                  }}
                >
                  确认跳过
                </button>
              </>
            ) : (
              <button onClick={() => setSkipMode(true)}>跳过</button>
            )}
            {run.config.type === "task" && run.state === "pending" && (
              <button
                onClick={() =>
                  void perform(() => api.items.state(run.id, "doing"), "已开始")
                }
              >
                开始处理
              </button>
            )}
            <button
              className="primary"
              onClick={async () => {
                if (
                  run.config.checklist.some((c) => !run.checks[c.id]) &&
                  !confirm("还有检查子项未勾选，仍然确认完成？")
                )
                  return;
                if (
                  await perform(
                    () => api.items.state(run.id, "completed", result),
                    "已完成",
                  )
                )
                  finish();
              }}
            >
              确认完成
            </button>
          </>
        ) : (
          run.state !== "withdrawn" && (
            <button
              onClick={() =>
                void perform(
                  () => api.items.state(run.id, "pending"),
                  "已重新打开，不会补弹旧提醒",
                )
              }
            >
              重新打开
            </button>
          )
        )}
      </footer>
    </div>
  );
}

function RunCheck({
  checked,
  disabled,
  save,
}: {
  checked: boolean;
  disabled: boolean;
  save: (value: boolean) => Promise<boolean>;
}) {
  const [value, setValue] = useState(checked);
  useEffect(() => setValue(checked), [checked]);
  return (
    <input
      type="checkbox"
      disabled={disabled}
      checked={value}
      onChange={async (e) => {
        const next = e.target.checked;
        setValue(next);
        if (!(await save(next))) setValue(checked);
      }}
    />
  );
}

function Templates({
  data,
  open,
  perform,
}: Actions & { open: (m: Modal) => void }) {
  const [archived, setArchived] = useState(false);
  return (
    <div>
      <div className="toolbar">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          显示归档
        </label>
        <button className="primary" onClick={() => open({ type: "item" })}>
          新建配置
        </button>
      </div>
      <p className="hint">
        所有事项都可以导出交给 Agent 修改。历史记录不会随配置归档而删除。
      </p>
      {data.templates
        .filter((t) => archived || !t.archived)
        .map((t) => (
          <div className="template-row" key={t.id}>
            <div>
              <strong>{t.config.title}</strong>
              <p className="meta">
                {freq[t.config.schedule.frequency]} ·{" "}
                {t.config.schedule.time || "不定时"}
                {t.paused ? " · 已暂停" : ""}
                {t.archived ? " · 已归档" : ""}
              </p>
              <code className="small-id">{t.id}</code>
            </div>
            <div className="row-actions">
              <button onClick={() => open({ type: "item", config: t.config })}>
                编辑
              </button>
              <button
                onClick={() =>
                  void perform(() =>
                    api.items.setMode(t.id, !t.paused, t.archived),
                  )
                }
              >
                {t.paused ? "恢复" : "暂停"}
              </button>
              <button
                onClick={() =>
                  void perform(() =>
                    api.items.setMode(t.id, t.paused, !t.archived),
                  )
                }
              >
                {t.archived ? "取消归档" : "归档"}
              </button>
            </div>
          </div>
        ))}
      {!data.templates.length && (
        <Empty>添加例行检查，让到点提醒帮你记住。</Empty>
      )}
    </div>
  );
}

function Projects({
  data,
  open,
  card,
  perform,
}: {
  data: Snapshot;
  open: (m: Modal) => void;
  card: (r: Run) => React.ReactNode;
  perform: Actions["perform"];
}) {
  const [selected, setSelected] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  const projects = data.projects.filter((p) => showArchived || !p.archived);
  const project = projects.find((p) => p.id === selected) || projects[0];
  const runs = data.runs.filter(
    (r) => r.config.project_id === project?.id && r.state !== "withdrawn",
  );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECTS</p>
          <h1>看清进度，推进下一步</h1>
        </div>
        <button className="primary" onClick={() => open({ type: "project" })}>
          ＋ 新建项目
        </button>
      </div>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        显示归档项目
      </label>
      {!projects.length ? (
        <Empty>创建一个项目，把相关任务和进展放在一起。</Empty>
      ) : (
        <>
          <div className="project-selector">
            {projects.map((p) => (
              <button
                className={project?.id === p.id ? "active" : ""}
                key={p.id}
                onClick={() => setSelected(p.id)}
              >
                <strong>{p.name}</strong>
                <small>
                  {states[p.state]} · {p.progress}%
                  {p.archived ? " · 已归档" : ""}
                </small>
                <div className="progress-track">
                  <i style={{ width: `${p.progress}%` }} />
                </div>
              </button>
            ))}
          </div>
          {project && (
            <>
              <div className="project-detail">
                <div>
                  <h2>
                    {project.name}{" "}
                    <span className="badge">{states[project.state]}</span>
                  </h2>
                  <p className="muted">
                    {project.description || "暂无项目说明"}
                  </p>
                  <p className="meta">
                    负责人：{project.owner || "未设置"} · 项目进度手动维护 ·
                    ID：{project.id}
                  </p>
                </div>
                <button onClick={() => open({ type: "project", project })}>
                  编辑项目
                </button>
              </div>
              {project.update && (
                <div className="project-update">
                  <small>最新进展</small>
                  <Markdown text={project.update} />
                </div>
              )}
              <div className="section-heading">
                <h2>项目任务</h2>
                <button
                  onClick={() =>
                    open({
                      type: "item",
                      config: {
                        id: crypto.randomUUID(),
                        title: "",
                        type: "task",
                        project_id: project.id,
                        content_markdown: "",
                        checklist: [],
                        schedule: {
                          frequency: "once",
                          date: data.today,
                          timezone: "Asia/Shanghai",
                        },
                        reminder: { popup: false, snooze_minutes: 10 },
                      },
                    })
                  }
                >
                  ＋ 添加任务
                </button>
              </div>
              <div className="board">
                {[
                  ["pending", "待办"],
                  ["doing", "进行中"],
                  ["completed", "已完成"],
                ].map(([state, label]) => (
                  <section className="board-column" key={state}>
                    <h3>
                      <i className={state} />
                      {label}
                      <small>
                        {
                          runs.filter(
                            (r) =>
                              r.config.type === "task" && r.state === state,
                          ).length
                        }
                      </small>
                    </h3>
                    {runs
                      .filter(
                        (r) => r.config.type === "task" && r.state === state,
                      )
                      .map((r) => (
                        <div className="board-task" key={r.id}>
                          <button
                            className="board-title"
                            onClick={() => open({ type: "run", id: r.id })}
                          >
                            {r.config.title}
                          </button>
                          <p className="meta">{r.date}</p>
                          <select
                            aria-label={`移动 ${r.config.title}`}
                            value={r.state}
                            onChange={(e) =>
                              void perform(() =>
                                api.items.state(
                                  r.id,
                                  e.target.value as Run["state"],
                                ),
                              )
                            }
                          >
                            <option value="pending">待办</option>
                            <option value="doing">进行中</option>
                            <option value="completed">已完成</option>
                          </select>
                        </div>
                      ))}
                  </section>
                ))}
              </div>
              <div className="section-heading">
                <h2>今天的项目检查</h2>
                <span className="muted">
                  {
                    runs.filter(
                      (r) =>
                        r.config.type === "checklist" &&
                        r.date === data.today &&
                        r.state === "completed",
                    ).length
                  }{" "}
                  /{" "}
                  {
                    runs.filter(
                      (r) =>
                        r.config.type === "checklist" && r.date === data.today,
                    ).length
                  }{" "}
                  已完成
                </span>
              </div>
              {runs
                .filter(
                  (r) => r.config.type === "checklist" && r.date === data.today,
                )
                .map(card)}
              <details className="section-details">
                <summary>历史检查与已跳过任务</summary>
                {runs
                  .filter(
                    (r) =>
                      (r.config.type === "checklist" &&
                        r.date !== data.today) ||
                      r.state === "skipped",
                  )
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .map(card)}
              </details>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ProjectForm({
  project,
  perform,
  finish,
}: Actions & { project?: Project }) {
  const [value, setValue] = useState<Project>(
      project || {
        id: "",
        name: "",
        description: "",
        owner: "",
        state: "unstarted",
        progress: 0,
        update: "",
        archived: false,
      },
    ),
    [logUpdate, setLogUpdate] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await perform(
            () =>
              api.projects.save({
                ...value,
                id: value.id || undefined,
                logUpdate,
              }),
            "项目已保存",
          )
        )
          finish();
      }}
    >
      <label>
        项目名称
        <input
          autoFocus
          required
          maxLength={200}
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
        />
      </label>
      <label>
        说明
        <textarea
          value={value.description}
          onChange={(e) => setValue({ ...value, description: e.target.value })}
        />
      </label>
      <div className="form-row">
        <label>
          负责人 · 仅文字记录
          <input
            value={value.owner}
            onChange={(e) => setValue({ ...value, owner: e.target.value })}
          />
        </label>
        <label>
          状态
          <select
            value={value.state}
            onChange={(e) =>
              setValue({ ...value, state: e.target.value as Project["state"] })
            }
          >
            {["unstarted", "active", "paused", "completed"].map((s) => (
              <option key={s} value={s}>
                {states[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          进度 %
          <input
            type="number"
            required
            min={0}
            max={100}
            value={value.progress}
            onChange={(e) =>
              setValue({ ...value, progress: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <label>
        最新进展
        <textarea
          value={value.update}
          onChange={(e) => setValue({ ...value, update: e.target.value })}
          rows={4}
        />
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={logUpdate}
          onChange={(e) => setLogUpdate(e.target.checked)}
        />
        同时把这条进展记入工作流水
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={value.archived}
          onChange={(e) => setValue({ ...value, archived: e.target.checked })}
        />
        归档项目（保留任务和记录）
      </label>
      <footer className="form-footer">
        <button className="primary">保存项目</button>
      </footer>
    </form>
  );
}

function Records({ data, open }: { data: Snapshot; open: (m: Modal) => void }) {
  const [limit, setLimit] = useState(100);
  const [tab, setTab] = useState("logs"),
    [search, setSearch] = useState(""),
    [project, setProject] = useState<string | null>(null),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  useEffect(() => setLimit(100), [tab, search, project, from, to]);
  const logs = data.logs
    .filter(
      (l) =>
        (!project || l.projectId === project) &&
        (!from || l.date >= from) &&
        (!to || l.date <= to) &&
        l.body.toLowerCase().includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    );
  const notes = data.notes
    .filter(
      (n) =>
        (!project || n.projectId === project) &&
        `${n.title}\n${n.body}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">RECORDS</p>
          <h1>随手记下，之后用得上</h1>
          <p className="muted">工作流水用于汇报，普通笔记留给自己。</p>
        </div>
        <div className="row-actions">
          <button onClick={() => open({ type: "report" })}>整理汇报</button>
          <button
            className="primary"
            onClick={() => open({ type: tab === "logs" ? "log" : "note" })}
          >
            ＋ {tab === "logs" ? "工作流水" : "普通笔记"}
          </button>
        </div>
      </div>
      <div className="tabs">
        <button
          className={tab === "logs" ? "active" : ""}
          onClick={() => setTab("logs")}
        >
          工作流水
        </button>
        <button
          className={tab === "notes" ? "active" : ""}
          onClick={() => setTab("notes")}
        >
          普通笔记
        </button>
      </div>
      <div className="filter-bar">
        <input
          aria-label="搜索记录"
          placeholder="搜索关键词…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ProjectSelect data={data} value={project} onChange={setProject} />
        {tab === "logs" && (
          <>
            <input
              aria-label="起始日期"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span>至</span>
            <input
              aria-label="结束日期"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </>
        )}
      </div>
      {tab === "logs" ? (
        <div className="record-list">
          {logs.slice(0, limit).map((l) => (
            <button
              key={l.id}
              className="record-card"
              onClick={() => open({ type: "log", log: l })}
            >
              <span className="meta">
                {l.date} ·{" "}
                {data.projects.find((p) => p.id === l.projectId)?.name ||
                  "未关联项目"}
                {l.runId ? " · 任务处理结果" : ""}
              </span>
              <p>{l.body}</p>
              <small>记录于 {formatTime(l.createdAt)}</small>
            </button>
          ))}
          {logs.length > limit && (
            <button onClick={() => setLimit(limit + 100)}>
              再显示 100 条（共 {logs.length} 条）
            </button>
          )}
          {!logs.length && <Empty>还没有匹配的工作流水。</Empty>}
        </div>
      ) : (
        <div className="note-grid">
          {notes.slice(0, limit).map((n) => (
            <button
              key={n.id}
              className="note-card"
              onClick={() => open({ type: "note", note: n })}
            >
              <h3>{n.title}</h3>
              <p>{n.body.slice(0, 180) || "暂无正文"}</p>
              <span className="meta">更新于 {formatTime(n.updatedAt)}</span>
            </button>
          ))}
          {notes.length > limit && (
            <button onClick={() => setLimit(limit + 100)}>显示更多笔记</button>
          )}
          {!notes.length && <Empty>写下一份备忘，或一个还没成形的想法。</Empty>}
        </div>
      )}
    </div>
  );
}

function LogForm({ data, log, perform, finish }: Actions & { log?: WorkLog }) {
  const [body, setBody] = useState(log?.body || ""),
    [date, setDate] = useState(log?.date || data.today),
    [project, setProject] = useState(log?.projectId || null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await perform(
            () =>
              api.records.saveLog({
                id: log?.id,
                body,
                date,
                projectId: project,
                runId: log?.runId || null,
              }),
            "工作流水已保存",
          )
        )
          finish();
      }}
    >
      <label>
        做了什么
        <textarea
          autoFocus
          required
          rows={7}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="写一句也可以，支持 Markdown。"
        />
      </label>
      <div className="form-row">
        <label>
          归属日期
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          关联项目
          <ProjectSelect data={data} value={project} onChange={setProject} />
        </label>
      </div>
      {log && (
        <p className="hint">
          实际记录时间：{formatTime(log.createdAt)} · 修改时间：
          {formatTime(log.updatedAt)}
        </p>
      )}
      <footer className="form-footer">
        {log && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (
                confirm("删除这条工作流水？关联任务的完成记录仍保留。") &&
                (await perform(() => api.records.deleteLog(log.id)))
              )
                finish();
            }}
          >
            删除
          </button>
        )}
        <button className="primary">保存记录</button>
      </footer>
    </form>
  );
}

function NoteForm({
  data,
  note,
  perform,
  finish,
  open,
}: Actions & { note?: Note; open: (m: Modal) => void }) {
  const [title, setTitle] = useState(note?.title || ""),
    [body, setBody] = useState(note?.body || ""),
    [project, setProject] = useState(note?.projectId || null),
    [preview, setPreview] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await perform(
            () =>
              api.records.saveNote({
                id: note?.id,
                title,
                body,
                projectId: project,
              }),
            "笔记已保存",
          )
        )
          finish();
      }}
    >
      <label>
        标题
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
      </label>
      <div className="toolbar">
        <span className="muted">Markdown 笔记 · 不默认进入汇报素材</span>
        <button type="button" onClick={() => setPreview(!preview)}>
          {preview ? "返回编辑" : "预览"}
        </button>
      </div>
      {preview ? (
        <div className="note-preview">
          <Markdown text={body} />
        </div>
      ) : (
        <label>
          正文
          <textarea
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      )}
      <label>
        关联项目
        <ProjectSelect data={data} value={project} onChange={setProject} />
      </label>
      <footer className="form-footer">
        {note && (
          <>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (
                  confirm("删除这篇笔记？关联提醒仍然保留。") &&
                  (await perform(() => api.records.deleteNote(note.id)))
                )
                  finish();
              }}
            >
              删除
            </button>
            <button
              type="button"
              onClick={() => open({ type: "item", noteId: note.id })}
            >
              创建关联提醒
            </button>
          </>
        )}
        <button className="primary">保存笔记</button>
      </footer>
    </form>
  );
}

function ImportPanel({ data, perform, notify }: Actions) {
  const example = {
    schema_version: 1,
    items: [
      {
        id: "daily-ops-check",
        type: "checklist",
        title: "检查运维状态",
        content_markdown: "如有异常，记录处理情况。",
        checklist: [
          { id: "alerts", text: "查看告警" },
          { id: "services", text: "检查服务状态" },
        ],
        schedule: {
          frequency: "weekdays",
          start_date: data.today,
          time: "09:30",
          timezone: "Asia/Shanghai",
        },
        reminder: { popup: true, snooze_minutes: 10 },
      },
    ],
  };
  const [text, setText] = useState(""),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [busy, setBusy] = useState(false);
  const change = (v: string) => {
    setText(v);
    setPreview(null);
  };
  return (
    <div>
      <p className="hint">
        让 Agent 生成 JSON，先预览再应用。相同 id
        更新配置；未出现在文件中的事项保持不变。
      </p>
      <div className="toolbar">
        <div className="row-actions">
          <button onClick={() => change(JSON.stringify(example, null, 2))}>
            填入示例
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                const t = await api.imports.readFile();
                if (t !== null) change(t);
              })
            }
          >
            选择 JSON 文件
          </button>
        </div>
        <button
          onClick={() =>
            void perform(async () => {
              if (await api.imports.export()) notify("配置已导出");
            })
          }
        >
          导出现有配置
        </button>
      </div>
      <textarea
        className="code-input"
        aria-label="JSON 配置"
        rows={15}
        value={text}
        onChange={(e) => change(e.target.value)}
        spellCheck={false}
        placeholder='{"schema_version": 1, "items": [...]}'
      />
      <div className="form-footer">
        <button
          className="primary"
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true);
            setPreview(null);
            await perform(async () =>
              setPreview(await api.imports.preview(text)),
            );
            setBusy(false);
          }}
        >
          校验并预览
        </button>
      </div>
      {preview && (
        <div>
          <h3>即将应用的变更</h3>
          {preview.changes.map((c) => (
            <div key={c.id} className="import-change">
              <div>
                <span
                  className={`badge ${c.action === "add" ? "completed" : ""}`}
                >
                  {
                    { add: "新增", update: "修改", unchanged: "未变化" }[
                      c.action
                    ]
                  }
                </span>
                <strong>{c.title}</strong>
              </div>
              <p className="meta">
                {c.id}
                {c.fields.length ? ` · 修改 ${c.fields.join("、")}` : ""}
              </p>
              {c.action === "update" && (
                <p>
                  同步 {c.syncCount} 条未开始记录 · 保留 {c.protectedCount}{" "}
                  条已操作记录
                </p>
              )}
              {c.warnings.map((w) => (
                <p className="warning-text" key={w}>
                  {w}
                </p>
              ))}
            </div>
          ))}
          <footer className="form-footer">
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                if (
                  await perform(
                    () => api.imports.commit(preview.token),
                    "配置已应用",
                  )
                ) {
                  setPreview(null);
                  setText("");
                }
                setBusy(false);
              }}
            >
              确认应用整批配置
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function ReportPanel({ data, perform, notify }: Actions) {
  const weekStart = () => {
    const d = new Date(`${data.today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
    return d.toISOString().slice(0, 10);
  };
  const [from, setFrom] = useState(weekStart()),
    [to, setTo] = useState(data.today),
    [pending, setPending] = useState(false),
    [grouping, setGrouping] = useState<"date" | "project">("date");
  const [entries, setEntries] = useState<ReportEntry[] | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const reset = () => setEntries(null);
  return (
    <div>
      <div className="toolbar">
        <div className="row-actions">
          <button
            onClick={() => {
              setFrom(data.today);
              setTo(data.today);
              reset();
            }}
          >
            今天
          </button>
          <button
            onClick={() => {
              const start = weekStart();
              const end = new Date(`${start}T12:00:00Z`);
              end.setUTCDate(end.getUTCDate() + 6);
              setFrom(start);
              setTo(end.toISOString().slice(0, 10));
              reset();
            }}
          >
            本周
          </button>
        </div>
        <select
          aria-label="汇报分组"
          value={grouping}
          onChange={(e) => setGrouping(e.target.value as typeof grouping)}
        >
          <option value="date">按日期分组</option>
          <option value="project">按项目分组</option>
        </select>
      </div>
      <div className="form-row">
        <label>
          开始日期
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              reset();
            }}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              reset();
            }}
          />
        </label>
      </div>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={pending}
          onChange={(e) => {
            setPending(e.target.checked);
            reset();
          }}
        />
        额外包含待跟进事项
      </label>
      <p className="hint">
        普通笔记不会自动加入。请选择需要交给 Agent 的工作素材。
      </p>
      <button
        className="primary"
        onClick={() =>
          void perform(async () => {
            const list = await api.reports.preview({
              from,
              to,
              includePending: pending,
            });
            setEntries(list);
            setSelected(new Set(list.map((e) => e.id)));
          })
        }
      >
        生成素材预览
      </button>
      {entries && (
        <>
          <div className="section-heading">
            <h3>
              选中 {selected.size} / {entries.length} 条
            </h3>
            <button
              className="text-button"
              onClick={() =>
                setSelected(
                  selected.size ? new Set() : new Set(entries.map((e) => e.id)),
                )
              }
            >
              {selected.size ? "取消全选" : "全选"}
            </button>
          </div>
          {entries.map((e) => (
            <div className="report-entry" key={e.id}>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={selected.has(e.id)}
                  onChange={(ev) => {
                    const next = new Set(selected);
                    ev.target.checked ? next.add(e.id) : next.delete(e.id);
                    setSelected(next);
                  }}
                />
                <strong>{e.title}</strong>
                <small>
                  {e.date} ·{" "}
                  {data.projects.find((p) => p.id === e.projectId)?.name ||
                    "未关联项目"}
                </small>
              </label>
              <Markdown
                text={e.body || (e.kind === "completed" ? "已完成" : "待跟进")}
              />
            </div>
          ))}
          {!entries.length && <Empty>所选日期没有可汇总的记录。</Empty>}
          <footer className="form-footer">
            <button
              disabled={!selected.size}
              onClick={() =>
                void perform(async () => {
                  if (
                    await api.reports.output(
                      entries.filter((e) => selected.has(e.id)),
                      grouping,
                      true,
                    )
                  )
                    notify("Markdown 已导出");
                })
              }
            >
              导出 Markdown
            </button>
            <button
              className="primary"
              disabled={!selected.size}
              onClick={() =>
                void perform(async () => {
                  if (
                    await api.reports.output(
                      entries.filter((e) => selected.has(e.id)),
                      grouping,
                      false,
                    )
                  )
                    notify("已复制，可粘贴给 Agent 整理");
                })
              }
            >
              复制素材
            </button>
          </footer>
        </>
      )}
    </div>
  );
}

function SettingsPanel({ data, perform, finish, notify }: Actions) {
  const [settings, setSettings] = useState(data.settings),
    [backup, setBackup] = useState<BackupPreview | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await perform(() => api.settings.save(settings), "设置已保存"))
            finish();
        }}
      >
        <h3>日常使用</h3>
        <label>
          快速记录快捷键
          <input
            value={settings.shortcut}
            onChange={(e) =>
              setSettings({ ...settings, shortcut: e.target.value })
            }
            placeholder="Ctrl+Alt+J"
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={settings.autoStart}
            onChange={(e) =>
              setSettings({ ...settings, autoStart: e.target.checked })
            }
          />
          登录 Windows 后自动启动
        </label>
        <p className="hint">
          关闭主窗口后仍在托盘运行；退出程序后无法提醒。所有时间采用北京时间。
        </p>
        <button className="primary">保存设置</button>
      </form>
      <hr />
      <h3>本地数据</h3>
      <p className="path-text">{data.dataPath}</p>
      <p className="hint">
        数据仅在这台电脑保存，不包含应用级加密。备份文件也包含你的私人记录，请自行妥善保存。
      </p>
      <div className="row-actions">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await perform(async () => {
              if (await api.backup.create()) notify("备份已保存");
            });
            setBusy(false);
          }}
        >
          导出完整备份
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => setBackup(await api.backup.preview()))
          }
        >
          选择备份并预览
        </button>
      </div>
      {backup && (
        <div className="restore-preview">
          <h4>恢复预览</h4>
          <p>备份时间：{backup.createdAt}</p>
          <p>
            项目 {backup.counts.projects} · 事项配置 {backup.counts.templates} ·
            执行记录 {backup.counts.runs} · 流水 {backup.counts.logs} · 笔记{" "}
            {backup.counts.notes}
          </p>
          <p className="warning-text">
            恢复将全量替换当前数据。程序会先自动保存当前数据的备份。
          </p>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm("确认使用此备份替换当前所有业务数据和设置？"))
                return;
              setBusy(true);
              if (
                await perform(
                  () => api.backup.restore(backup.token),
                  "数据已恢复",
                )
              )
                finish();
              setBusy(false);
            }}
          >
            确认恢复
          </button>
        </div>
      )}
    </div>
  );
}

function QuickWindow() {
  const { data, error } = useSnapshot(),
    [body, setBody] = useState(""),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api.window.dirty(Boolean(body));
    return () => api.window.dirty(false);
  }, [body]);
  useEffect(() => {
    const focus = () => document.querySelector("textarea")?.focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await api.records.saveLog({ body, date: data?.today || today() });
      setBody("");
      api.window.dirty(false);
      await api.window.close();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="quick-window">
      <h2>刚刚做了什么？</h2>
      {(failure || error) && (
        <p role="alert" className="error-text">
          {failure || error}
        </p>
      )}
      <textarea
        autoFocus
        aria-label="随手记内容"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            void save();
          }
        }}
        placeholder="写一句就好…"
      />
      <footer>
        <small>Enter 保存 · Shift + Enter 换行</small>
        <button
          className="primary"
          disabled={busy || !body.trim()}
          onClick={() => void save()}
        >
          记下来
        </button>
      </footer>
    </div>
  );
}
function ReminderWindow() {
  const [runs, setRuns] = useState<Run[]>([]),
    [error, setError] = useState("");
  const load = async () => {
    try {
      setRuns(await api.reminders.list());
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    void load();
    return api.onChange(() => void load());
  }, []);
  const action = async (fn: () => Promise<void>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className="reminder-window">
      <div className="reminder-heading">
        <span>◷</span>
        <div>
          <h2>到点了，处理一下</h2>
          <small>{runs.length} 项待处理 · 关闭提醒不会完成任务</small>
        </div>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="reminder-list">
        {runs.map((r) => (
          <article key={r.id}>
            <strong>{r.config.title}</strong>
            <p className="meta">
              {r.config.schedule.time} ·{" "}
              {r.config.checklist.length
                ? `${r.config.checklist.length} 个检查项`
                : "待办事项"}
            </p>
            <div className="row-actions">
              <button
                className="primary small"
                onClick={() => void action(() => api.reminders.open(r.id))}
              >
                打开任务
              </button>
              <button
                className="small"
                onClick={() => void action(() => api.reminders.snooze(r.id))}
              >
                {r.config.reminder.snooze_minutes} 分钟后
              </button>
            </div>
          </article>
        ))}
      </div>
      <button
        className="text-button"
        onClick={() =>
          void action(() => api.reminders.dismiss(runs.map((r) => r.id)))
        }
      >
        关闭本次提醒
      </button>
    </div>
  );
}
const kind = new URLSearchParams(location.search).get("window");
createRoot(document.getElementById("root")!).render(
  kind === "quick" ? (
    <QuickWindow />
  ) : kind === "reminder" ? (
    <ReminderWindow />
  ) : (
    <App />
  ),
);

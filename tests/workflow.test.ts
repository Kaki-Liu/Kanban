import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/main/store";
import {
  workflowSchema,
  workflowTaskSchema,
  type Workflow,
  type WorkflowTask,
} from "../src/shared/workflow";

let directory: string, store: Store, now: Date;
const task = (patch: Partial<WorkflowTask> = {}): WorkflowTask =>
  workflowTaskSchema.parse({
    id: "task-1",
    title: "创建可运行演示",
    milestoneId: "first",
    ...patch,
  });
const workflow = (patch: Partial<Workflow> = {}): Workflow =>
  workflowSchema.parse({
    mode: "novice",
    goal: "帮助值班人员完成检查",
    acceptance: "关闭主窗口后仍收到提醒",
    milestones: [{ id: "first", title: "做通核心流程", state: "active" }],
    tasks: [task()],
    ...patch,
  });
const save = (value: Workflow) =>
  store.saveWorkflow("project-1", value, store.revision());
const saved = () => store.snapshot().projects[0].workflow!;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kanban-workflow-"));
  now = new Date("2026-10-28T02:00:00Z");
  store = new Store(join(directory, "test.db"), () => now);
  store.saveProject({ id: "project-1", name: "开发测试项目" });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("开发流程持久化和兼容", () => {
  test("旧项目可启用流程，重启保留，旧表单编辑不擦除流程", () => {
    expect(store.snapshot().projects[0].workflow).toBeUndefined();
    const value = workflow();
    save(value);
    store.saveProject({ id: "project-1", name: "修改名称" });
    expect(saved()).toEqual(value);
    store.close();
    store = new Store(join(directory, "test.db"), () => now);
    expect(saved()).toEqual(value);
    expect(store.snapshot().projects[0].name).toBe("修改名称");
  });
  test("新建项目支持模板，普通项目表单不得绕过并发检查修改流程", () => {
    store.saveProject({
      id: "project-2",
      name: "新项目",
      workflow: workflow(),
    });
    expect(store.snapshot().projects[1].workflow?.mode).toBe("novice");
    save(workflow());
    const revision = store.revision();
    expect(() =>
      store.saveProject({
        id: "project-1",
        name: "不该写入",
        workflow: workflow({ goal: "覆盖目标" }),
      }),
    ).toThrow("开发流程已变化");
    expect(store.revision()).toBe(revision);
    expect(store.snapshot().projects[0].name).toBe("开发测试项目");
    expect(saved().goal).not.toBe("覆盖目标");
  });
  test("旧表单非法字段不会擦除新流程，原样携带流程的编辑仍可保存", () => {
    const value = workflow();
    save(value);
    const revision = store.revision();
    expect(() =>
      store.saveProject({ id: "project-1", name: "非法旧表单", progress: 101 }),
    ).toThrow();
    expect(saved()).toEqual(value);
    expect(store.revision()).toBe(revision);
    store.saveProject({
      ...store.snapshot().projects[0],
      name: "原样保留流程",
    });
    expect(saved()).toEqual(value);
    expect(store.snapshot().projects[0].name).toBe("原样保留流程");
  });
  test("过期草稿和不存在项目整批拒绝，合法更新只增加一次版本", () => {
    save(workflow());
    const revision = store.revision();
    store.saveNote({ title: "个人记录", body: "不进入交接内容" });
    expect(() =>
      store.saveWorkflow("project-1", workflow({ goal: "旧草稿" }), revision),
    ).toThrow("数据已变化");
    expect(saved().goal).not.toBe("旧草稿");
    const current = store.revision();
    expect(() => store.saveWorkflow("missing", workflow(), current)).toThrow(
      "项目不存在",
    );
    expect(store.revision()).toBe(current);
    save(workflow({ goal: "新草稿" }));
    expect(store.revision()).toBe(current + 1);
  });
  test("事务中写入失败会回滚流程、流水和版本", () => {
    const value = workflow();
    save(value);
    const revision = store.revision();
    store.db.exec(
      "CREATE TRIGGER fail_log BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'write failed'); END;",
    );
    const completed = workflow({
      tasks: [
        task({ state: "done", acceptance: "能够运行", evidence: "已运行通过" }),
      ],
    });
    expect(() => save(completed)).toThrow("write failed");
    expect(saved()).toEqual(value);
    expect(store.snapshot().logs).toHaveLength(0);
    expect(store.revision()).toBe(revision);
  });
  test("开始后退回待办不能清除已开始事实", () => {
    save(workflow({ tasks: [task({ state: "doing", hasStarted: false })] }));
    expect(saved().tasks[0].hasStarted).toBe(true);
    save(workflow({ tasks: [task({ state: "todo", hasStarted: false })] }));
    expect(saved().tasks[0].state).toBe("todo");
    expect(saved().tasks[0].hasStarted).toBe(true);
    expect(() =>
      store.saveWorkflow(
        "project-1",
        {
          ...workflow(),
          tasks: [{ ...task(), hasStarted: "false" }],
        } as unknown as Workflow,
        store.revision(),
      ),
    ).toThrow();
    expect(saved().tasks[0].hasStarted).toBe(true);
  });
  test("填写阻碍、结果或交接都会保留已操作标记，新建项目也会正规化", () => {
    save(workflow({ tasks: [task({ blocker: "等待接口说明" })] }));
    expect(saved().tasks[0].hasStarted).toBe(true);
    save(workflow());
    expect(saved().tasks[0].hasStarted).toBe(true);
    store.saveProject({
      id: "created-active",
      name: "正在开发",
      workflow: workflow({ tasks: [task({ state: "doing" })] }),
    });
    expect(
      store.snapshot().projects.find((p) => p.id === "created-active")?.workflow
        ?.tasks[0].hasStarted,
    ).toBe(true);
    store.saveProject({
      id: "created-evidence",
      name: "已有试验结果",
      workflow: workflow({ tasks: [task({ evidence: "试验了一种实现方式" })] }),
    });
    expect(
      store.snapshot().projects.find((p) => p.id === "created-evidence")
        ?.workflow?.tasks[0].hasStarted,
    ).toBe(true);
  });
});

describe("工作流约束", () => {
  test("里程碑截止日期和同时开工数量合法，未设置仍兼容", () => {
    const value = workflow();
    expect(workflowSchema.parse(value).wipLimit).toBeUndefined();
    expect(() => workflowSchema.parse({ ...value, wipLimit: -1 })).toThrow();
    expect(() => workflowSchema.parse({ ...value, wipLimit: 1.5 })).toThrow();
    expect(() => workflowSchema.parse({ ...value, wipLimit: 21 })).toThrow();
    expect(() =>
      workflowSchema.parse({
        ...value,
        milestones: [{ ...value.milestones[0], dueDate: "2026-02-30" }],
      }),
    ).toThrow("日期不存在");
    const valid = workflowSchema.parse({
      ...value,
      wipLimit: 2,
      milestones: [{ ...value.milestones[0], dueDate: "2026-11-06" }],
    });
    save(valid);
    expect(saved().wipLimit).toBe(2);
    expect(saved().milestones[0].dueDate).toBe("2026-11-06");
  });
  test("未知字段、重复标识、错误日期和无效里程碑均报具体字段", () => {
    expect(() =>
      workflowSchema.parse({ ...workflow(), surprise: true }),
    ).toThrow();
    expect(() => workflow({ tasks: [task(), task()] })).toThrow("id 不能重复");
    expect(() =>
      workflow({ tasks: [task({ followUpDate: "2026-02-30" })] }),
    ).toThrow("日期不存在");
    expect(() =>
      workflow({ tasks: [task({ milestoneId: "missing" })] }),
    ).toThrow("里程碑不存在");
    expect(() =>
      workflow({
        decisions: [
          {
            id: "d",
            kind: "decision",
            topic: "确认范围",
            people: "甲",
            conclusion: "",
            impact: "",
            date: "2026-10-28",
            followUpDate: "",
            status: "confirmed",
          },
        ],
      }),
    ).toThrow("记录结论");
  });
  test("依赖不存在、自引用、重复依赖和循环依赖都拒绝", () => {
    expect(() =>
      workflow({ tasks: [task({ dependsOn: ["missing"] })] }),
    ).toThrow("依赖任务不存在");
    expect(() =>
      workflow({ tasks: [task({ dependsOn: ["task-1"] })] }),
    ).toThrow("不能依赖自己");
    expect(() =>
      workflow({
        tasks: [
          task({ dependsOn: ["second", "second"] }),
          task({ id: "second" }),
        ],
      }),
    ).toThrow("依赖不能重复");
    expect(() =>
      workflow({
        tasks: [
          task({ dependsOn: ["second"] }),
          task({ id: "second", dependsOn: ["task-1"] }),
        ],
      }),
    ).toThrow("存在循环");
  });
  test("完成任务必须有验收和结果，依赖未完成或尚有阻碍不能完成", () => {
    expect(() => workflow({ tasks: [task({ state: "done" })] })).toThrow(
      "验收标准",
    );
    expect(() =>
      workflow({ tasks: [task({ state: "done", acceptance: "能运行" })] }),
    ).toThrow("验证结果");
    expect(() =>
      workflow({
        tasks: [
          task({
            state: "done",
            acceptance: "能运行",
            evidence: "通过",
            blocker: "等待资料",
          }),
        ],
      }),
    ).toThrow("解除阻碍");
    expect(() =>
      workflow({
        tasks: [
          task({
            state: "done",
            acceptance: "能运行",
            evidence: "通过",
            dependsOn: ["second"],
          }),
          task({ id: "second" }),
        ],
      }),
    ).toThrow("依赖完成后");
  });
  test("交接接收与验收不同，交接通过必须有材料和验证记录", () => {
    const value = task({
      receiver: "测试同事",
      acceptance: "安装正常",
      evidence: "开发自测通过",
    });
    value.handoff.status = "received";
    value.handoff.artifacts = "release/installer.exe";
    expect(() => workflow({ tasks: [{ ...value, state: "done" }] })).toThrow(
      "交接验收通过",
    );
    value.handoff.status = "accepted";
    expect(() => workflow({ tasks: [value] })).toThrow("记录验证结果");
    value.handoff.verification = "已与接收人确认安装及启动正常";
    expect(
      workflow({ tasks: [{ ...value, state: "done" }] }).tasks[0].state,
    ).toBe("done");
    value.handoff.status = "returned";
    expect(() => workflow({ tasks: [value] })).toThrow("需要补充");
  });
  test("里程碑完成必须有依据且关联任务全部完成", () => {
    const value = workflow();
    value.milestones[0].state = "completed";
    expect(() => workflowSchema.parse(value)).toThrow("验收依据");
    value.milestones[0].evidence = "演示通过";
    expect(() => workflowSchema.parse(value)).toThrow("未完成的任务");
    value.tasks[0] = task({
      state: "done",
      acceptance: "能运行",
      evidence: "通过",
    });
    expect(workflowSchema.parse(value).milestones[0].state).toBe("completed");
  });
});

describe("开发记录和备份", () => {
  test("升级前只备份一次，快照保留原始项目 JSON 和旧版本标记", async () => {
    const original = store.db
      .prepare("SELECT data FROM projects WHERE id='project-1'")
      .get() as { data: string };
    await store.prepareVersion("0.2.0");
    const backupDirectory = join(directory, "backups");
    const files = readdirSync(backupDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^before-upgrade-0\.2\.0-/);
    const copy = new DatabaseSync(join(backupDirectory, files[0]), {
      readOnly: true,
    });
    try {
      expect(
        copy.prepare("SELECT data FROM projects WHERE id='project-1'").get(),
      ).toEqual(original);
      expect(
        copy.prepare("SELECT value FROM meta WHERE key='app_version'").get(),
      ).toBeUndefined();
    } finally {
      copy.close();
    }
    const revision = store.revision();
    await store.prepareVersion("0.2.0");
    expect(readdirSync(backupDirectory)).toHaveLength(1);
    expect(store.revision()).toBe(revision);
    expect(
      store.db.prepare("SELECT value FROM meta WHERE key='app_version'").get(),
    ).toEqual({ value: "0.2.0" });
  });
  test("空数据库不生成升级备份，失败不得记录版本且可以重试", async () => {
    const freshDirectory = join(directory, "fresh");
    const fresh = new Store(join(freshDirectory, "data.db"));
    try {
      await fresh.prepareVersion("0.2.0");
      expect(existsSync(join(freshDirectory, "backups"))).toBe(false);
    } finally {
      fresh.close();
    }
    const backupDirectory = join(directory, "backups");
    writeFileSync(
      backupDirectory,
      "simulate directory creation failure",
      "utf8",
    );
    await expect(store.prepareVersion("0.2.0")).rejects.toThrow();
    expect(
      store.db.prepare("SELECT value FROM meta WHERE key='app_version'").get(),
    ).toBeUndefined();
    rmSync(backupDirectory);
    await store.prepareVersion("0.2.0");
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
  test("完成结果自动入流水，重复保存与重新完成不重复，私人笔记不会混入", () => {
    store.saveNote({
      title: "个人笔记",
      body: "PRIVATE-NOTE-CONTENT",
      projectId: "project-1",
    });
    const value = workflow({
      tasks: [
        task({ state: "done", acceptance: "能运行", evidence: "安装验证通过" }),
      ],
    });
    save(value);
    save(value);
    expect(store.snapshot().logs).toHaveLength(1);
    const original = store.snapshot().logs[0];
    save(workflow());
    now = new Date("2026-10-29T02:00:00Z");
    save(
      workflow({
        tasks: [
          task({
            state: "done",
            acceptance: "能运行",
            evidence: "补充回归验证通过",
          }),
        ],
      }),
    );
    const logs = store.snapshot().logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe(original.id);
    expect(logs[0].date).toBe("2026-10-29");
    expect(logs[0].body).toContain("补充回归验证通过");
    expect(logs[0].body).not.toContain("PRIVATE-NOTE-CONTENT");
  });
  test("新旧项目备份均可恢复，流程无效的备份被拒绝", async () => {
    const oldPath = join(directory, "old.kanban-backup");
    await store.createBackup(oldPath);
    const value = workflow();
    save(value);
    const path = join(directory, "workflow.kanban-backup");
    await store.createBackup(path);
    save(workflow({ mode: "kanban", goal: "后续目标" }));
    await store.restoreBackup(store.previewBackup(path).token);
    expect(saved()).toEqual(value);
    await store.restoreBackup(store.previewBackup(oldPath).token);
    expect(store.snapshot().projects[0].workflow).toBeUndefined();
    const copy = new DatabaseSync(path);
    const broken = {
      ...store.snapshot().projects[0],
      workflow: { ...value, tasks: [task({ dependsOn: ["missing"] })] },
    };
    copy
      .prepare("UPDATE projects SET data=? WHERE id=?")
      .run(JSON.stringify(broken), "project-1");
    copy.close();
    expect(() => store.previewBackup(path)).toThrow("依赖任务不存在");
    expect(store.snapshot().projects[0].workflow).toBeUndefined();
  });
});

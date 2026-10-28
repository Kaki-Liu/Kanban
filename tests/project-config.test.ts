import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import {
  parseProjectConfig,
  newProjectConfig,
  projectConfigAgentPrompt,
} from "../src/shared/project-config";
import { workflowSchema, workflowTaskSchema } from "../src/shared/workflow";

let directory: string, store: Store;
const json = (project: unknown) =>
  JSON.stringify({ schema_version: 1, kind: "kanban-project", project });
const project = () =>
  store.snapshot().projects.find((p) => p.id === "existing")!;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kanban-project-config-"));
  store = new Store(
    join(directory, "test.db"),
    () => new Date("2026-10-28T02:00:00Z"),
  );
  store.saveProject({
    id: "existing",
    name: "原项目",
    description: "原说明",
    owner: "原负责人",
    progress: 30,
    update: "原进展",
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("完整项目配置文件", () => {
  test("给 Agent 的提示包含现有模板和全部可选字段的 Schema", () => {
    const prompt = projectConfigAgentPrompt(
      store.exportProjectConfig("existing"),
    );
    expect(prompt).toContain('"id": "existing"');
    expect(prompt).toContain('"kanban-project"');
    expect(prompt).toContain('"shapeup"');
    expect(prompt).toContain('"handoff"');
    expect(prompt).toContain('"submitted"');
    expect(prompt).toContain('"accepted"');
    expect(prompt).toContain("不要猜测真实人员的确认");
  });
  test("新建文件覆盖所有表单字段，预览不写入，确认使用同一个稳定 ID", () => {
    const draft = parseProjectConfig(newProjectConfig());
    draft.project.name = "Agent 填好的项目";
    draft.project.description = "部门协作应用";
    draft.project.owner = "小林";
    draft.project.state = "active";
    draft.project.progress = 12;
    draft.project.update = "确认第一轮范围";
    draft.project.archived = true;
    draft.project.workflow!.collaboration = "cross";
    draft.project.workflow!.milestones[0].dueDate = "2026-11-01";
    draft.project.workflow!.tasks[0].handoff.instructions = "安装包和接手步骤";
    const revision = store.revision();
    const preview = store.previewProjectConfig(JSON.stringify(draft));
    expect(preview.action).toBe("create");
    expect(store.snapshot().projects).toHaveLength(1);
    expect(store.revision()).toBe(revision);
    expect(
      preview.changes.some(
        (c) =>
          c.field === "project.workflow.tasks[task-1].handoff.instructions",
      ),
    ).toBe(true);
    expect(store.commitProjectConfig(preview.token)).toBe(preview.projectId);
    const created = store
      .snapshot()
      .projects.find((p) => p.id === preview.projectId)!;
    expect(created).toMatchObject({ ...draft.project, id: preview.projectId });
    expect(store.snapshot().logs).toHaveLength(0);
    expect(() => store.commitProjectConfig(preview.token)).toThrow(
      "预览已失效",
    );
  });

  test("已有项目全部基本字段可更新，省略字段恢复默认并在预览显示清空", () => {
    const preview = store.previewProjectConfig(
      json({
        id: "existing",
        name: "修改后",
        owner: "新负责人",
        state: "paused",
        progress: 80,
        archived: true,
      }),
    );
    expect(preview.action).toBe("update");
    expect(preview.changes).toContainEqual({
      field: "project.description",
      before: "原说明",
      after: "",
    });
    store.commitProjectConfig(preview.token);
    expect(project()).toMatchObject({
      name: "修改后",
      description: "",
      owner: "新负责人",
      state: "paused",
      progress: 80,
      update: "",
      archived: true,
    });
    const repeated = store.previewProjectConfig(
      store.exportProjectConfig("existing"),
    );
    expect(repeated.changes).toEqual([]);
    store.commitProjectConfig(repeated.token);
    expect(store.snapshot().projects).toHaveLength(1);
  });

  test("选择当前项目时允许省略 ID，拒绝填写另一个项目 ID 或空 ID", () => {
    const preview = store.previewProjectConfig(
      json({ name: "填入当前项目" }),
      "existing",
    );
    expect(preview.projectId).toBe("existing");
    store.commitProjectConfig(preview.token);
    expect(project().name).toBe("填入当前项目");
    expect(() =>
      store.previewProjectConfig(
        json({ id: "another", name: "错项目" }),
        "existing",
      ),
    ).toThrow("ID");
    expect(() =>
      store.previewProjectConfig(json({ id: "", name: "空 ID" })),
    ).toThrow("project.id");
    expect(() =>
      store.previewProjectConfig(json({ name: "不存在" }), "missing"),
    ).toThrow("项目不存在");
  });

  test("未知字段、无效日期与循环依赖均拒绝，原项目保持不变", () => {
    const before = project(),
      revision = store.revision();
    expect(() =>
      store.previewProjectConfig(json({ name: "bad", logUpdate: true })),
    ).toThrow();
    expect(() =>
      store.previewProjectConfig(json({ name: "bad", unknown: true })),
    ).toThrow();
    const w = workflowSchema.parse({ mode: "novice" });
    w.tasks = [
      workflowTaskSchema.parse({ id: "a", title: "a", dependsOn: ["b"] }),
      workflowTaskSchema.parse({ id: "b", title: "b", dependsOn: ["a"] }),
    ];
    expect(() =>
      store.previewProjectConfig(
        json({ id: "existing", name: "bad", workflow: w }),
      ),
    ).toThrow("循环");
    expect(() =>
      store.previewProjectConfig(
        json({
          name: "bad",
          workflow: {
            mode: "agile",
            milestones: [{ id: "m", title: "m", dueDate: "2026-02-30" }],
          },
        }),
      ),
    ).toThrow("日期");
    expect(project()).toEqual(before);
    expect(store.revision()).toBe(revision);
  });

  test("过期预览拒绝，输入重预览后正常应用", () => {
    const text = json({ id: "existing", name: "更新" });
    const preview = store.previewProjectConfig(text);
    store.saveLog({ body: "另一个窗口的操作", date: store.day() });
    expect(() => store.commitProjectConfig(preview.token)).toThrow(
      "数据已变化",
    );
    expect(project().name).toBe("原项目");
    store.commitProjectConfig(store.previewProjectConfig(text).token);
    expect(project().name).toBe("更新");
  });

  test("已有流程省略时保留，已操作任务和已有确认不被 Agent 覆盖", () => {
    const workflow = workflowSchema.parse({
      mode: "novice",
      goal: "真实目标",
      tasks: [
        workflowTaskSchema.parse({
          id: "started",
          title: "人工已操作",
          state: "doing",
        }),
        workflowTaskSchema.parse({ id: "untouched", title: "可更新" }),
      ],
      decisions: [
        {
          id: "confirmed",
          topic: "人工确认",
          status: "confirmed",
          conclusion: "保留这个结论",
        },
      ],
    });
    store.saveWorkflow("existing", workflow, store.revision());
    store.commitProjectConfig(
      store.previewProjectConfig(json({ id: "existing", name: "只改基本信息" }))
        .token,
    );
    expect(project().workflow!.goal).toBe("真实目标");
    const incoming = parseProjectConfig(store.exportProjectConfig("existing"));
    incoming.project.workflow!.tasks[0].title = "Agent 覆盖";
    incoming.project.workflow!.tasks[1].title = "新计划";
    incoming.project.workflow!.decisions[0].conclusion = "Agent 代确认";
    const preview = store.previewProjectConfig(JSON.stringify(incoming));
    expect(preview.protectedCount).toBe(2);
    store.commitProjectConfig(preview.token);
    expect(project().workflow!.tasks.map((t) => t.title)).toEqual([
      "人工已操作",
      "新计划",
    ]);
    expect(project().workflow!.decisions[0].conclusion).toBe("保留这个结论");
  });

  test("新建项目也不能把 Agent 自报当成人工验收或接收", () => {
    const workflow = workflowSchema.parse({
      mode: "novice",
      milestones: [
        { id: "m", title: "交付", state: "completed", evidence: "Agent 自报" },
      ],
      tasks: [
        workflowTaskSchema.parse({
          id: "t",
          title: "实现",
          milestoneId: "m",
          state: "done",
          acceptance: "能运行",
          evidence: "Agent 声称已通过",
          receiver: "同事",
          handoff: {
            status: "accepted",
            artifacts: "安装包",
            verification: "Agent 声称",
          },
        }),
      ],
      decisions: [
        {
          id: "d",
          topic: "范围",
          status: "confirmed",
          conclusion: "Agent 声称已确认",
        },
      ],
    });
    const preview = store.previewProjectConfig(
      json({ name: "新项目", workflow }),
    );
    const id = store.commitProjectConfig(preview.token);
    const w = store.snapshot().projects.find((p) => p.id === id)!.workflow!;
    expect(w.tasks[0].state).toBe("review");
    expect(w.tasks[0].handoff.status).toBe("submitted");
    expect(w.milestones[0].state).toBe("active");
    expect(w.decisions[0].status).toBe("pending");
    expect(store.snapshot().logs).toHaveLength(0);
  });

  test("导出不混入笔记或流水，导入后保留私人数据", () => {
    store.saveNote({
      title: "私人记事",
      body: "PRIVATE-NOTE",
      projectId: "existing",
    });
    store.saveLog({
      body: "PRIVATE-LOG",
      date: store.day(),
      projectId: "existing",
    });
    const exported = store.exportProjectConfig("existing");
    expect(exported).not.toContain("PRIVATE");
    store.commitProjectConfig(store.previewProjectConfig(exported).token);
    expect(store.snapshot().notes[0].body).toBe("PRIVATE-NOTE");
    expect(store.snapshot().logs[0].body).toBe("PRIVATE-LOG");
  });

  test("数据库写入失败整批回滚，可重新确认原预览", () => {
    const preview = store.previewProjectConfig(
      json({
        id: "existing",
        name: "目标更名",
        workflow: { mode: "agile", goal: "新目标" },
      }),
    );
    const before = project(),
      revision = store.revision();
    store.db.exec(
      "CREATE TRIGGER fail_project_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    expect(() => store.commitProjectConfig(preview.token)).toThrow(
      "test failure",
    );
    expect(project()).toEqual(before);
    expect(store.revision()).toBe(revision);
    store.db.exec("DROP TRIGGER fail_project_update");
    store.commitProjectConfig(preview.token);
    expect(project().name).toBe("目标更名");
    expect(project().workflow!.goal).toBe("新目标");
  });

  test("接受 UTF8 BOM 并拒绝超过 2 MB 的配置", () => {
    expect(
      parseProjectConfig("\uFEFF" + newProjectConfig()).project.name,
    ).toContain("待填写");
    expect(() => parseProjectConfig("中".repeat(700_000))).toThrow("2 MB");
    expect(() => parseProjectConfig("{bad}")).toThrow("有效 JSON");
  });
  test("预览完整展示清空任务依赖，不把字符串数组误作带 ID 的条目", () => {
    const workflow = workflowSchema.parse({
      mode: "novice",
      tasks: [
        workflowTaskSchema.parse({ id: "a", title: "第一项" }),
        workflowTaskSchema.parse({
          id: "b",
          title: "第二项",
          dependsOn: ["a"],
        }),
      ],
    });
    store.saveWorkflow("existing", workflow, store.revision());
    const config = parseProjectConfig(store.exportProjectConfig("existing"));
    config.project.workflow!.tasks[1].dependsOn = [];
    const preview = store.previewProjectConfig(JSON.stringify(config));
    expect(preview.changes).toContainEqual({
      field: "project.workflow.tasks[b].dependsOn",
      before: '["a"]',
      after: "[]",
    });
    expect(
      preview.changes.some((change) => change.field.includes("undefined")),
    ).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/main/store";
import { matches, today, itemSchema } from "../src/shared/contracts";
import type { ItemConfig } from "../src/shared/contracts";

let store: Store, directory: string, now: Date;
function config(patch: Partial<ItemConfig> = {}): ItemConfig {
  return itemSchema.parse({
    id: "ops",
    type: "checklist",
    title: "运维检查",
    checklist: [{ id: "alerts", text: "检查告警" }],
    schedule: {
      frequency: "weekdays",
      start_date: "2026-10-26",
      time: "09:30",
    },
    reminder: { popup: true, snooze_minutes: 10 },
    ...patch,
  });
}
function single(patch: Partial<ItemConfig> = {}): ItemConfig {
  return config({
    id: "once",
    type: "task",
    checklist: [],
    schedule: {
      frequency: "once",
      date: "2026-10-27",
      time: "09:30",
      timezone: "Asia/Shanghai",
    },
    ...patch,
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kanban-test-"));
  now = new Date("2026-10-27T02:00:00Z");
  store = new Store(join(directory, "test.db"), () => now);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("日历与实例", () => {
  test("只生成当天，重复核对与重启不重复，不补离线日期", () => {
    store.saveItem(config());
    store.ensureToday();
    expect(store.runs()).toHaveLength(1);
    now = new Date("2026-10-30T02:00:00Z");
    store.ensureToday();
    expect(store.runs().map((r) => r.date)).toEqual([
      "2026-10-27",
      "2026-10-30",
    ]);
    store.close();
    store = new Store(join(directory, "test.db"), () => now);
    store.ensureToday();
    expect(store.runs()).toHaveLength(2);
  });
  test("周末不生成，周规则与北京时间跨日一致", () => {
    now = new Date("2026-10-31T02:00:00Z");
    store.saveItem(config());
    expect(store.runs()).toHaveLength(0);
    expect(
      matches(
        config({
          schedule: {
            frequency: "weekly",
            start_date: "2026-10-26",
            weekdays: [2],
            time: "09:30",
            timezone: "Asia/Shanghai",
          },
        }),
        "2026-10-27",
      ),
    ).toBe(true);
    expect(today(new Date("2026-10-27T16:00:00Z"))).toBe("2026-10-28");
  });
  test("未来一次性任务生成，过去一次性显示逾期不补弹", () => {
    store.saveItem(
      single({
        schedule: {
          frequency: "once",
          date: "2026-10-29",
          timezone: "Asia/Shanghai",
        },
        reminder: { popup: false, snooze_minutes: 10 },
      }),
    );
    store.saveItem(
      single({
        id: "old",
        schedule: {
          frequency: "once",
          date: "2026-10-20",
          time: "09:30",
          timezone: "Asia/Shanghai",
        },
      }),
    );
    expect(store.runs()).toHaveLength(2);
    expect(store.dueReminders()).toHaveLength(0);
  });
  test("暂停后不提醒，恢复不补暂停日期，历史保留", () => {
    store.saveItem(config());
    store.setMode("ops", true, false);
    expect(store.dueReminders()).toHaveLength(0);
    now = new Date("2026-10-28T02:00:00Z");
    store.ensureToday();
    expect(store.runs()).toHaveLength(1);
    now = new Date("2026-10-29T02:00:00Z");
    store.setMode("ops", false, false);
    expect(store.runs().map((r) => r.date)).toEqual([
      "2026-10-27",
      "2026-10-29",
    ]);
  });
});
describe("更新与历史保护", () => {
  test("未开始记录同步内容和提醒时间", () => {
    store.saveItem(config());
    store.saveItem(
      config({
        title: "新版检查",
        schedule: {
          frequency: "weekdays",
          start_date: "2026-10-26",
          time: "11:00",
          timezone: "Asia/Shanghai",
        },
      }),
    );
    expect(store.runs()[0].config.title).toBe("新版检查");
    expect(store.reminders()[0].dueAt).toBe("2026-10-27T03:00:00.000Z");
  });
  test("勾选后取消仍保护历史；未来实例使用新配置", () => {
    store.saveItem(config());
    const id = store.runs()[0].id;
    store.check(id, "alerts", true);
    store.check(id, "alerts", false);
    store.saveItem(config({ title: "新配置" }));
    expect(store.getRun(id).config.title).toBe("运维检查");
    now = new Date("2026-10-28T02:00:00Z");
    store.ensureToday();
    expect(store.runs()[1].config.title).toBe("新配置");
  });
  test("完成、跳过、手工修改、稍后提醒均受保护", () => {
    for (const [i, action] of [
      "completed",
      "skipped",
      "edit",
      "snooze",
    ].entries()) {
      const c = single({ id: `case-${i}` });
      store.saveItem(c);
      const id = store.runs().find((r) => r.templateId === c.id)!.id;
      if (action === "edit") store.editRun(id, "手工标题", "");
      else if (action === "snooze") store.snooze(id);
      else store.state(id, action as "completed" | "skipped");
      store.saveItem({ ...c, title: "替换标题" });
      expect(store.getRun(id).config.title).not.toBe("替换标题");
    }
  });
  test("修改重复规则撤销未开始实例，再改回可恢复同一实例", () => {
    store.saveItem(config());
    const id = store.runs()[0].id;
    store.saveItem(
      config({
        schedule: {
          frequency: "weekly",
          start_date: "2026-10-26",
          weekdays: [3],
          timezone: "Asia/Shanghai",
        },
        reminder: { popup: false, snooze_minutes: 10 },
      }),
    );
    expect(store.getRun(id).state).toBe("withdrawn");
    expect(store.dueReminders()).toHaveLength(0);
    store.saveItem(config());
    expect(store.runs()).toHaveLength(1);
    expect(store.getRun(id).state).toBe("pending");
  });
  test("历史日期不因改模板改写", () => {
    store.saveItem(config());
    now = new Date("2026-10-28T02:00:00Z");
    store.saveItem(config({ title: "今天的新标题" }));
    expect(store.runs()[0].config.title).toBe("运维检查");
  });
});
describe("提醒持久化", () => {
  test("到点返回，标记显示后重启不重复", () => {
    store.saveItem(config());
    const due = store.dueReminders();
    expect(due).toHaveLength(1);
    store.markShown(due.map((r) => r.id));
    store.close();
    store = new Store(join(directory, "test.db"), () => now);
    expect(store.dueReminders()).toHaveLength(0);
    expect(store.runs()[0].state).toBe("pending");
  });
  test("稍后提醒修改本次，不修改模板，支持跨日", () => {
    now = new Date("2026-10-27T15:55:00Z");
    store.saveItem(config());
    const id = store.runs()[0].id;
    store.snooze(id);
    expect(store.dueReminders()).toHaveLength(0);
    now = new Date("2026-10-27T16:05:00Z");
    expect(store.dueReminders().map((r) => r.id)).toContain(id);
    expect(store.templates()[0].config.schedule.time).toBe("09:30");
  });
  test("关闭不完成，完成与跳过取消，重新打开不补弹", () => {
    store.saveItem(config());
    const id = store.runs()[0].id;
    store.markShown([id]);
    store.dismiss([id]);
    expect(store.getRun(id).state).toBe("pending");
    store.snooze(id);
    store.state(id, "completed");
    expect(store.reminders()[0].status).toBe("cancelled");
    store.state(id, "pending");
    expect(store.dueReminders()).toHaveLength(0);
  });
  test("多条到期同批返回，旧日期提醒被忽略", () => {
    store.saveItem(config());
    store.saveItem(single());
    expect(store.dueReminders()).toHaveLength(2);
    now = new Date("2026-10-28T02:00:00Z");
    store.ensureToday();
    expect(store.dueReminders()).toHaveLength(1);
  });
});
describe("Agent 配置", () => {
  const text = (...items: ItemConfig[]) =>
    JSON.stringify({ schema_version: 1, items });
  test("同 id 幂等，批量更新，导出再导入不增加记录", () => {
    let preview = store.previewImport(text(config(), single()));
    store.commitImport(preview.token);
    expect(store.runs()).toHaveLength(2);
    preview = store.previewImport(store.exportConfig());
    expect(preview.changes.every((c) => c.action === "unchanged")).toBe(true);
    store.commitImport(preview.token);
    expect(store.runs()).toHaveLength(2);
    preview = store.previewImport(text(config({ title: "新标题" })));
    store.commitImport(preview.token);
    expect(store.runs()[0].config.title).toBe("新标题");
  });
  test("未知字段、无效日期、重复 id、无效项目整批拒绝", () => {
    for (const input of [
      text(config(), config()),
      text(config(), single({ project_id: "missing" })),
      text({ ...config(), extra: true } as any),
      text({
        ...single(),
        schedule: {
          frequency: "once",
          date: "2026-02-30",
          time: "09:30",
          timezone: "Asia/Shanghai",
        },
      }),
    ])
      expect(() => store.previewImport(input)).toThrow();
    expect(store.templates()).toHaveLength(0);
  });
  test("预览过期阻止提交，跨日也阻止", () => {
    const p = store.previewImport(text(config()));
    store.saveLog({ body: "修改", date: store.day() });
    expect(() => store.commitImport(p.token)).toThrow("预览已过期");
    const p2 = store.previewImport(text(config()));
    now = new Date("2026-10-28T02:00:00Z");
    expect(() => store.commitImport(p2.token)).toThrow("预览已过期");
  });
  test("可选字段省略清空，预览标明受保护实例", () => {
    store.saveItem(config({ content_markdown: "说明" }));
    store.check(store.runs()[0].id, "alerts", true);
    const value = config();
    delete (value as any).content_markdown;
    const p = store.previewImport(text(value));
    expect(p.changes[0].protectedCount).toBe(1);
    expect(p.changes[0].warnings).toContain("content_markdown 将被清空");
    store.commitImport(p.token);
    expect(store.templates()[0].config.content_markdown).toBe("");
    expect(store.runs()[0].config.content_markdown).toBe("说明");
  });
  test("数据库提交失败整批回滚", () => {
    store.db.exec(
      "CREATE TRIGGER fail_test BEFORE INSERT ON templates WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    const p = store.previewImport(text(config(), single({ id: "bad" })));
    expect(() => store.commitImport(p.token)).toThrow();
    expect(store.templates()).toHaveLength(0);
    store.db.exec("DROP TRIGGER fail_test");
  });
});
describe("记录与汇报", () => {
  test("完成结果合并一次，笔记和跳过记录不默认进入", () => {
    store.saveItem(config());
    store.state(store.runs()[0].id, "completed", "处理了测试环境告警");
    store.saveNote({ title: "私人内容", body: "不能自动导出" });
    store.saveItem(single());
    store.state(store.runs()[1].id, "skipped");
    const report = store.report({
      from: "2026-10-27",
      to: "2026-10-27",
      includePending: false,
    });
    expect(report).toHaveLength(1);
    expect(report[0].body).toContain("处理了测试环境告警");
    expect(store.reportMarkdown(report, "date")).not.toContain("私人内容");
  });
  test("归属日期与创建时间独立，日期首尾包含", () => {
    store.saveLog({ body: "补记昨天", date: "2026-10-26" });
    const log = store.snapshot().logs[0];
    expect(today(new Date(log.createdAt))).toBe("2026-10-27");
    expect(
      store.report({
        from: "2026-10-26",
        to: "2026-10-26",
        includePending: false,
      }),
    ).toHaveLength(1);
  });
  test("删除处理流水不改变完成记录，项目归档保留关联", () => {
    store.saveProject({ id: "p", name: "项目", progress: 40 });
    store.saveItem(single({ project_id: "p" }));
    store.state(store.runs()[0].id, "completed", "结果");
    store.deleteLog(store.snapshot().logs[0].id);
    expect(store.runs()[0].state).toBe("completed");
    store.saveProject({ ...store.snapshot().projects[0], archived: true });
    expect(store.runs()[0].config.project_id).toBe("p");
  });
  test("待跟进素材不会被写成已完成，重复确认完成不重复记录结果", () => {
    store.saveItem(single());
    const id = store.runs()[0].id;
    const text = store.reportMarkdown(
      store.report({
        from: store.day(),
        to: store.day(),
        includePending: true,
      }),
      "date",
    );
    expect(text).toContain("待跟进");
    expect(text).not.toContain("已记录完成");
    store.state(id, "completed", "结果");
    store.state(id, "completed", "结果");
    expect(store.snapshot().logs).toHaveLength(1);
  });
});
describe("备份与恢复", () => {
  test("完整快照恢复，先备份当前数据，下一次打开可读取", async () => {
    store.saveProject({ id: "p", name: "项目" });
    store.saveNote({ title: "笔记", body: "内容", projectId: "p" });
    store.saveItem(config({ project_id: "p" }));
    store.state(store.runs()[0].id, "completed", "完成结果");
    const path = join(directory, "export.kanban-backup");
    await store.createBackup(path);
    store.saveLog({ body: "恢复前新增", date: store.day() });
    const p = store.previewBackup(path);
    expect(p.counts.logs).toBe(1);
    await store.restoreBackup(p.token);
    expect(store.snapshot().logs).toHaveLength(1);
    expect(readdirSync(join(directory, "backups"))).toHaveLength(1);
    store.close();
    store = new Store(join(directory, "test.db"), () => now);
    expect(store.runs()[0].state).toBe("completed");
  });
  test("损坏文件拒绝且当前数据不变", () => {
    store.saveLog({ body: "保留我", date: store.day() });
    const bad = join(directory, "bad.kanban-backup");
    writeFileSync(bad, "bad database");
    expect(() => store.previewBackup(bad)).toThrow();
    expect(store.snapshot().logs[0].body).toBe("保留我");
  });
  test("备份不得覆盖当前数据库，提醒状态损坏时拒绝恢复", async () => {
    await expect(store.createBackup(store.path)).rejects.toThrow("不能覆盖");
    store.saveItem(config());
    const file = join(directory, "malformed.kanban-backup");
    await store.createBackup(file);
    const db = new DatabaseSync(file);
    db.exec("UPDATE reminders SET status='broken'");
    db.close();
    expect(() => store.previewBackup(file)).toThrow();
    expect(store.runs()).toHaveLength(1);
  });
  test("预览后文件变化拒绝恢复", async () => {
    const path = join(directory, "export.kanban-backup");
    await store.createBackup(path);
    const p = store.previewBackup(path);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value='42' WHERE key='revision'").run();
    db.close();
    await expect(store.restoreBackup(p.token)).rejects.toThrow(
      "备份文件已变化",
    );
  });
  test("恢复插入失败时回滚当前数据", async () => {
    store.saveItem(config());
    const path = join(directory, "export.kanban-backup");
    await store.createBackup(path);
    store.saveLog({ body: "保留当前", date: store.day() });
    const p = store.previewBackup(path);
    store.db.exec(
      "CREATE TRIGGER fail_restore BEFORE INSERT ON templates BEGIN SELECT RAISE(ABORT,'restore failure'); END;",
    );
    await expect(store.restoreBackup(p.token)).rejects.toThrow();
    expect(store.snapshot().logs[0].body).toBe("保留当前");
    store.db.exec("DROP TRIGGER fail_restore");
  });
});

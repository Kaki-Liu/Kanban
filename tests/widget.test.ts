import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { itemSchema, type ItemConfig } from "../src/shared/contracts";
import { clampWidgetBounds } from "../src/shared/widget";

let directory: string, store: Store, now: Date;
function item(id = "daily", patch: Partial<ItemConfig> = {}): ItemConfig {
  return itemSchema.parse({
    id,
    title: id,
    type: "checklist",
    checklist: [{ id: "service", text: "检查服务" }],
    schedule: { frequency: "daily", start_date: "2026-11-03", time: "09:30" },
    reminder: { popup: true, snooze_minutes: 10 },
    ...patch,
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kanban-widget-"));
  now = new Date("2026-11-03T01:00:00Z");
  store = new Store(join(directory, "test.db"), () => now);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("便签只读今日待处理检查，不暴露普通笔记；勾选使用现有记录", () => {
  store.saveItem(item());
  store.saveItem(
    item("no-popup", { reminder: { popup: false, snooze_minutes: 10 } }),
  );
  store.saveItem(item("ordinary", { type: "task", checklist: [] }));
  store.saveNote({ title: "私人笔记", body: "private" });
  const visible = store.widgetSnapshot();
  expect(visible.checklists.map((r) => r.templateId).sort()).toEqual([
    "daily",
    "no-popup",
  ]);
  expect(visible).not.toHaveProperty("notes");
  store.check(visible.checklists[0].id, "service", true);
  expect(store.widgetSnapshot().checklists[0].checks.service).toBe(true);
  store.setMode("daily", true, false);
  expect(store.widgetSnapshot().checklists.map((r) => r.templateId)).toEqual([
    "no-popup",
  ]);
  const remaining = store.widgetSnapshot().checklists[0];
  store.check(remaining.id, "service", true);
  store.state(remaining.id, "completed");
  expect(store.widgetSnapshot().checklists).toEqual([]);
});

test("提醒按实际时间取最近两条，预测周期记录不创建未来实例", () => {
  store.saveItem(item());
  store.saveItem(
    item("later", {
      schedule: {
        frequency: "daily",
        start_date: "2026-11-03",
        time: "10:00",
        timezone: "Asia/Shanghai",
      },
    }),
  );
  const before = store.runs().length;
  const first = store.widgetSnapshot().upcoming;
  expect(first.map((r) => r.title)).toEqual(["daily", "later"]);
  expect(first.every((r) => r.runId)).toBe(true);
  now = new Date("2026-11-03T02:30:00Z");
  store.markShown(store.runs().map((r) => r.id));
  store.dismiss(store.runs().map((r) => r.id));
  const projected = store.widgetSnapshot().upcoming;
  expect(projected.map((r) => r.dueAt)).toEqual([
    "2026-11-04T01:30:00.000Z",
    "2026-11-04T02:00:00.000Z",
  ]);
  expect(projected.every((r) => !r.runId)).toBe(true);
  expect(store.runs()).toHaveLength(before);
});

test("周末、指定星期、未来启用日期和一次性提醒均按北京时间预测", () => {
  now = new Date("2026-11-07T01:00:00Z"); // Saturday
  store.saveItem(
    item("weekdays", {
      schedule: {
        frequency: "weekdays",
        start_date: "2026-11-03",
        time: "09:30",
        timezone: "Asia/Shanghai",
      },
    }),
  );
  store.saveItem(
    item("sunday", {
      schedule: {
        frequency: "weekly",
        start_date: "2026-11-03",
        weekdays: [7],
        time: "10:00",
        timezone: "Asia/Shanghai",
      },
    }),
  );
  expect(
    store.widgetSnapshot().upcoming.map((r) => [r.title, r.dueAt]),
  ).toEqual([
    ["sunday", "2026-11-08T02:00:00.000Z"],
    ["weekdays", "2026-11-09T01:30:00.000Z"],
  ]);
  expect(store.runs()).toHaveLength(0);
  store.setMode("weekdays", true, false);
  store.setMode("sunday", false, true);
  store.saveItem(
    item("future", {
      schedule: {
        frequency: "daily",
        start_date: "2026-12-01",
        time: "09:30",
        timezone: "Asia/Shanghai",
      },
    }),
  );
  store.saveItem(
    item("once", {
      schedule: {
        frequency: "once",
        date: "2026-11-09",
        time: "08:00",
        timezone: "Asia/Shanghai",
      },
    }),
  );
  expect(
    store.widgetSnapshot().upcoming.map((r) => [r.title, r.dueAt]),
  ).toEqual([
    ["once", "2026-11-09T00:00:00.000Z"],
    ["future", "2026-12-01T01:30:00.000Z"],
  ]);
});

test("跨日稍后使用持久化时间，不恢复原时间；旧日漏提醒不混入", () => {
  now = new Date("2026-11-03T15:55:00Z");
  store.saveItem(item());
  const old = store.runs()[0];
  store.snooze(old.id);
  now = new Date("2026-11-03T16:01:00Z");
  const snapshot = store.widgetSnapshot();
  expect(snapshot.today).toBe("2026-11-04");
  expect(snapshot.upcoming[0]).toMatchObject({
    runId: old.id,
    dueAt: "2026-11-03T16:05:00.000Z",
  });
  expect(snapshot.checklists.every((r) => r.date === "2026-11-04")).toBe(true);
  store.markShown([old.id]);
  store.dismiss([old.id]);
  expect(store.widgetSnapshot().upcoming.some((r) => r.runId === old.id)).toBe(
    false,
  );
});

test("已完成、暂停、取消和历史未发提醒不再出现；不会补造历史记录", () => {
  store.saveItem(
    item("old", {
      schedule: {
        frequency: "once",
        date: "2026-11-02",
        time: "09:30",
        timezone: "Asia/Shanghai",
      },
    }),
  );
  store.saveItem(item("cancelled"));
  store.setMode("cancelled", true, false);
  expect(store.widgetSnapshot().upcoming).toEqual([]);
  store.saveItem(item("finished"));
  const run = store.runs().find((r) => r.templateId === "finished")!;
  store.check(run.id, "service", true);
  store.state(run.id, "completed");
  expect(store.widgetSnapshot().upcoming[0].dueAt).toBe(
    "2026-11-04T01:30:00.000Z",
  );
  now = new Date("2026-11-10T01:00:00Z");
  store.widgetSnapshot();
  expect(
    store
      .runs()
      .filter((r) => r.templateId === "finished")
      .map((r) => r.date),
  ).toEqual(["2026-11-03", "2026-11-10"]);
});

test("便签设置独立持久化且不使导入预览过期，旧数据使用安全默认值", () => {
  expect(store.widgetPreferences()).toEqual({ visible: false, pinned: true });
  const preview = store.previewImport(
    JSON.stringify({ schema_version: 1, items: [item()] }),
  );
  const revision = store.revision();
  const prefs = {
    visible: true,
    pinned: false,
    bounds: { x: -1900, y: 100, width: 320, height: 430 },
  };
  store.saveWidgetPreferences(prefs);
  expect(store.revision()).toBe(revision);
  store.commitImport(preview.token);
  store.close();
  store = new Store(join(directory, "test.db"), () => now);
  expect(store.widgetPreferences()).toEqual(prefs);
});

test("位置恢复覆盖负坐标屏幕、移除屏幕、小工作区和旧尺寸升级", () => {
  const bounds = { x: -1900, y: 80, width: 380, height: 560 };
  expect(
    clampWidgetBounds(bounds, { x: -1920, y: 0, width: 1920, height: 1040 }),
  ).toEqual(bounds);
  const restored = clampWidgetBounds(bounds, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1040,
  });
  expect(restored.x).toBe(0);
  expect(
    clampWidgetBounds(undefined, { x: 0, y: 0, width: 1920, height: 1040 }),
  ).toMatchObject({ width: 380, height: 560 });
  expect(
    clampWidgetBounds(
      { ...bounds, width: 320, height: 300 },
      { x: -1920, y: 0, width: 1920, height: 1040 },
    ),
  ).toMatchObject({ width: 340, height: 420 });
  expect(
    clampWidgetBounds(
      { ...bounds, width: 560, height: 900 },
      { x: -1920, y: 0, width: 1920, height: 1040 },
    ),
  ).toMatchObject({ width: 560, height: 900 });
  expect(
    clampWidgetBounds(undefined, { x: 0, y: 0, width: 250, height: 240 }),
  ).toEqual({ x: 0, y: 0, width: 250, height: 240 });
});

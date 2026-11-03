import { expect, test } from "vitest";
import {
  itemSchema,
  type ItemConfig,
  type Run,
  type Template,
  type WorkLog,
} from "../src/shared/contracts";
import {
  adjacentMonth,
  buildCalendarDays,
  calendarConfig,
  calendarMonth,
} from "../src/shared/calendar";

function template(
  id: string,
  schedule: ItemConfig["schedule"],
  overrides: Partial<Template> = {},
): Template {
  return {
    id,
    config: itemSchema.parse({ id, title: id, type: "task", schedule }),
    paused: false,
    archived: false,
    noteId: null,
    ...overrides,
  };
}
function run(
  template: Template,
  date: string,
  state: Run["state"] = "pending",
): Run {
  return {
    id: `${template.id}:${date}`,
    templateId: template.id,
    date,
    config: template.config,
    state,
    checks: {},
    startedAt: null,
    completedAt: null,
    changedAt: `${date}T01:00:00Z`,
    manual: false,
    skipReason: "",
  };
}

test("月历按周一开始、周日结束，跨年与闰年不偏移", () => {
  const february = calendarMonth("2024-02");
  expect(february[0]).toBe("2024-01-29");
  expect(february.at(-1)).toBe("2024-03-03");
  expect(february).toContain("2024-02-29");
  expect(february).toHaveLength(35);
  expect(calendarMonth("2026-11")[0]).toBe("2026-10-26");
  expect(calendarMonth("2026-11").at(-1)).toBe("2026-12-06");
  expect(adjacentMonth("2026-12", 1)).toBe("2027-01");
  expect(adjacentMonth("2026-01", -1)).toBe("2025-12");
});

test("保留已暂停项目的历史，撤销实例不重投影；仅今天及未来预览计划", () => {
  const daily = template("daily", {
    frequency: "daily",
    start_date: "2026-10-01",
    timezone: "Asia/Shanghai",
  });
  const paused = template("paused", daily.config.schedule, { paused: true });
  const archived = template("archived", daily.config.schedule, {
    archived: true,
  });
  const data = {
    today: "2026-11-03",
    templates: [daily, paused, archived],
    runs: [
      run(paused, "2026-11-02", "completed"),
      run(daily, "2026-11-03", "withdrawn"),
      run(daily, "2026-11-04"),
    ],
    logs: [],
  };
  const original = JSON.stringify(data);
  const days = buildCalendarDays(data, [
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
  ]);
  expect(days[0].items).toEqual([]);
  expect(days[1].items.map((item) => calendarConfig(item).id)).toEqual([
    "paused",
  ]);
  expect(days[1].items[0].kind).toBe("actual");
  expect(days[2].items).toEqual([]);
  expect(days[3].items).toHaveLength(1);
  expect(days[3].items[0].kind).toBe("actual");
  expect(
    days[4].items.map((item) => [item.kind, calendarConfig(item).id]),
  ).toEqual([["planned", "daily"]]);
  expect(JSON.stringify(data)).toBe(original);
});

test("预览遵守指定星期与起始日，记录按归属日期而非实际创建日分组", () => {
  const future = template("future", {
    frequency: "daily",
    start_date: "2026-11-10",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  const weekly = template("weekly", {
    frequency: "weekly",
    start_date: "2026-11-01",
    weekdays: [7],
    time: "10:00",
    timezone: "Asia/Shanghai",
  });
  const once = template("once", {
    frequency: "once",
    date: "2026-11-08",
    time: "08:00",
    timezone: "Asia/Shanghai",
  });
  const log: WorkLog = {
    id: "log",
    body: "补记周六的工作",
    date: "2026-11-07",
    createdAt: "2026-11-10T01:00:00Z",
    updatedAt: "2026-11-10T01:00:00Z",
    projectId: null,
    runId: null,
  };
  const days = buildCalendarDays(
    {
      today: "2026-11-03",
      templates: [future, weekly, once],
      runs: [],
      logs: [log],
    },
    ["2026-11-07", "2026-11-08", "2026-11-10"],
  );
  expect(days[0].items).toEqual([]);
  expect(days[0].logs).toEqual([log]);
  expect(days[1].items.map((item) => calendarConfig(item).id)).toEqual([
    "once",
    "weekly",
  ]);
  expect(days[2].items.map((item) => calendarConfig(item).id)).toEqual([
    "future",
  ]);
  expect(days[2].logs).toEqual([]);
});

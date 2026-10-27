import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { importSchema, today } from "../src/shared/contracts";
mkdirSync("examples", { recursive: true });
writeFileSync(
  "examples/kanban.schema.json",
  JSON.stringify(
    z.toJSONSchema(importSchema, { target: "draft-7", io: "input" }),
    null,
    2,
  ) + "\n",
  "utf8",
);
const sample = {
  schema_version: 1,
  items: [
    {
      id: "daily-ops-check",
      type: "checklist",
      title: "检查运维状态",
      content_markdown: "如有异常，记录现象、处理过程和下一步。",
      checklist: [
        { id: "alerts", text: "查看告警" },
        { id: "services", text: "检查服务状态" },
        { id: "result", text: "记录异常与处理结果" },
      ],
      schedule: {
        frequency: "weekdays",
        start_date: today(),
        time: "09:30",
        timezone: "Asia/Shanghai",
      },
      reminder: { popup: true, snooze_minutes: 10 },
    },
    {
      id: "weekly-review",
      type: "task",
      title: "整理本周工作汇报素材",
      schedule: {
        frequency: "weekly",
        start_date: today(),
        weekdays: [5],
        time: "17:00",
        timezone: "Asia/Shanghai",
      },
      reminder: { popup: true, snooze_minutes: 10 },
    },
  ],
};
importSchema.parse(sample);
writeFileSync(
  "examples/weekly-routine.json",
  JSON.stringify(sample, null, 2) + "\n",
  "utf8",
);

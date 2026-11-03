import React, { useMemo, useState } from "react";
import type { ItemConfig, Snapshot, WorkLog } from "../../shared/contracts";
import {
  adjacentMonth,
  buildCalendarDays,
  calendarConfig,
  calendarMonth,
} from "../../shared/calendar";
import "./calendar.css";

const stateNames = {
  pending: "待处理",
  doing: "进行中",
  completed: "已完成",
  skipped: "已跳过",
  withdrawn: "已撤销",
};
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
const recordTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export function CalendarPage({
  data,
  onBack,
  onOpenRun,
  onEditTemplate,
  onEditLog,
  onNewItem,
  onNewLog,
}: {
  data: Snapshot;
  onBack: () => void;
  onOpenRun: (id: string) => void;
  onEditTemplate: (config: ItemConfig) => void;
  onEditLog: (log: WorkLog) => void;
  onNewItem: (date: string) => void;
  onNewLog: (date: string) => void;
}) {
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const [selected, setSelected] = useState(data.today);
  const dates = useMemo(() => calendarMonth(month), [month]);
  const days = useMemo(() => buildCalendarDays(data, dates), [data, dates]);
  const current = days.find((day) => day.date === selected);
  const projects = useMemo(
    () => new Map(data.projects.map((p) => [p.id, p.name])),
    [data.projects],
  );
  const selectDate = (date: string) => {
    setSelected(date);
    setMonth(date.slice(0, 7));
  };
  const selectMonth = (value: string) => {
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) ||
      value < "1900-01" ||
      value > "9999-12"
    )
      return;
    setMonth(value);
    setSelected(value === data.today.slice(0, 7) ? data.today : `${value}-01`);
  };
  return (
    <div className="page calendar-page">
      <header className="page-heading">
        <div>
          <button className="text-button" onClick={onBack}>
            ← 返回今天
          </button>
          <h1>日历回顾</h1>
          <p className="meta">按日期查看事项、回顾记录，也为下一步留好安排。</p>
        </div>
        <button onClick={() => selectDate(data.today)}>回到今天</button>
      </header>
      <div className="calendar-layout">
        <section className="calendar-month" aria-label="月历">
          <div className="calendar-toolbar">
            <button
              aria-label="上个月"
              disabled={month <= "1900-01"}
              onClick={() => selectMonth(adjacentMonth(month, -1))}
            >
              ‹
            </button>
            <input
              aria-label="查看月份"
              type="month"
              min="1900-01"
              max="9999-12"
              value={month}
              onChange={(e) => selectMonth(e.target.value)}
            />
            <button
              aria-label="下个月"
              disabled={month >= "9999-12"}
              onClick={() => selectMonth(adjacentMonth(month, 1))}
            >
              ›
            </button>
          </div>
          <div className="calendar-weekdays" aria-hidden="true">
            {weekdays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid" key={month}>
            {days.map((day) => {
              const actual = day.items.filter(
                (item) => item.kind === "actual",
              ).length;
              const planned = day.items.length - actual;
              return (
                <button
                  key={day.date}
                  className={`calendar-day${day.date.slice(0, 7) !== month ? " outside-month" : ""}${day.date === data.today ? " is-today" : ""}`}
                  aria-label={day.date}
                  aria-pressed={day.date === selected}
                  aria-current={day.date === data.today ? "date" : undefined}
                  onClick={() => selectDate(day.date)}
                >
                  <strong>
                    {Number(day.date.slice(-2))}
                    <span>{day.date === data.today ? "今" : ""}</span>
                  </strong>
                  <span className="calendar-cell-titles">
                    {day.items.slice(0, 2).map((item) => {
                      const config = calendarConfig(item);
                      return (
                        <span
                          key={item.kind === "actual" ? item.run.id : config.id}
                          className={
                            item.kind === "planned" ? "planned" : item.run.state
                          }
                        >
                          {config.title}
                        </span>
                      );
                    })}
                  </span>
                  <small>
                    {actual ? `${actual} 事项` : ""}
                    {planned ? `${actual ? " · " : ""}${planned} 计划` : ""}
                    {day.logs.length
                      ? `${day.items.length ? " · " : ""}${day.logs.length} 记录`
                      : ""}
                  </small>
                </button>
              );
            })}
          </div>
          <p className="calendar-legend">
            <span>● 已有事项</span>
            <span>○ 计划预览</span>
            <span>记录按归属日期显示</span>
          </p>
        </section>
        <aside className="calendar-agenda" aria-label="所选日期详情">
          <header className="calendar-date-heading">
            <span className="eyebrow">{selected}</span>
            <h2>{dayLabel(selected)}</h2>
          </header>
          <div className="calendar-day-content" key={selected}>
            <section aria-label="当天事项">
              <div className="section-heading">
                <h3>
                  当天事项 <small>{current?.items.length || 0}</small>
                </h3>
                <button className="small" onClick={() => onNewItem(selected)}>
                  ＋ 新增事项
                </button>
              </div>
              {!current?.items.length && (
                <p className="calendar-empty">
                  {selected < data.today
                    ? "当天没有事项记录。"
                    : "当天还没有安排。"}
                </p>
              )}
              {current?.items.map((item) => {
                const config = calendarConfig(item);
                const run = item.kind === "actual" ? item.run : undefined;
                const project = config.project_id
                  ? projects.get(config.project_id)
                  : undefined;
                return (
                  <button
                    key={run?.id || `planned:${config.id}`}
                    className={`calendar-agenda-item${run ? "" : " is-planned"}`}
                    onClick={() =>
                      run ? onOpenRun(run.id) : onEditTemplate(config)
                    }
                  >
                    <span className="calendar-item-heading">
                      <strong>{config.title}</strong>
                      <span className={`badge ${run?.state || "planned"}`}>
                        {run ? stateNames[run.state] : "计划"}
                      </span>
                    </span>
                    <small>
                      {config.schedule.time || "未设时间"} ·{" "}
                      {config.type === "checklist" ? "检查清单" : "待办事项"}
                      {project ? ` · ${project}` : ""}
                    </small>
                    {run && config.checklist.length > 0 && (
                      <small>
                        检查子项：
                        {
                          config.checklist.filter((c) => run.checks[c.id])
                            .length
                        }
                        /{config.checklist.length}
                      </small>
                    )}
                    {run?.completedAt && (
                      <small>完成于 {recordTime(run.completedAt)}</small>
                    )}
                    {run?.skipReason && (
                      <small>跳过说明：{run.skipReason}</small>
                    )}
                    {run &&
                      selected < data.today &&
                      ["pending", "doing"].includes(run.state) && (
                        <small className="warning-text">
                          仍未完成，可打开继续处理
                        </small>
                      )}
                    {!run && <small>按当前配置预览 · 点击修改计划</small>}
                  </button>
                );
              })}
              {current?.items.some((item) => item.kind === "planned") && (
                <p className="calendar-plan-note">
                  计划只是预览，尚未生成执行记录；周期事项仅在当天生成。
                </p>
              )}
            </section>
            <section aria-label="工作记录" className="calendar-logs">
              <div className="section-heading">
                <h3>
                  工作记录 <small>{current?.logs.length || 0}</small>
                </h3>
                <button className="small" onClick={() => onNewLog(selected)}>
                  ＋ 补记工作
                </button>
              </div>
              {!current?.logs.length && (
                <p className="calendar-empty">
                  没有这一天的工作记录，可以随时补记。
                </p>
              )}
              {current?.logs.map((log) => (
                <button
                  key={log.id}
                  className="calendar-log"
                  onClick={() => onEditLog(log)}
                >
                  <span>{log.body}</span>
                  <small>
                    {log.projectId && projects.get(log.projectId)
                      ? `${projects.get(log.projectId)} · `
                      : ""}
                    记录于 {recordTime(log.createdAt)}
                  </small>
                </button>
              ))}
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}

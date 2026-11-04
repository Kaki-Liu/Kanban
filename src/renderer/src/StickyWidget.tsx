import { useEffect, useRef, useState } from "react";
import type { WidgetSnapshot } from "../../shared/contracts";
import { today } from "../../shared/time";
import "./widget.css";
import { CompletionCelebration } from "./CompletionCelebration";

const api = window.kanban;
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function reminderTime(dueAt: string, day: string): string {
  const date = new Date(dueAt);
  const datePart = today(date);
  const time = timeFormat.format(date);
  if (datePart === day) return `今天 ${time}`;
  return `${datePart.slice(5).replace("-", "/")} ${time}`;
}

export function StickyWidget() {
  const [data, setData] = useState<WidgetSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingCheck, setPendingCheck] = useState<{
    runId: string;
    key: string;
    checked: boolean;
  } | null>(null);
  const operation = useRef(false);
  const request = useRef(0);

  async function load(clearError = false) {
    const current = ++request.current;
    try {
      const next = await api.widget.get();
      if (current === request.current) {
        setData(next);
        if (clearError) setError("");
      }
    } catch (e) {
      if (current === request.current)
        setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    const unsubscribe = api.onChange(() => void load());
    const refresh = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      ++request.current;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  async function act(fn: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  function isChecked(runId: string, key: string, saved: boolean) {
    return pendingCheck?.runId === runId && pendingCheck.key === key
      ? pendingCheck.checked
      : saved;
  }

  function check(runId: string, key: string, checked: boolean) {
    if (operation.current) return;
    // Keep the click responsive while IPC saves; failed writes restore the saved value.
    setPendingCheck({ runId, key, checked });
    void act(() => api.items.check(runId, key, checked)).finally(() =>
      setPendingCheck(null),
    );
  }

  const total =
    data?.checklists.reduce(
      (sum, run) => sum + run.config.checklist.length,
      0,
    ) || 0;
  const checked =
    data?.checklists.reduce(
      (sum, run) =>
        sum +
        run.config.checklist.filter((item) =>
          isChecked(run.id, item.id, Boolean(run.checks[item.id])),
        ).length,
      0,
    ) || 0;

  return (
    <div className="sticky-widget">
      <header className="sticky-titlebar" title="拖动这里移动便签">
        <span className="sticky-grip" aria-hidden="true">
          ⠿
        </span>
        <strong>今日便签</strong>
        <div className="sticky-window-actions">
          <button
            type="button"
            className={data?.pinned ? "is-pinned" : ""}
            aria-label={data?.pinned ? "取消置顶" : "置顶便签"}
            aria-pressed={data?.pinned ?? true}
            title={data?.pinned ? "已置顶，点击取消" : "置顶便签"}
            disabled={busy || !data}
            onClick={() => void act(() => api.widget.setPinned(!data?.pinned))}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="隐藏便签"
            title="隐藏便签，可从托盘重新打开"
            disabled={busy}
            onClick={() => void act(() => api.widget.hide())}
          >
            ×
          </button>
        </div>
      </header>

      {error && (
        <div className="sticky-error" role="alert">
          <span>{error}</span>
          <button onClick={() => void load(true)}>重试</button>
        </div>
      )}

      <section className="sticky-checks" aria-label="今日检查">
        <div className="sticky-section-heading">
          <h1>今日检查</h1>
          <span>{data ? `${checked} / ${total}` : "…"}</span>
        </div>
        <div className="sticky-scroll">
          {!data ? (
            <p className="sticky-empty">正在加载…</p>
          ) : !data.checklists.length ? (
            <div className="sticky-empty">
              <span className="sticky-empty-mark" aria-hidden="true">
                ✓
              </span>
              <p>暂时没有待处理的检查</p>
              <small>在看板创建 checklist，这里就会显示。</small>
            </div>
          ) : (
            data.checklists.map((run) => {
              const complete = run.config.checklist.every((item) =>
                isChecked(run.id, item.id, Boolean(run.checks[item.id])),
              );
              return (
                <article className="sticky-check-group" key={run.id}>
                  <button
                    className="sticky-run-title"
                    title="打开事项详情"
                    disabled={busy}
                    onClick={() => void act(() => api.widget.openMain(run.id))}
                  >
                    <strong>{run.config.title}</strong>
                    <span aria-hidden="true">↗</span>
                  </button>
                  {run.config.checklist.map((item) => (
                    <label
                      className={`sticky-check ${isChecked(run.id, item.id, Boolean(run.checks[item.id])) ? "is-checked" : ""}`}
                      key={item.id}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked(
                          run.id,
                          item.id,
                          Boolean(run.checks[item.id]),
                        )}
                        disabled={busy}
                        onChange={(e) =>
                          check(run.id, item.id, e.target.checked)
                        }
                      />
                      <span>{item.text}</span>
                    </label>
                  ))}
                  {complete && (
                    <div className="sticky-complete-actions">
                    <button
                      className="sticky-confirm"
                      disabled={busy}
                      onClick={() => void act(() => api.widget.complete(run.id))}
                    >
                      完成检查
                    </button>
                    <button
                      className="sticky-confirm"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.widget.openMain(run.id))
                      }
                    >
                      填写结果 ↗
                    </button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>

      <section className="sticky-upcoming" aria-label="接下来">
        <div className="sticky-section-heading">
          <h2>接下来</h2>
          <span>最近两条提醒</span>
        </div>
        {data?.upcoming.length ? (
          data.upcoming.map((reminder) => (
            <button
              className="sticky-reminder"
              key={reminder.id}
              disabled={busy}
              onClick={() =>
                void act(() => api.widget.openMain(reminder.runId))
              }
              title={reminder.runId ? "打开提醒事项" : "打开看板"}
            >
              <span className="sticky-reminder-dot" aria-hidden="true" />
              <span className="sticky-reminder-content">
                <strong>{reminder.title}</strong>
                <time dateTime={reminder.dueAt}>
                  {reminderTime(reminder.dueAt, data.today)}
                </time>
              </span>
            </button>
          ))
        ) : (
          <p className="sticky-no-reminders">暂无即将到来的提醒</p>
        )}
      </section>

      <footer className="sticky-footer">
        <span>
          {data?.today.slice(5).replace("-", "/")} ·{" "}
          {data?.pinned ? "已置顶" : "未置顶"}
        </span>
        <button
          disabled={busy}
          onClick={() => void act(() => api.widget.openMain())}
        >
          打开看板 ↗
        </button>
      </footer>
      <CompletionCelebration compact />
    </div>
  );
}

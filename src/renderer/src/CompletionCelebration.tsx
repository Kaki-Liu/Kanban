import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./celebration.css";

const colors = ["#ed8c91", "#efc864", "#7cbdaa", "#85a5e8", "#b69bd8"];
const storageKey = "kanban:last-celebration-day";

export function CompletionCelebration({ compact = false }: { compact?: boolean }) {
  const [day, setDay] = useState("");
  const lastDay = useRef("");

  useEffect(() => window.kanban.onCelebrate((completedDay) => {
    if (lastDay.current === completedDay) return;
    try {
      if (localStorage.getItem(storageKey) === completedDay) return;
      localStorage.setItem(storageKey, completedDay);
    } catch {
      // Optional feedback still works for this session if display preferences cannot be stored.
    }
    lastDay.current = completedDay;
    setDay(completedDay);
  }), []);

  useEffect(() => {
    if (!day) return;
    const timeout = setTimeout(() => setDay(""), 3500);
    return () => clearTimeout(timeout);
  }, [day]);

  if (!day) return null;
  return (
    <div className={`completion-celebration${compact ? " is-compact" : ""}`}>
      <div className="completion-confetti" aria-hidden="true">
        {Array.from({ length: compact ? 30 : 64 }, (_, index) => (
          <i key={index} style={{
            "--x": `${(index * 37) % 100}%`,
            "--drift": `${((index * 19) % 180) - 90}px`,
            "--spin": `${180 + (index % 5) * 180}deg`,
            "--delay": `${(index % 8) * 55}ms`,
            backgroundColor: colors[index % colors.length],
          } as CSSProperties} />
        ))}
      </div>
      <p className="completion-message" role="status">🎉 今日任务全部完成</p>
    </div>
  );
}

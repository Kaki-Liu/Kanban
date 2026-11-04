import type { Project, Run } from "./contracts";
import { nextActions } from "./workflow-templates";

export function projectOverview(project: Project, runs: Run[]) {
  if (project.workflow) {
    const { tasks, milestones } = project.workflow;
    const completedMilestones = milestones.filter((m) => m.state === "completed").length;
    const blocked = tasks.filter((task) => task.state !== "done" && (
      task.blocker || task.dependsOn.some((id) => tasks.find((t) => t.id === id)?.state !== "done")
    ));
    const next = nextActions(project.workflow)[0] || blocked[0];
    return {
      progress: Math.round(100 * completedMilestones / Math.max(1, milestones.length)),
      progressLabel: `${completedMilestones}/${milestones.length} 个里程碑已验收`,
      total: tasks.length,
      done: tasks.filter((t) => t.state === "done").length,
      doing: tasks.filter((t) => t.state === "doing").length,
      review: tasks.filter((t) => t.state === "review").length,
      blocked: blocked.length,
      next: next ? { id: next.id, title: next.title, workflow: true } : null,
    };
  }
  const tasks = runs.filter((r) => r.config.project_id === project.id && r.config.type === "task" && r.state !== "withdrawn");
  const next = [...tasks].filter((r) => r.state === "pending" || r.state === "doing")
    .sort((a, b) => Number(b.state === "doing") - Number(a.state === "doing") || a.date.localeCompare(b.date))[0];
  return {
    progress: project.progress,
    progressLabel: `项目进度 ${project.progress}%`,
    total: tasks.length,
    done: tasks.filter((r) => r.state === "completed").length,
    doing: tasks.filter((r) => r.state === "doing").length,
    review: 0,
    blocked: 0,
    next: next ? { id: next.id, title: next.config.title, workflow: false } : null,
  };
}

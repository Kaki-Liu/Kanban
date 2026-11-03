import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DesktopAPI } from "../../shared/contracts";

const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  invoke<T>("kb_call", { channel, args: args.map((v) => v === undefined ? null : v) });

function subscribe<T>(name: string, callback: (payload: T) => void): () => void {
  let stopped = false;
  let unlisten: UnlistenFn | undefined;
  void listen<T>(name, (event) => callback(event.payload)).then((stop) => {
    if (stopped) stop();
    else unlisten = stop;
  });
  return () => { stopped = true; unlisten?.(); };
}

if (isTauri()) {
  const api: DesktopAPI = {
    snapshot: () => call("snapshot"),
    widget: {
      get: () => call("widget.get"), show: () => call("widget.show"),
      setPinned: (pinned) => call("widget.setPinned", pinned),
      hide: () => call("widget.hide"), openMain: (id) => call("widget.openMain", id),
    },
    items: {
      save: (c, n) => call("items.save", c, n),
      setMode: (id, p, a) => call("items.mode", id, p, a),
      check: (id, key, checked) => call("items.check", id, key, checked),
      state: (id, state, result, reason) => call("items.state", id, state, result, reason),
      editRun: (id, title, body) => call("items.edit", id, title, body),
    },
    projects: {
      previewConfig: (text, target) => call("projects.config.preview", text, target),
      commitConfig: (token) => call("projects.config.commit", token),
      exportConfig: (id) => call("projects.config.export", id),
      saveConfigFile: (text) => call("projects.config.saveFile", text),
      save: (p) => call("projects.save", p),
      saveWorkflow: (id, flow, revision) => call("projects.workflow", id, flow, revision),
    },
    records: {
      saveLog: (v) => call("logs.save", v), deleteLog: (id) => call("logs.delete", id),
      saveNote: (v) => call("notes.save", v), deleteNote: (id) => call("notes.delete", id),
    },
    reminders: {
      list: () => call("reminders.list"), dismiss: (ids) => call("reminders.dismiss", ids),
      snooze: (id) => call("reminders.snooze", id), open: (id) => call("reminders.open", id),
    },
    imports: {
      preview: (text) => call("imports.preview", text), commit: (token) => call("imports.commit", token),
      readFile: () => call("imports.read"), export: () => call("imports.export"),
    },
    reports: {
      preview: (q) => call("reports.preview", q), output: (e, g, s) => call("reports.output", e, g, s),
    },
    backup: {
      create: () => call("backup.create"), preview: () => call("backup.preview"),
      restore: (token) => call("backup.restore", token),
    },
    settings: { save: (s) => call("settings.save", s) },
    window: {
      copyText: (text) => call("window.copyText", text), close: () => call("window.close"),
      dirty: (value) => { void invoke("kb_dirty", { value }); },
      openExternal: (url) => call("window.external", url),
    },
    onChange: (cb) => subscribe("kb:changed", cb),
    onOpenRun: (cb) => subscribe<string>("kb:open-run", cb),
  };
  window.kanban = api;
  document.addEventListener("mousedown", (event) => {
    const element = event.target as HTMLElement;
    if (event.button === 0 && element.closest(".sticky-titlebar") && !element.closest("button"))
      void call("window.drag");
  });
}

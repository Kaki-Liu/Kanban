import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../shared/contracts";

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(`kb:${channel}`, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value as T;
}
const api: DesktopAPI = {
  snapshot: () => call("snapshot"),
  items: {
    save: (c, n) => call("items.save", c, n),
    setMode: (id, p, a) => call("items.mode", id, p, a),
    check: (id, key, checked) => call("items.check", id, key, checked),
    state: (id, state, result, reason) =>
      call("items.state", id, state, result, reason),
    editRun: (id, title, body) => call("items.edit", id, title, body),
  },
  projects: { save: (input) => call("projects.save", input) },
  records: {
    saveLog: (input) => call("logs.save", input),
    deleteLog: (id) => call("logs.delete", id),
    saveNote: (input) => call("notes.save", input),
    deleteNote: (id) => call("notes.delete", id),
  },
  reminders: {
    list: () => call("reminders.list"),
    dismiss: (ids) => call("reminders.dismiss", ids),
    snooze: (id) => call("reminders.snooze", id),
    open: (id) => call("reminders.open", id),
  },
  imports: {
    preview: (text) => call("imports.preview", text),
    commit: (token) => call("imports.commit", token),
    readFile: () => call("imports.read"),
    export: () => call("imports.export"),
  },
  reports: {
    preview: (q) => call("reports.preview", q),
    output: (e, g, s) => call("reports.output", e, g, s),
  },
  backup: {
    create: () => call("backup.create"),
    preview: () => call("backup.preview"),
    restore: (token) => call("backup.restore", token),
  },
  settings: { save: (s) => call("settings.save", s) },
  window: {
    close: () => call("window.close"),
    dirty: (value) => ipcRenderer.send("kb:dirty", value),
    openExternal: (url) => call("window.external", url),
  },
  onChange: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("kb:changed", listener);
    return () => ipcRenderer.removeListener("kb:changed", listener);
  },
  onOpenRun: (cb) => {
    const listener = (_: unknown, id: string) => cb(id);
    ipcRenderer.on("kb:open-run", listener);
    return () => ipcRenderer.removeListener("kb:open-run", listener);
  },
};
contextBridge.exposeInMainWorld("kanban", api);

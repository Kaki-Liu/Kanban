import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  powerMonitor,
  screen,
  dialog,
  shell,
  clipboard,
  session,
} from "electron";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Store } from "./store";
import { settingsSchema, dateSchema } from "../shared/contracts";
import type { Run, ReportEntry } from "../shared/contracts";

app.setName("Kanban");
const dataDir =
  process.env.KANBAN_DATA_DIR ||
  join(app.getPath("appData"), app.isPackaged ? "Kanban" : "Kanban-dev");
app.setPath("userData", dataDir);
app.setAppUserModelId("local.kanban.desktop");
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
let store: Store;
let main: BrowserWindow,
  quick: BrowserWindow,
  reminderWindow: BrowserWindow,
  tray: Tray;
let quitting = false,
  locked = false,
  ticking = false,
  firstTrayClose = true;
let timer: ReturnType<typeof setInterval> | undefined;
let activeReminders = new Set<string>();
const dirty = new Map<number, boolean>();
const id = z.string().min(1).max(200);

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send("kb:changed");
}
function showMain(runId?: string): void {
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  if (runId) main.webContents.send("kb:open-run", runId);
}
function visibleReminders(): Run[] {
  const shown = new Set(
    store
      .reminders()
      .filter((r) => r.status === "shown")
      .map((r) => r.runId),
  );
  const runs = [...activeReminders]
    .filter((r) => shown.has(r))
    .map((r) => store.getRun(r))
    .filter((r) => ["pending", "doing"].includes(r.state));
  activeReminders = new Set(runs.map((r) => r.id));
  return runs;
}
async function tick(): Promise<void> {
  if (ticking || !store || quitting) return;
  ticking = true;
  try {
    const generated = store.ensureToday();
    if (generated) broadcast();
    if (locked || powerMonitor.getSystemIdleState(1) === "locked") return;
    const due = store.dueReminders();
    const remaining = visibleReminders();
    if (!remaining.length && !due.length) {
      reminderWindow?.hide();
      return;
    }
    if (due.length) {
      due.forEach((r) => activeReminders.add(r.id));
      const area = screen.getDisplayNearestPoint(
        screen.getCursorScreenPoint(),
      ).workArea;
      reminderWindow.setBounds({
        x: area.x + Math.max(0, area.width - 420 - 20),
        y: area.y + Math.max(0, area.height - 360 - 20),
        width: Math.min(420, area.width),
        height: Math.min(360, area.height),
      });
      reminderWindow.setAlwaysOnTop(true);
      reminderWindow.showInactive();
      store.markShown(due.map((r) => r.id));
      broadcast();
    }
  } catch (e) {
    console.error("Reminder tick:", e);
  } finally {
    ticking = false;
  }
}
function confirmDiscard(w: BrowserWindow): boolean {
  if (!dirty.get(w.webContents.id)) return true;
  const choice = dialog.showMessageBoxSync(w, {
    type: "question",
    title: "未保存的内容",
    message: "有尚未保存的内容。要保留并继续编辑吗？",
    buttons: ["继续编辑", "放弃并关闭"],
    defaultId: 0,
    cancelId: 0,
  });
  if (choice === 1) {
    dirty.set(w.webContents.id, false);
    return true;
  }
  return false;
}
function createWindow(kind: "main" | "quick" | "reminder"): BrowserWindow {
  const w = new BrowserWindow({
    width: kind === "main" ? 1200 : kind === "quick" ? 600 : 420,
    height: kind === "main" ? 800 : kind === "quick" ? 300 : 360,
    minWidth: kind === "main" ? 850 : 320,
    minHeight: kind === "main" ? 600 : 220,
    show: false,
    title:
      kind === "main"
        ? "本地工作看板"
        : kind === "quick"
          ? "随手记"
          : "到点提醒",
    autoHideMenuBar: true,
    skipTaskbar: kind === "reminder",
    alwaysOnTop: kind === "reminder",
    backgroundColor: "#f5f6fa",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.on("page-title-updated", (e) => e.preventDefault());
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    const hadDraft = dirty.get(w.webContents.id);
    if (!confirmDiscard(w)) return;
    if (hadDraft) w.webContents.reload();
    if (kind === "reminder") {
      store.dismiss([...activeReminders]);
      activeReminders.clear();
      broadcast();
    }
    w.hide();
    if (kind === "main" && firstTrayClose) {
      firstTrayClose = false;
      tray.displayBalloon({
        title: "工作看板仍在运行",
        content: "到点会继续提醒。通过托盘图标打开看板或退出。",
        respectQuietTime: true,
      });
    }
    if (kind === "quick") w.webContents.send("kb:changed");
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url && !app.isPackaged) void w.loadURL(`${url}/?window=${kind}`);
  else
    void w.loadFile(join(__dirname, "../renderer/index.html"), {
      query: { window: kind },
    });
  return w;
}
function shortcut(value: string): boolean {
  try {
    return globalShortcut.register(value, () => {
      quick.show();
      quick.focus();
      quick.webContents.send("kb:changed");
    });
  } catch {
    return false;
  }
}
function registerHandlers(): void {
  const handlers: Record<string, (...args: any[]) => any> = {
    snapshot: () => store.snapshot(),
    "items.save": (c, n) =>
      store.saveItem(c, n === undefined ? undefined : id.parse(n)),
    "items.mode": (i, p, a) =>
      store.setMode(id.parse(i), z.boolean().parse(p), z.boolean().parse(a)),
    "items.check": (i, k, c) =>
      store.check(id.parse(i), id.parse(k), z.boolean().parse(c)),
    "items.state": (i, s, r, reason) =>
      store.state(
        id.parse(i),
        z.enum(["pending", "doing", "completed", "skipped"]).parse(s),
        z.string().max(100000).optional().parse(r),
        z.string().max(1000).optional().parse(reason),
      ),
    "items.edit": (i, t, b) => store.editRun(id.parse(i), t, b),
    "projects.save": (p) => store.saveProject(p),
    "logs.save": (p) => store.saveLog(p),
    "logs.delete": (i) => store.deleteLog(id.parse(i)),
    "notes.save": (p) => store.saveNote(p),
    "notes.delete": (i) => store.deleteNote(id.parse(i)),
    "reminders.list": () => visibleReminders(),
    "reminders.dismiss": (ids) => {
      const parsed = z.array(id).max(1000).parse(ids);
      store.dismiss(parsed);
      parsed.forEach((i) => activeReminders.delete(i));
      if (!activeReminders.size) reminderWindow.hide();
    },
    "reminders.snooze": (i) => {
      store.snooze(id.parse(i));
      activeReminders.delete(i);
      if (!activeReminders.size) reminderWindow.hide();
    },
    "reminders.open": (i) => {
      store.getRun(id.parse(i));
      showMain(i);
    },
    "imports.preview": (t) =>
      store.previewImport(z.string().max(5000000).parse(t)),
    "imports.commit": (t) => store.commitImport(id.parse(t)),
    "imports.read": async () => {
      const r = await dialog.showOpenDialog(main, {
        filters: [{ name: "JSON 配置", extensions: ["json"] }],
        properties: ["openFile"],
      });
      return r.canceled ? null : readFile(r.filePaths[0], "utf8");
    },
    "imports.export": async () => {
      const r = await dialog.showSaveDialog(main, {
        defaultPath: `kanban-config-${store.day()}.json`,
        filters: [{ name: "JSON 配置", extensions: ["json"] }],
      });
      if (r.canceled || !r.filePath) return false;
      await writeFile(r.filePath, store.exportConfig(), "utf8");
      return true;
    },
    "reports.preview": (q) =>
      store.report(
        z
          .object({
            from: dateSchema,
            to: dateSchema,
            includePending: z.boolean(),
          })
          .strict()
          .parse(q),
      ),
    "reports.output": async (entries, grouping, save) => {
      const parsed = z
        .array(
          z
            .object({
              id,
              date: dateSchema,
              projectId: id.nullable(),
              title: z.string(),
              body: z.string(),
              kind: z.enum(["completed", "pending", "log"]),
            })
            .strict(),
        )
        .max(50000)
        .parse(entries) as ReportEntry[];
      const text = store.reportMarkdown(
        parsed,
        z.enum(["date", "project"]).parse(grouping),
      );
      if (!z.boolean().parse(save)) {
        clipboard.writeText(text);
        return true;
      }
      const r = await dialog.showSaveDialog(main, {
        defaultPath: `工作汇报素材-${store.day()}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (r.canceled || !r.filePath) return false;
      await writeFile(r.filePath, text, "utf8");
      return true;
    },
    "backup.create": async () => {
      const r = await dialog.showSaveDialog(main, {
        defaultPath: `kanban-${store.day()}.kanban-backup`,
        filters: [{ name: "看板备份", extensions: ["kanban-backup"] }],
      });
      if (r.canceled || !r.filePath) return false;
      await store.createBackup(resolve(r.filePath));
      return true;
    },
    "backup.preview": async () => {
      const r = await dialog.showOpenDialog(main, {
        filters: [{ name: "看板备份", extensions: ["kanban-backup"] }],
        properties: ["openFile"],
      });
      return r.canceled ? null : store.previewBackup(resolve(r.filePaths[0]));
    },
    "backup.restore": async (token) => {
      await store.restoreBackup(id.parse(token));
      activeReminders.clear();
      reminderWindow.hide();
      globalShortcut.unregisterAll();
      if (!shortcut(store.settings().shortcut))
        void dialog.showMessageBox(main, {
          type: "warning",
          message: "数据已恢复，但快捷键被占用，请到设置修改。",
        });
      if (!process.env.KANBAN_E2E)
        app.setLoginItemSettings({
          openAtLogin: store.settings().autoStart,
          args: app.isPackaged ? [] : [app.getAppPath()],
        });
      await tick();
    },
    "settings.save": (s) => {
      const parsed = settingsSchema.parse(s),
        previous = store.settings();
      if (parsed.shortcut !== previous.shortcut && !shortcut(parsed.shortcut))
        throw new Error("快捷键不可用或已被占用，请选择其他组合。");
      try {
        store.saveSettings(parsed);
        if (parsed.shortcut !== previous.shortcut)
          globalShortcut.unregister(previous.shortcut);
        if (!process.env.KANBAN_E2E)
          app.setLoginItemSettings({
            openAtLogin: parsed.autoStart,
            args: app.isPackaged ? [] : [app.getAppPath()],
          });
      } catch (e) {
        if (parsed.shortcut !== previous.shortcut)
          globalShortcut.unregister(parsed.shortcut);
        throw e;
      }
    },
    "window.external": async (url) => {
      const parsed = new URL(z.string().max(4000).parse(url));
      if (!["http:", "https:"].includes(parsed.protocol))
        throw new Error("仅支持打开网页链接");
      await shell.openExternal(parsed.toString());
    },
  };
  const readOnly = new Set([
    "snapshot",
    "reminders.list",
    "imports.preview",
    "imports.read",
    "imports.export",
    "reports.preview",
    "reports.output",
    "backup.preview",
    "backup.create",
    "window.external",
  ]);
  for (const [channel, fn] of Object.entries(handlers))
    ipcMain.handle(`kb:${channel}`, async (event, ...args) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (
          ![main, quick, reminderWindow].includes(win!) ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("不允许的调用来源");
        if (win === quick && !["snapshot", "logs.save"].includes(channel))
          throw new Error("快速记录窗口无此权限");
        if (win === reminderWindow && !channel.startsWith("reminders."))
          throw new Error("提醒窗口无此权限");
        const value = await fn(...args);
        if (!readOnly.has(channel)) {
          broadcast();
          await tick();
        }
        return { ok: true, value };
      } catch (e) {
        return {
          ok: false,
          error:
            e instanceof z.ZodError
              ? e.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("\n")
              : e instanceof Error
                ? e.message
                : String(e),
        };
      }
    });
  ipcMain.handle("kb:window.close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
    return { ok: true };
  });
  ipcMain.on("kb:dirty", (event, value) => {
    if (typeof value === "boolean") dirty.set(event.sender.id, value);
  });
}

if (lock)
  app
    .whenReady()
    .then(async () => {
      store = new Store(join(dataDir, "kanban.db"));
      session.defaultSession.setPermissionRequestHandler(
        (_web, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      main = createWindow("main");
      quick = createWindow("quick");
      reminderWindow = createWindow("reminder");
      const bitmap = Buffer.alloc(32 * 32 * 4);
      for (let y = 3; y < 29; y++)
        for (let x = 3; x < 29; x++) {
          const p = (y * 32 + x) * 4;
          const column = Math.floor((x - 3) / 9);
          bitmap[p] = column === 1 ? 86 : 208;
          bitmap[p + 1] = column === 2 ? 165 : 110;
          bitmap[p + 2] = column === 0 ? 70 : 56;
          bitmap[p + 3] = (x - 3) % 9 < 7 && y < [26, 21, 15][column] ? 255 : 0;
        }
      const icon = nativeImage.createFromBitmap(bitmap, {
        width: 32,
        height: 32,
      });
      main.setIcon(icon);
      quick.setIcon(icon);
      reminderWindow.setIcon(icon);
      tray = new Tray(icon);
      tray.setToolTip("本地工作看板");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开看板", click: () => showMain() },
          {
            label: "随手记",
            click: () => {
              quick.show();
              quick.focus();
            },
          },
          { type: "separator" },
          { label: "退出", click: () => app.quit() },
        ]),
      );
      tray.on("double-click", () => showMain());
      registerHandlers();
      main.once("ready-to-show", () => {
        main.show();
        if (!shortcut(store.settings().shortcut))
          void dialog.showMessageBox(main, {
            type: "warning",
            message: "快速记录快捷键被占用，请在设置中修改。",
          });
      });
      reminderWindow.webContents.once("did-finish-load", () => {
        void tick();
        timer = setInterval(() => void tick(), 5000);
      });
      powerMonitor.on("lock-screen", () => {
        locked = true;
        reminderWindow.hide();
      });
      powerMonitor.on("unlock-screen", () => {
        locked = false;
        if (activeReminders.size) reminderWindow.showInactive();
        void tick();
      });
      powerMonitor.on("resume", () => void tick());
    })
    .catch((e) => {
      dialog.showErrorBox("工作看板启动失败", String(e));
      app.exit(1);
    });
app.on("second-instance", () => showMain());
app.on("window-all-closed", () => {});
app.on("before-quit", (e) => {
  if (
    !quitting &&
    BrowserWindow.getAllWindows().some((w) => !confirmDiscard(w))
  ) {
    e.preventDefault();
    return;
  }
  quitting = true;
});
app.on("will-quit", () => {
  if (timer) clearInterval(timer);
  globalShortcut.unregisterAll();
  store?.close();
});

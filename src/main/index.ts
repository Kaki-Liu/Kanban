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
import { readFile, writeFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Store } from "./store";
import { settingsSchema, dateSchema } from "../shared/contracts";
import type { Run, ReportEntry } from "../shared/contracts";
import { atTime } from "../shared/time";
import { parseProjectConfig } from "../shared/project-config";
import {
  clampWidgetBounds,
  widgetSize,
  type WidgetPreferences,
} from "../shared/widget";

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
  widgetWindow: BrowserWindow,
  tray: Tray;
let quitting = false,
  locked = false,
  ticking = false,
  firstTrayClose = true;
let timer: ReturnType<typeof setInterval> | undefined;
let widgetSaveTimer: ReturnType<typeof setTimeout> | undefined;
let widgetPreferences: WidgetPreferences;
let widgetReady = false;
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
function updateWidgetPreferences(patch: Partial<WidgetPreferences>): void {
  const next = { ...widgetPreferences, ...patch };
  store.saveWidgetPreferences(next);
  widgetPreferences = next;
}
function positionWidget(): void {
  const bounds = widgetPreferences.bounds;
  const area = (
    bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  ).workArea;
  const clamped = clampWidgetBounds(bounds, area);
  widgetWindow.setMinimumSize(
    Math.min(widgetSize.minWidth, area.width),
    Math.min(widgetSize.minHeight, area.height),
  );
  widgetWindow.setBounds(clamped);
}
function showWidget(): void {
  updateWidgetPreferences({ visible: true });
  positionWidget();
  widgetWindow.setAlwaysOnTop(widgetPreferences.pinned);
  if (widgetReady && !locked) widgetWindow.showInactive();
  widgetWindow.webContents.send("kb:changed");
}
function hideWidget(): void {
  updateWidgetPreferences({ visible: false, bounds: widgetWindow.getBounds() });
  widgetWindow.hide();
}
function saveWidgetBounds(): void {
  if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
  widgetSaveTimer = undefined;
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const bounds = widgetWindow.getBounds();
  try {
    updateWidgetPreferences({ bounds });
  } catch (e) {
    // Keep the current position in this session even if a backup temporarily blocks writes.
    widgetPreferences = { ...widgetPreferences, bounds };
    console.error("Save widget position:", e);
  }
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
    else if (widgetWindow?.isVisible())
      widgetWindow.webContents.send("kb:changed");
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
function createWindow(
  kind: "main" | "quick" | "reminder" | "widget",
): BrowserWindow {
  const w = new BrowserWindow({
    width:
      kind === "main"
        ? 1200
        : kind === "quick"
          ? 600
          : kind === "widget"
            ? widgetSize.width
            : 420,
    height:
      kind === "main"
        ? 800
        : kind === "quick"
          ? 300
          : kind === "widget"
            ? widgetSize.height
            : 360,
    minWidth:
      kind === "main" ? 850 : kind === "widget" ? widgetSize.minWidth : 320,
    minHeight:
      kind === "main" ? 600 : kind === "widget" ? widgetSize.minHeight : 220,
    ...(kind === "widget"
      ? {
          maxWidth: widgetSize.maxWidth,
          maxHeight: widgetSize.maxHeight,
          frame: false,
          maximizable: false,
          minimizable: false,
          fullscreenable: false,
        }
      : {}),
    show: false,
    title:
      kind === "main"
        ? "本地工作看板"
        : kind === "quick"
          ? "随手记"
          : kind === "widget"
            ? "桌面便签"
            : "到点提醒",
    autoHideMenuBar: true,
    skipTaskbar: kind === "reminder" || kind === "widget",
    alwaysOnTop:
      kind === "reminder" || (kind === "widget" && widgetPreferences.pinned),
    backgroundColor: kind === "widget" ? "#faf9f3" : "#f5f6fa",
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
    if (kind === "widget") {
      try {
        hideWidget();
      } catch (error) {
        widgetPreferences.visible = false;
        console.error("Hide widget:", error);
        w.hide();
      }
      return;
    }
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
    "widget.get": () => store.widgetSnapshot(),
    "widget.show": () => showWidget(),
    "widget.hide": () => hideWidget(),
    "widget.setPinned": (pinned) => {
      updateWidgetPreferences({ pinned: z.boolean().parse(pinned) });
      widgetWindow.setAlwaysOnTop(widgetPreferences.pinned);
      widgetWindow.webContents.send("kb:changed");
    },
    "widget.openMain": (runId) => {
      if (runId !== undefined) store.getRun(id.parse(runId));
      showMain(runId);
    },
    "widget.complete": (runId) => {
      const run = store.widgetSnapshot().checklists.find((r) => r.id === id.parse(runId));
      if (!run) throw new Error("便签只能完成今天仍待处理的检查清单");
      if (!run.config.checklist.every((item) => run.checks[item.id]))
        throw new Error("请先勾完所有检查项");
      store.state(run.id, "completed");
    },
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
    "projects.config.preview": (text, targetId) =>
      store.previewProjectConfig(
        z.string().max(2_000_000).parse(text),
        targetId === undefined ? undefined : id.parse(targetId),
      ),
    "projects.config.commit": (token) =>
      store.commitProjectConfig(id.parse(token)),
    "projects.config.export": (projectId) =>
      store.exportProjectConfig(
        projectId === undefined ? undefined : id.parse(projectId),
      ),
    "projects.config.saveFile": async (text) => {
      const config = parseProjectConfig(z.string().max(2_000_000).parse(text));
      const r = await dialog.showSaveDialog(main, {
        defaultPath: "kanban-project.json",
        filters: [{ name: "项目配置 JSON", extensions: ["json"] }],
      });
      if (r.canceled || !r.filePath) return false;
      await writeFile(
        r.filePath,
        JSON.stringify(config, null, 2) + "\n",
        "utf8",
      );
      return true;
    },
    "projects.workflow": (i, w, revision) =>
      store.saveWorkflow(
        id.parse(i),
        w,
        z.number().int().nonnegative().parse(revision),
      ),
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
      if (r.canceled) return null;
      if ((await stat(r.filePaths[0])).size > 2_000_000)
        throw new Error("配置文件不能超过 2 MB。");
      return readFile(r.filePaths[0], "utf8");
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
      if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
      widgetSaveTimer = undefined;
      widgetPreferences = store.widgetPreferences();
      positionWidget();
      widgetWindow.setAlwaysOnTop(widgetPreferences.pinned);
      if (widgetPreferences.visible && !locked) widgetWindow.showInactive();
      else widgetWindow.hide();
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
    "window.copyText": (text) =>
      clipboard.writeText(z.string().max(2_000_000).parse(text)),
    "window.external": async (url) => {
      const parsed = new URL(z.string().max(4000).parse(url));
      if (!["http:", "https:"].includes(parsed.protocol))
        throw new Error("仅支持打开网页链接");
      await shell.openExternal(parsed.toString());
    },
  };
  const readOnly = new Set([
    "snapshot",
    "widget.get",
    "widget.show",
    "widget.hide",
    "widget.setPinned",
    "widget.openMain",
    "reminders.list",
    "imports.preview",
    "imports.read",
    "projects.config.preview",
    "projects.config.export",
    "projects.config.saveFile",
    "imports.export",
    "reports.preview",
    "reports.output",
    "backup.preview",
    "backup.create",
    "window.external",
    "window.copyText",
  ]);
  for (const [channel, fn] of Object.entries(handlers))
    ipcMain.handle(`kb:${channel}`, async (event, ...args) => {
      const previousRevision = store.revision();
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (
          ![main, quick, reminderWindow, widgetWindow].includes(win!) ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("不允许的调用来源");
        if (win === quick && !["snapshot", "logs.save"].includes(channel))
          throw new Error("快速记录窗口无此权限");
        if (win === reminderWindow && !channel.startsWith("reminders."))
          throw new Error("提醒窗口无此权限");
        if (win === widgetWindow) {
          if (
            ![
              "widget.get",
              "widget.setPinned",
              "widget.hide",
              "widget.openMain",
              "widget.complete",
              "items.check",
            ].includes(channel)
          )
            throw new Error("便签窗口无此权限");
          if (
            channel === "items.check" &&
            !store.widgetSnapshot().checklists.some((run) => run.id === args[0])
          )
            throw new Error("便签只能勾选今天的检查清单");
        }
        const completing = channel === "widget.complete" || channel === "items.state";
        if (completing) store.ensureToday();
        const previousRun = completing ? store.getRun(id.parse(args[0])) : undefined;
        const value = await fn(...args);
        if (previousRun && ["pending", "doing"].includes(previousRun.state)) {
          const completed = store.getRun(previousRun.id);
          const day = store.day();
          if (previousRun.date === day && completed.state === "completed"
            && completed.completedAt && completed.completedAt >= atTime(day, "15:00")
            && store.runs().filter((r) => r.date === day && r.state !== "withdrawn").every((r) => r.state === "completed"))
            win?.webContents.send("kb:celebrate", day);
        }
        // A read may generate today's runs at midnight before the scheduler gets its turn.
        if (!readOnly.has(channel) || previousRevision !== store.revision()) {
          broadcast();
          await tick();
        }
        return { ok: true, value };
      } catch (e) {
        if (previousRevision !== store.revision()) broadcast();
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
    if (
      ![main, quick, reminderWindow, widgetWindow].includes(win!) ||
      event.senderFrame !== event.sender.mainFrame
    )
      return { ok: false, error: "不允许的调用来源" };
    win?.close();
    return { ok: true };
  });
  ipcMain.on("kb:dirty", (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (
      [main, quick].includes(win!) &&
      event.senderFrame === event.sender.mainFrame &&
      typeof value === "boolean"
    )
      dirty.set(event.sender.id, value);
  });
}

if (lock)
  app
    .whenReady()
    .then(async () => {
      store = new Store(join(dataDir, "kanban.db"));
      await store.prepareVersion(app.getVersion());
      widgetPreferences = store.widgetPreferences();
      session.defaultSession.setPermissionRequestHandler(
        (_web, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      main = createWindow("main");
      quick = createWindow("quick");
      reminderWindow = createWindow("reminder");
      widgetWindow = createWindow("widget");
      positionWidget();
      const scheduleWidgetSave = () => {
        if (quitting) return;
        if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
        widgetSaveTimer = setTimeout(saveWidgetBounds, 250);
      };
      widgetWindow.on("move", scheduleWidgetSave);
      widgetWindow.on("resize", scheduleWidgetSave);
      widgetWindow.once("ready-to-show", () => {
        widgetReady = true;
        if (widgetPreferences.visible && !locked) widgetWindow.showInactive();
      });
      const recoverWidgetPosition = () => {
        widgetPreferences.bounds = widgetWindow.getBounds();
        positionWidget();
        saveWidgetBounds();
      };
      screen.on("display-removed", recoverWidgetPosition);
      screen.on("display-metrics-changed", recoverWidgetPosition);
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
      widgetWindow.setIcon(icon);
      tray = new Tray(icon);
      tray.setToolTip("本地工作看板");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开看板", click: () => showMain() },
          {
            label: "显示 / 隐藏桌面便签",
            click: () => {
              try {
                widgetPreferences.visible ? hideWidget() : showWidget();
              } catch (error) {
                void dialog.showMessageBox(main, {
                  type: "error",
                  message: String(error),
                });
              }
            },
          },
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
        widgetWindow.hide();
      });
      powerMonitor.on("unlock-screen", () => {
        locked = false;
        if (activeReminders.size) reminderWindow.showInactive();
        if (widgetPreferences.visible) widgetWindow.showInactive();
        void tick();
      });
      powerMonitor.on("resume", () => {
        recoverWidgetPosition();
        void tick();
      });
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
  saveWidgetBounds();
  quitting = true;
});
app.on("will-quit", () => {
  if (timer) clearInterval(timer);
  if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
  globalShortcut.unregisterAll();
  store?.close();
});

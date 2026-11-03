import { test, expect, chromium, type Browser } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { createServer } from "node:net";
import type { DesktopAPI } from "../../src/shared/contracts";

function nativeWindows(processId: number): {title:string; visible:boolean; top:boolean; focused:boolean}[] {
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WindowProbe {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int n);
}
'@
$items = [System.Collections.Generic.List[object]]::new()
[WindowProbe]::EnumWindows({param($handle,$unused)
  [uint32]$owner = 0
  [void][WindowProbe]::GetWindowThreadProcessId($handle,[ref]$owner)
  if ($owner -eq ${processId}) {
    $name = [System.Text.StringBuilder]::new(512)
    [void][WindowProbe]::GetWindowText($handle,$name,512)
    if ($name.Length -gt 0) { $items.Add(@{title=$name.ToString();visible=[WindowProbe]::IsWindowVisible($handle);top=(([WindowProbe]::GetWindowLongPtr($handle,-20).ToInt64() -band 8) -ne 0);focused=([WindowProbe]::GetForegroundWindow() -eq $handle)}) }
  }
  return $true
},[IntPtr]::Zero) | Out-Null
ConvertTo-Json -InputObject @($items.ToArray()) -Compress
`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")], {windowsHide:true,encoding:"utf8"}).trim());
}

test("Rust 桌面完整界面、旧配置、清单、便签、工作台和日历", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-rust-ui-"));
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as {port:number}).port;
  await new Promise<void>((done) => server.close(() => done()));
  let child: ChildProcess | undefined, browser: Browser | undefined;
  let output = "";
  const stop = async () => {
    if (child?.pid && child.exitCode === null) {
      try { execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"}); } catch { /* process already exited */ }
    }
    await Promise.race([browser?.close().catch(() => {}), new Promise((done) => setTimeout(done, 2000))]);
  };
  try {
    const source = process.env.KANBAN_RUST_EXE || ["src-tauri/target/release/kanban.exe", "src-tauri/target/x86_64-pc-windows-gnu/release/kanban.exe", "src-tauri/target/x86_64-pc-windows-msvc/release/kanban.exe"].map((p) => resolve(p)).find(existsSync);
    if (!source) throw new Error("请先运行 npm run pack，或设置 KANBAN_RUST_EXE。");
    const runtime = join(dir,"application");
    mkdirSync(runtime);
    copyFileSync(source,join(runtime,"kanban.exe"));
    copyFileSync(join(dirname(source),"WebView2Loader.dll"),join(runtime,"WebView2Loader.dll"));
    const launch = async () => {
      output = "";
      child = spawn(join(runtime,"kanban.exe"), [], {
      cwd: runtime, windowsHide: true, env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, KANBAN_E2E: "1", KANBAN_DATA_DIR: join(dir,"data"), KANBAN_CDP_PORT: String(port) },
    });
    child.stdout?.on("data", (s) => output += s.toString());
    child.stderr?.on("data", (s) => output += s.toString());
    await expect.poll(async () => {
      if (child?.exitCode !== null) throw new Error(`Rust app exited: ${output}`);
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; } catch { return false; }
    }, {timeout: 30_000}).toBe(true);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      await expect.poll(() => browser!.contexts().flatMap((c) => c.pages()).map((p) => p.url()), {timeout:15_000}).toContainEqual(expect.stringContaining("window=main"));
      return browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("window=main"))!;
    };
    const page = await launch();
    const contexts = browser!.contexts();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(page.getByRole("heading", {name:"今天，把事情一件件做好"})).toBeVisible();
    await page.getByRole("button", {name:"＋ 新建事项",exact:true}).click();
    await page.getByLabel("事项标题").fill("Rust 运维检查");
    await page.getByLabel("类型",{exact:true}).selectOption("checklist");
    await page.getByLabel("检查子项").fill("检查告警\n确认服务状态");
    await page.getByRole("button",{name:"保存事项",exact:true}).click();
    await expect(page.getByRole("button",{name:/Rust 运维检查.*待处理/})).toBeVisible();
    await page.getByRole("button",{name:/桌面便签/}).click();
    await expect.poll(() => contexts.flatMap((c) => c.pages()).some((p) => p.url().includes("window=widget"))).toBe(true);
    const widget = contexts.flatMap((c) => c.pages()).find((p) => p.url().includes("window=widget"))!;
    mkdirSync("test-results",{recursive:true});
    await expect(widget.getByLabel("确认服务状态",{exact:true})).toBeVisible();
    await widget.screenshot({path:"test-results/rust-widget-checklist.png"});
    expect(await widget.evaluate(async () => { try { await (window as unknown as {kanban:DesktopAPI}).kanban.snapshot(); return "allowed"; } catch(e) { return String(e); } })).toContain("此窗口无此权限");
    await widget.getByLabel("检查告警",{exact:true}).check();
    await widget.getByRole("button",{name:"Rust 运维检查",exact:true}).click();
    await expect(page.getByLabel("检查告警",{exact:true})).toBeChecked();
    await page.getByLabel("确认服务状态",{exact:true}).check();
    await page.getByLabel("处理结果").fill("Rust 版保存并同步成功");
    await page.getByRole("button",{name:"确认完成",exact:true}).click();
    await expect(widget.getByText("暂时没有待处理的检查")).toBeVisible();
    await page.evaluate(async () => {
      const api = (window as unknown as {kanban:DesktopAPI}).kanban;
      const text = await api.projects.exportConfig();
      const v = JSON.parse(text); v.project.name = "Rust 项目配置";
      const preview = await api.projects.previewConfig(JSON.stringify(v));
      await api.projects.commitConfig(preview.token);
    });
    await page.locator("nav").getByRole("button",{name:/项目/}).click();
    await expect(page.getByRole("button",{name:"展开开发工作台",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"展开开发工作台",exact:true}).click();
    await expect(page.getByRole("button",{name:"开发任务",exact:true})).toBeVisible();
    await page.locator("nav").getByRole("button",{name:/今天/}).click();
    await page.getByRole("button",{name:"日历回顾",exact:true}).click();
    await expect(page.getByRole("region",{name:"当天事项",exact:true})).toContainText("Rust 运维检查");
    await page.getByRole("button",{name:"＋ 补记工作",exact:true}).click();
    await page.getByRole("textbox",{name:"做了什么",exact:true}).fill("Rust 日历补记");
    await page.getByRole("button",{name:"保存记录",exact:true}).click();
    await expect(page.getByRole("region",{name:"工作记录",exact:true})).toContainText("Rust 日历补记");
    const snapshot = await page.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.snapshot());
    expect(snapshot.runs[0].state).toBe("completed");
    expect(snapshot.logs.some((l) => l.body === "Rust 日历补记")).toBe(true);
    expect(errors).toEqual([]);
    mkdirSync("test-results",{recursive:true});
    await page.screenshot({path:"test-results/rust-calendar.png"});
    await widget.screenshot({path:"test-results/rust-widget.png"});
    await page.evaluate(async () => {
      const api = (window as unknown as {kanban:DesktopAPI}).kanban;
      const s = await api.snapshot();
      await api.records.saveNote({title:"Rust 私人笔记",body:"保留且不进入汇报",projectId:null});
      for (const id of ["native-snooze","native-dismiss"]) await api.items.save({id,type:"task",title:id,project_id:null,content_markdown:"",checklist:[],schedule:{frequency:"once",date:s.today,time:"00:00",timezone:"Asia/Shanghai"},reminder:{popup:true,snooze_minutes:10}});
    });
    const reminder = contexts.flatMap((c) => c.pages()).find((p) => p.url().includes("window=reminder"))!;
    await expect(reminder.locator("article")).toHaveCount(2);
    const state = nativeWindows(child!.pid!);
    expect(state.find((w) => w.title === "到点提醒")).toMatchObject({visible:true,top:true,focused:false});
    expect(state.find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:true});
    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.setPinned(false));
    expect(nativeWindows(child!.pid!).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false});
    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.hide());
    expect(nativeWindows(child!.pid!).find((w) => w.title === "桌面便签")).toMatchObject({visible:false});
    await page.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.show());
    expect(nativeWindows(child!.pid!).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false});
    await page.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.window.close());
    expect(nativeWindows(child!.pid!).find((w) => w.title === "本地工作看板")).toMatchObject({visible:false});
    expect(nativeWindows(child!.pid!).find((w) => w.title === "桌面便签")).toMatchObject({visible:true});
    await reminder.locator("article").filter({hasText:"native-snooze"}).getByRole("button",{name:"10 分钟后"}).click();
    await expect(reminder.locator("article")).toHaveCount(1);
    await reminder.getByRole("button",{name:"关闭本次提醒",exact:true}).click();
    await expect(reminder.locator("article")).toHaveCount(0);
    await expect.poll(() => nativeWindows(child!.pid!).find((w) => w.title === "到点提醒")?.visible).toBe(false);
    await stop();
    const reopened = await launch();
    const persisted = await reopened.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.snapshot());
    expect(persisted.runs.find((r) => r.config.title === "Rust 运维检查")?.state).toBe("completed");
    expect(persisted.logs.some((l) => l.body === "Rust 日历补记")).toBe(true);
    expect(persisted.notes.some((n) => n.title === "Rust 私人笔记")).toBe(true);
    expect(await reopened.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.reminders.list())).toEqual([]);
    expect(nativeWindows(child!.pid!).find((w) => w.title === "到点提醒")).toMatchObject({visible:false});
    expect(nativeWindows(child!.pid!).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false});
    await reopened.locator("nav").getByRole("button",{name:/项目/}).click();
    await expect(reopened.getByRole("button",{name:"收起开发工作台",exact:true})).toBeVisible();
  } finally {
    await stop();
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep + "kanban-rust-ui-"))
      throw new Error("拒绝清理隔离测试目录以外的路径");
    rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

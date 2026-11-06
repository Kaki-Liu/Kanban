import { test, expect, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { createServer } from "node:net";
import type { DesktopAPI } from "../../src/shared/contracts";
import { today } from "../../src/shared/time";
import { version } from "../../package.json";

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

type RustSession = {
  launch: () => Promise<Page>;
  stop: () => Promise<void>;
  readonly contexts: BrowserContext[];
  readonly pid: number;
};

async function withRustApp(run: (session: RustSession) => Promise<void>, now?: string) {
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
      cwd: runtime, windowsHide: true, env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, KANBAN_E2E: "1", KANBAN_DATA_DIR: join(dir,"data"), KANBAN_CDP_PORT: String(port), KANBAN_E2E_NOW: now },
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
    await run({ launch, stop, get contexts() { return browser!.contexts(); }, get pid() { return child!.pid!; } });
  } finally {
    await stop();
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep + "kanban-rust-ui-"))
      throw new Error("拒绝清理隔离测试目录以外的路径");
    rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}

test("桌面便签入口唤回已打开的窗口，并保留置顶偏好", async () => {
  await withRustApp(async (session) => {
    const page = await session.launch();
    const openWidget = page.getByRole("button", {name:/桌面便签/});
    await openWidget.click();
    await expect.poll(() => session.contexts.flatMap((c) => c.pages()).some((p) => p.url().includes("window=widget"))).toBe(true);
    const widget = session.contexts.flatMap((c) => c.pages()).find((p) => p.url().includes("window=widget"))!;
    await expect(widget.getByRole("button", {name:"取消置顶",exact:true})).toBeVisible();
    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.setPinned(false));

    // The existing window stays visible behind the foreground main window.
    // Visibility alone cannot prove that clicking the entry actually recalls it.
    for (let attempt = 0; attempt < 2; attempt++) {
      await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.openMain());
      await expect.poll(() => nativeWindows(session.pid).find((w) => w.title === "本地工作看板")?.focused).toBe(true);
      expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false,focused:false});
      await openWidget.click();
      await expect.poll(() => nativeWindows(session.pid).find((w) => w.title === "桌面便签"), {timeout:5000}).toMatchObject({visible:true,top:false,focused:true});
    }

    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.hide());
    expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:false});
    await openWidget.click();
    await expect.poll(() => nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false,focused:true});
    await expect(widget.getByRole("button", {name:"置顶便签",exact:true})).toBeVisible();

    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.setPinned(true));
    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.openMain());
    await openWidget.click();
    await expect.poll(() => nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:true,focused:true});
    await expect(widget.getByRole("button", {name:"取消置顶",exact:true})).toBeVisible();
  });
});

test("Rust 桌面完整界面、旧配置、清单、便签、工作台和日历", async () => {
  await withRustApp(async (session) => {
    const { launch, stop } = session;
    const page = await launch();
    const contexts = session.contexts;
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
    // Hold a real save in flight to inspect the intermediate frame that used to dim all text.
    await widget.evaluate(() => {
      const api = (window as unknown as {kanban:DesktopAPI}).kanban;
      const original = api.items.check;
      api.items.check = (...args) => new Promise<void>((resolve, reject) => {
        (window as any).finishCheck = () => {
          api.items.check = original;
          original(...args).then(resolve, reject);
        };
      });
      (window as any).originalTitle = document.querySelector(".sticky-run-title");
    });
    await widget.getByLabel("检查告警",{exact:true}).check();
    await expect(widget.getByLabel("检查告警",{exact:true})).toBeDisabled();
    expect(await widget.locator(".sticky-widget button").evaluateAll((buttons) => buttons.every((b) => getComputedStyle(b).opacity === "1"))).toBe(true);
    expect(await widget.evaluate(() => (window as any).originalTitle === document.querySelector(".sticky-run-title"))).toBe(true);
    await widget.evaluate(() => (window as any).finishCheck());
    await expect(widget.getByLabel("检查告警",{exact:true})).toBeEnabled();
    // A failed write rolls back just the requested check and keeps the rest of the widget readable.
    await widget.evaluate(() => {
      const api = (window as unknown as {kanban:DesktopAPI}).kanban;
      const original = api.items.check;
      api.items.check = async () => { api.items.check = original; throw new Error("测试保存失败"); };
    });
    await widget.getByLabel("确认服务状态",{exact:true}).click();
    await expect(widget.getByRole("alert")).toContainText("测试保存失败");
    await expect(widget.getByLabel("确认服务状态",{exact:true})).not.toBeChecked();
    await expect(widget.getByLabel("检查告警",{exact:true})).toBeChecked();
    await widget.getByRole("button",{name:"重试",exact:true}).click();
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
      v.project.workflow.goal = "让部门同事轻松完成每日检查，并清楚知道项目下一步做什么。";
      v.project.workflow.tasks[0].title = "验证便签勾选体验";
      const preview = await api.projects.previewConfig(JSON.stringify(v));
      await api.projects.commitConfig(preview.token);
    });
    await page.locator("nav").getByRole("button",{name:/项目/}).click();
    await page.getByRole("group",{name:"当前项目操作"}).getByRole("button",{name:"Agent 协助",exact:true}).click();
    const agentDialog = page.getByRole("dialog",{name:"Agent 填写项目信息"});
    await agentDialog.getByLabel("这次想做什么？",{exact:true}).fill("帮我把下一步安排成一项可以开始的任务");
    await agentDialog.getByRole("button",{name:"预览发送内容",exact:true}).click();
    await agentDialog.getByText("发送内容",{exact:true}).click();
    await expect(agentDialog.getByLabel("Agent 发送内容",{exact:true})).toHaveValue(/帮我把下一步安排成一项可以开始的任务/);
    await expect(agentDialog.getByLabel("Agent 发送内容",{exact:true})).toHaveValue(/Rust 项目配置/);
    await agentDialog.getByText("发送内容",{exact:true}).click();
    await agentDialog.screenshot({path:"test-results/agent-assist.png"});
    await agentDialog.getByRole("button",{name:"导入 Agent 结果",exact:true}).click();
    const incoming = await page.evaluate(async () => {
      const api = window.kanban;
      const project = (await api.snapshot()).projects[0];
      const value = JSON.parse(await api.projects.exportConfig(project.id));
      value.project.update = "已安排下一步任务";
      return JSON.stringify(value);
    });
    await agentDialog.getByLabel("完整项目 JSON",{exact:true}).fill(incoming);
    await agentDialog.getByRole("button",{name:"校验并预览",exact:true}).click();
    await expect(agentDialog.getByRole("region",{name:"项目导入预览"})).toContainText("已安排下一步任务");
    await agentDialog.getByRole("button",{name:"确认更新项目",exact:true}).click();
    await expect(agentDialog).toHaveCount(0);
    await expect(page.getByRole("button",{name:"展开开发工作台",exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"项目概览"})).toContainText("验证便签勾选体验");
    await page.screenshot({path:"test-results/rust-project-overview.png"});
    await page.getByRole("region",{name:"项目概览"}).getByRole("button",{name:"处理任务",exact:true}).click();
    await expect(page.getByLabel("任务名称",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"开发任务",exact:true})).toBeVisible();
    const panel = page.getByRole("region",{name:"项目开发流程"});
    await panel.getByRole("button",{name:"当前行动",exact:true}).click();
    await expect(panel.getByRole("button",{name:"当前行动",exact:true})).toHaveAttribute("aria-pressed","true");
    await expect(panel.locator("input:visible, textarea:visible, select:visible")).toHaveCount(0);
    await panel.getByRole("button",{name:"让 Agent 帮我补全",exact:true}).click();
    await expect(panel.getByLabel("导出内容预览")).toHaveValue(/每轮最多问 3 个/);
    await expect(panel.getByLabel("导出内容预览")).toHaveValue(/验证便签勾选体验/);
    await expect(panel.getByLabel("导出内容预览")).toHaveValue(/kanban-project/);
    await panel.getByRole("button",{name:"关闭预览",exact:true}).click();
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({path:"test-results/rust-workbench-overview.png"});
    await panel.getByRole("button",{name:"查看并处理",exact:true}).click();
    await expect(panel.getByLabel("任务名称",{exact:true})).toBeVisible();
    await expect(panel.locator(".wf-board")).toHaveCount(0);
    await expect(panel.getByLabel("负责人",{exact:true})).not.toBeVisible();
    await expect(panel.getByLabel("交付物及版本",{exact:true})).not.toBeVisible();
    await panel.getByLabel("验收标准",{exact:true}).fill("勾选保存时标题持续可见");
    await panel.getByText("安排与分工",{exact:true}).click();
    await panel.getByLabel("负责人",{exact:true}).fill("本地测试");
    await panel.getByText("安排与分工",{exact:true}).click();
    await panel.getByRole("button",{name:"当前行动",exact:true}).click();
    await panel.getByRole("button",{name:"让 Agent 帮我补全",exact:true}).click();
    await expect(panel.getByLabel("导出内容预览")).toHaveValue(/勾选保存时标题持续可见/);
    await panel.getByRole("button",{name:"关闭预览",exact:true}).click();
    await panel.getByRole("button",{name:"查看并处理",exact:true}).click();
    await expect(panel.getByRole("textbox",{name:"验收标准",exact:true})).toHaveValue("勾选保存时标题持续可见");
    await panel.getByText("安排与分工",{exact:true}).click();
    await expect(panel.getByLabel("负责人",{exact:true})).toHaveValue("本地测试");
    await panel.getByText("安排与分工",{exact:true}).click();
    await panel.getByRole("button",{name:"保存全部修改",exact:true}).click();
    await expect(panel.getByRole("status")).toHaveText("开发流程已保存");
    await panel.screenshot({path:"test-results/rust-workbench-task.png"});
    await panel.getByRole("button",{name:"计划与设置",exact:true}).click();
    await expect(panel.getByLabel("里程碑名称",{exact:true})).not.toBeVisible();
    await panel.locator(".wf-route button").first().click();
    await expect(panel.getByLabel("里程碑名称",{exact:true})).toBeVisible();
    await expect(panel.locator(".wf-field-label").filter({hasText:/^里程碑验收条件$/})).toHaveAttribute("title", /判断这一阶段是否做完/);
    await expect(panel.getByLabel("里程碑验收条件",{exact:true})).toHaveAttribute("placeholder", /一分钟后的提醒/);
    await expect(panel.getByLabel("目标日期",{exact:true})).not.toBeVisible();
    await panel.getByText("日期与验证记录",{exact:true}).click();
    await expect(panel.getByLabel("目标日期",{exact:true})).toBeVisible();
    await panel.getByText("日期与验证记录",{exact:true}).click();
    await panel.getByRole("button",{name:"收起里程碑详情",exact:true}).click();
    await panel.getByText("目标、范围与流程设置",{exact:true}).click();
    await expect(panel.getByLabel("项目目标",{exact:true})).toBeVisible();
    await panel.getByRole("button",{name:"当前行动",exact:true}).click();
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
    const state = nativeWindows(session.pid);
    expect(state.find((w) => w.title === "到点提醒")).toMatchObject({visible:true,top:true,focused:false});
    expect(state.find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:true});
    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.setPinned(false));
    expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false});
    await widget.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.hide());
    expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:false});
    await page.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.widget.show());
    expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false});
    await page.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.window.close());
    expect(nativeWindows(session.pid).find((w) => w.title === "本地工作看板")).toMatchObject({visible:false});
    expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true});
    await reminder.locator("article").filter({hasText:"native-snooze"}).getByRole("button",{name:"10 分钟后"}).click();
    await expect(reminder.locator("article")).toHaveCount(1);
    await reminder.getByRole("button",{name:"关闭本次提醒",exact:true}).click();
    await expect(reminder.locator("article")).toHaveCount(0);
    await expect.poll(() => nativeWindows(session.pid).find((w) => w.title === "到点提醒")?.visible).toBe(false);
    await stop();
    const reopened = await launch();
    const persisted = await reopened.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.snapshot());
    expect(persisted.runs.find((r) => r.config.title === "Rust 运维检查")?.state).toBe("completed");
    expect(persisted.logs.some((l) => l.body === "Rust 日历补记")).toBe(true);
    expect(persisted.notes.some((n) => n.title === "Rust 私人笔记")).toBe(true);
    expect(await reopened.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.reminders.list())).toEqual([]);
    expect(nativeWindows(session.pid).find((w) => w.title === "到点提醒")).toMatchObject({visible:false});
    expect(nativeWindows(session.pid).find((w) => w.title === "桌面便签")).toMatchObject({visible:true,top:false});
    await reopened.locator("nav").getByRole("button",{name:/项目/}).click();
    await expect(reopened.getByRole("button",{name:"收起开发工作台",exact:true})).toBeVisible();
    await reopened.evaluate(() => (window as unknown as {kanban:DesktopAPI}).kanban.projects.save({name:"新流程测试"}));
    await reopened.locator(".project-selector").getByRole("button",{name:/新流程测试/}).click();
    await reopened.getByRole("button",{name:"展开开发工作台",exact:true}).click();
    const setup = reopened.getByRole("region",{name:"项目开发流程"});
    await expect(setup.locator("input:visible, textarea:visible, select:visible")).toHaveCount(1);
    await expect(setup.getByRole("button",{name:"开始规划",exact:true})).toBeDisabled();
    await setup.getByLabel("项目目标",{exact:true}).fill("只先规划一个可开始的任务");
    await setup.getByRole("button",{name:"开始规划",exact:true}).click();
    await expect(setup.getByRole("button",{name:"当前行动",exact:true})).toHaveAttribute("aria-pressed","true");
    await setup.getByRole("button",{name:"开始这一步",exact:true}).click();
    await expect(setup.getByLabel("任务名称",{exact:true})).not.toHaveValue("");
  });
});

for (const surface of ["main", "widget"] as const) {
  test(`下午全部完成仅在操作窗口庆祝：${surface}`, async () => {
    const clock = `${today()}T16:00:00+08:00`;
    await withRustApp(async (session) => {
      const page = await session.launch();
      await expect(page.getByRole("heading", {name:"今天，把事情一件件做好"})).toBeVisible();
      const initial = await page.evaluate(async () => {
        const api = window.kanban;
        const snapshot = await api.snapshot();
        for (const id of ["preparation", "final"]) {
          await api.items.save({
            id, type: id === "final" ? "checklist" : "task", title: id === "final" ? "今日收尾检查" : "准备事项",
            project_id: null, content_markdown: "",
            checklist: id === "final" ? [{id:"a",text:"核对服务"},{id:"b",text:"确认告警"}] : [],
            schedule: {frequency:"once",date:snapshot.today,timezone:"Asia/Shanghai"},
            reminder: {popup:false,snooze_minutes:10},
          });
        }
        await api.widget.show();
        const runs = (await api.snapshot()).runs;
        return { first: runs.find((r) => r.templateId === "preparation")!.id, last: runs.find((r) => r.templateId === "final")!.id };
      });
      const widget = session.contexts.flatMap((context) => context.pages()).find((p) => p.url().includes("window=widget"))!;
      await expect(widget.getByLabel("核对服务",{exact:true})).toBeVisible();
      const refused = await widget.evaluate(async (id) => {
        try { await window.kanban.widget.complete(id); return "allowed"; } catch(e) { return String(e); }
      }, initial.first);
      expect(refused).toContain("只能完成");
      await page.evaluate((id) => window.kanban.items.state(id, "completed"), initial.first);
      await expect(page.locator(".completion-celebration")).toHaveCount(0);
      await widget.getByLabel("核对服务",{exact:true}).check();
      await expect(widget.getByRole("button",{name:"完成检查",exact:true})).toHaveCount(0);
      await widget.getByLabel("确认告警",{exact:true}).check();
      await expect(widget.getByRole("button",{name:"完成检查",exact:true})).toBeEnabled();
      await expect(widget.locator(".completion-celebration")).toHaveCount(0);
      const target = surface === "widget" ? widget : page;
      const other = surface === "widget" ? page : widget;
      await other.evaluate(() => {
        (window as any).celebrationEvents = 0;
        window.kanban.onCelebrate(() => { (window as any).celebrationEvents++; });
      });
      if (surface === "widget") {
        await widget.getByRole("button",{name:"完成检查",exact:true}).click();
      } else {
        await widget.getByRole("button",{name:"今日收尾检查",exact:true}).click();
        await page.getByRole("button",{name:"确认完成",exact:true}).click();
      }
      await expect(target.locator(".completion-message")).toHaveText("🎉 今日任务全部完成");
      await expect(target.locator(".completion-celebration")).toHaveCSS("pointer-events", "none");
      await target.waitForTimeout(450); // Capture the short, intentional animation after confetti starts falling.
      await target.screenshot({path:`test-results/celebration-${surface}.png`});
      await target.emulateMedia({reducedMotion:"reduce"});
      await expect(target.locator(".completion-confetti")).not.toBeVisible();
      await expect(target.locator(".completion-message")).toBeVisible();
      await expect(target.locator(".completion-celebration")).toHaveCount(0, {timeout:6000});
      await target.emulateMedia({reducedMotion:"no-preference"});
      expect(await other.evaluate(() => (window as any).celebrationEvents)).toBe(0);
      await expect(other.locator(".completion-celebration")).toHaveCount(0);
      const snapshot = await page.evaluate(() => window.kanban.snapshot());
      expect(snapshot.runs.every((r) => r.state === "completed")).toBe(true);

      // A new completion in another window after restart cannot replay today's celebration.
      await session.stop();
      const reopened = await session.launch();
      await expect(reopened.getByRole("heading", {name:"今天，把事情一件件做好"})).toBeVisible();
      await expect(reopened.locator(".completion-celebration")).toHaveCount(0);
      await reopened.evaluate(async () => {
        const api = window.kanban;
        const snapshot = await api.snapshot();
        await api.items.save({id:"extra",type:"checklist",title:"追加检查",project_id:null,content_markdown:"",checklist:[{id:"a",text:"追加核对"}],schedule:{frequency:"once",date:snapshot.today,timezone:"Asia/Shanghai"},reminder:{popup:false,snooze_minutes:10}});
        await api.widget.show();
      });
      const restoredWidget = session.contexts.flatMap((context) => context.pages()).find((p) => p.url().includes("window=widget"))!;
      await restoredWidget.getByLabel("追加核对",{exact:true}).check();
      await restoredWidget.getByRole("button",{name:"完成检查",exact:true}).click();
      await expect(restoredWidget.getByText("暂时没有待处理的检查")).toBeVisible();
      await expect(restoredWidget.locator(".completion-celebration")).toHaveCount(0);
      await expect(reopened.locator(".completion-celebration")).toHaveCount(0);
      if (surface === "main") {
        await reopened.getByRole("button",{name:/设置与备份/}).click();
        const settings = reopened.getByRole("dialog",{name:"设置与数据管理"});
        await expect(settings.locator(".app-credit")).toHaveText(`by Kashiko · v${version}`);
        await settings.screenshot({path:"test-results/settings-credit.png"});
      }
    }, clock);
  });
}

import { _electron as electron, expect } from "@playwright/test";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";

async function run() {
  const dir = mkdtempSync(join(tmpdir(), "kanban-desktop-perf-"));
  const store = new Store(join(dir, "kanban.db"));
  for (let i = 0; i < 10000; i++)
    store.saveLog({
      body: `工作记录 ${i}：已完成告警排查，记录处理过程。`,
      date: store.day(),
    });
  store.close();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const start = performance.now();
    app = await electron.launch({
      executablePath: resolve(
        process.env.KANBAN_TEST_EXE || "dist/win-unpacked/Kanban.exe",
      ),
      args: [],
      env: { ...process.env, KANBAN_DATA_DIR: dir, KANBAN_E2E: "1" },
    });
    await app.firstWindow();
    await expect
      .poll(() => app!.windows().some((w) => w.url().includes("window=main")))
      .toBe(true);
    const page = app.windows().find((w) => w.url().includes("window=main"))!;
    await page
      .getByRole("heading", { name: "今天，把事情一件件做好" })
      .waitFor();
    const startupMs = performance.now() - start;
    const saveStart = performance.now();
    await page.getByLabel("快速工作记录").fill("性能检查：新增工作记录");
    await page.getByLabel("快速工作记录").press("Enter");
    await page.getByRole("status").filter({ hasText: "已记录" }).waitFor();
    const saveMs = performance.now() - saveStart;
    const browseStart = performance.now();
    await page.locator("nav").getByRole("button", { name: "记录" }).click();
    await page.locator(".record-card").first().waitFor();
    const browseMs = performance.now() - browseStart;
    const searchStart = performance.now();
    await page.getByLabel("搜索记录").fill("工作记录 999");
    await page.waitForFunction(
      () => document.querySelectorAll(".record-card").length === 11,
    );
    const searchMs = performance.now() - searchStart;
    const displays = await app.evaluate(({ screen }) =>
      screen
        .getAllDisplays()
        .map((d) => ({ size: d.size, scaleFactor: d.scaleFactor })),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "本地工作看板")!
        .setSize(850, 600),
    );
    await page.waitForFunction(() => innerWidth <= 850);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    const result = {
      executable: process.env.KANBAN_TEST_EXE || "dist/win-unpacked/Kanban.exe",
      records: 10000,
      startupMs: +startupMs.toFixed(2),
      uiSaveMs: +saveMs.toFixed(2),
      recordsBrowseMs: +browseMs.toFixed(2),
      searchMs: +searchMs.toFixed(2),
      searchMatches: 11,
      horizontalOverflowAt850: overflow,
      displays,
    };
    mkdirSync(".test-data", { recursive: true });
    writeFileSync(
      ".test-data/desktop-performance.json",
      JSON.stringify(result, null, 2),
      "utf8",
    );
    console.log(JSON.stringify(result, null, 2));
    if (overflow) throw new Error("Layout overflow at minimum window size");
  } finally {
    if (app) await app.close();
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

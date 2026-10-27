import { _electron as electron, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";

async function run() {
  const installDir = resolve(".test-data/installed");
  const exe = join(installDir, "Kanban.exe");
  if (!existsSync(exe))
    throw new Error("Install the test build into .test-data/installed first");
  const dataDir = mkdtempSync(join(tmpdir(), "kanban-upgrade-test-"));
  const db = new Store(join(dataDir, "kanban.db"));
  db.saveLog({ body: "upgrade-preservation-sentinel", date: db.day() });
  db.close();
  const read = async () => {
    const app = await electron.launch({
      executablePath: exe,
      args: [],
      env: { ...process.env, KANBAN_DATA_DIR: dataDir, KANBAN_E2E: "1" },
    });
    try {
      await expect
        .poll(() => app.windows().some((w) => w.url().includes("window=main")))
        .toBe(true);
      const page = app.windows().find((w) => w.url().includes("window=main"))!;
      await page
        .getByRole("heading", { name: "今天，把事情一件件做好" })
        .waitFor();
      return await page.evaluate(async () =>
        (await (window as any).kanban.snapshot()).logs.map((l: any) => l.body),
      );
    } finally {
      await app.close();
    }
  };
  try {
    const before = await read();
    const exitCode = await new Promise<number | null>((res, rej) => {
      const child = spawn(
        resolve("dist/Kanban-0.1.0-Setup.exe"),
        ["/S", "/currentuser", `/D=${installDir}`],
        { windowsHide: true, stdio: "ignore" },
      );
      child.once("error", rej);
      child.once("exit", res);
    });
    if (exitCode !== 0) throw new Error(`Installer exit ${exitCode}`);
    const after = await read();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Upgrade changed saved records");
    const result = {
      installExitCode: exitCode,
      sameVersionOverwrite: true,
      before,
      after,
      dataPreserved: true,
      note: "当前用户安装；真实安装程序覆盖同一版本。数据目录为隔离测试目录。",
    };
    writeFileSync(
      ".test-data/upgrade-result.json",
      JSON.stringify(result, null, 2),
      "utf8",
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    rmSync(dataDir, {
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

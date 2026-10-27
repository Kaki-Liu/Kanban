import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
const dir = mkdtempSync(join(tmpdir(), "kanban-performance-"));
const store = new Store(join(dir, "perf.db"));
try {
  const start = performance.now();
  for (let i = 0; i < 10000; i++)
    store.saveLog({
      body: `工作记录 ${i}：处理告警并记录排查结果，等待项目复核。`,
      date: "2026-10-27",
    });
  const populate = performance.now() - start;
  const saveStart = performance.now();
  store.saveLog({ body: "最新一条记录", date: "2026-10-27" });
  const save = performance.now() - saveStart;
  const loadStart = performance.now();
  const snapshot = store.snapshot();
  const load = performance.now() - loadStart;
  const searchStart = performance.now();
  const results = snapshot.logs.filter((l) => l.body.includes("记录 999"));
  const search = performance.now() - searchStart;
  const reportStart = performance.now();
  store.report({ from: "2026-10-27", to: "2026-10-27", includePending: false });
  const report = performance.now() - reportStart;
  const result = {
    cpu: cpus()[0].model,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    records: snapshot.logs.length,
    populateMs: +populate.toFixed(2),
    saveMs: +save.toFixed(2),
    snapshotMs: +load.toFixed(2),
    searchMs: +search.toFixed(2),
    reportMs: +report.toFixed(2),
    searchMatches: results.length,
    note: "Node.js 数据层实测；桌面启动和渲染另行验证。",
  };
  mkdirSync(".test-data", { recursive: true });
  writeFileSync(
    ".test-data/performance.json",
    JSON.stringify(result, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

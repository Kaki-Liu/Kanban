# Rust 桌面重构

目标：用 Rust/Tauri 替换 Electron 主进程及随包运行时，保留 React 界面和 v0.3.0 的全部业务功能。以实际安装包体积和行为验收判断交付，不承诺未经测量的“几 MB”。

## 运行要求的变化

程序不再携带 Chromium/Node.js，改用 Windows WebView2。已有 WebView2 的电脑可离线安装并使用；缺少时，安装程序联网补装。用户无需 Rust、Node.js、SQLite 或开发工具。完全离线且没有 WebView2 的电脑需要部门先安装微软运行时，不能将小安装包称为对任意 Windows 环境零依赖。

参考：[Tauri Windows 安装说明](https://v2.tauri.app/distribute/windows-installer/)。

## 数据与升级

- 正式数据仍位于 `%APPDATA%\Kanban\kanban.db`，开发及测试使用独立目录。
- 保留原 SQLite 表、JSON 字段、对象 ID、提醒状态及 `.kanban-backup` 格式。
- 新版首次打开已有数据前保存一致数据库快照。正式启动检测同名旧版进程，避免两种桌面框架同时编辑同一数据。
- 新 WebView 的界面缓存与旧 Electron 缓存独立，首次展开偏好使用默认值；项目、笔记、工作流水和 SQLite 中的便签位置不因此清空。

从 Electron 版迁移时：

1. 在旧版设置中导出 `.kanban-backup` 文件。
2. 从旧版托盘菜单选择“退出”；关闭主窗口不会退出程序。
3. 在 Windows“已安装的应用”中卸载旧版。卸载默认保留个人数据，不要手动删除 `%APPDATA%\Kanban`。
4. 安装 Rust 版并启动。它自动读取原数据库，不需要重新录入项目和事项。

新版 NSIS 与旧 Electron 安装器使用不同的安装登记，旧版也可能安装在自定义目录。新版不会自动卸载旧版；直接安装可能遗留重复卸载条目和两套程序，因此本次迁移采用先卸载旧版、再安装新版的步骤。数据库和备份格式兼容已验证，完整卸载及迁移安装过程尚未实机验收，不能据此宣称安装器无缝替换。

后续 Rust 版之间计划使用同一 NSIS 安装体系覆盖升级，业务数据仍独立保存在 AppData；版本间覆盖安装与数据保留需随实际发布验证。本版不提供自动更新。安装路径、安装登记及实际验证范围见 [验收记录](VERIFICATION.md)。

## 实现与验证

| 范围 | 入口 | 验证 |
| --- | --- | --- |
| 事项、记录、提醒、汇报、便签数据 | `src-tauri/src/store.rs` | Rust 单测、与旧 TS Store 对照 |
| 项目流程、校验、Agent 导入、备份恢复 | `src-tauri/src/exchange.rs`、`validation.rs` | 同源 Schema、自定义业务校验、旧数据互读 |
| 窗口、托盘、快捷键、锁屏恢复、文件对话框 | `src-tauri/src/desktop.rs` | 实际 Rust 窗口操作 |
| 界面与 IPC 适配 | `src/renderer/src/desktop-api.ts` | TypeScript、WebView2 界面用例 |

开发命令：`npm run dev`；构建界面：`npm run build:web`；安装包：`npm run dist`。

业务兼容验证使用 `scripts/check-rust-compat.ts`，原实现保留为对照基线。Rust 界面测试使用 `playwright.rust.config.ts`，原 Electron 测试结果不能直接当作 Rust 版通过。开发工具依赖不会进入安装包。最终体积、实际执行结果和未覆盖边界统一记录到 `VERIFICATION.md`。

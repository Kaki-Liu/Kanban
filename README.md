# 本地工作看板

Windows 上离线使用的每日事项、项目进度和工作记录工具。业务数据仅保存在当前电脑，不需要账户、服务器或模型 API Key。v0.4.0 使用 Rust / Tauri 桌面程序，保留原有 React 界面和业务功能，安装包不再携带 Electron 和完整 Chromium。

## 安装与使用

安装包为 `dist/Kanban-<版本>-Setup.exe`，按当前 Windows 用户安装。首次运行进入“今天”页；默认空白，不会自动导入示例任务。

面向 Windows 11 x64，需要 Microsoft Edge WebView2 Runtime。电脑已安装 WebView2 时，可离线安装并使用；缺少时，安装程序会联网下载安装运行时。最终用户不需要 Node.js、Rust、开发工具或本项目源码。安装包体积不包含系统共享的 WebView2，实际大小及验证范围见 [验收记录](docs/VERIFICATION.md)。

- **今天**：新建一次性或重复事项、处理 checklist、查看逾期记录。关闭主窗口后程序驻留托盘，到点弹出提醒；通过托盘菜单退出后停止提醒。
- **日历回顾**：从“今天”页进入二级页面，按月查看事项和工作记录。选择一天可查看或处理历史事项、修改记录、补记当天工作或新增安排；未来周期事项显示为计划预览，不提前创建执行记录。
- **随手记**：首页输入一句工作记录，Enter 保存，Shift+Enter 换行。Ctrl+Alt+J 可从其他软件唤出独立输入框，快捷键可在设置修改。
- **桌面便签**：点击左下角“桌面便签”或托盘菜单开启，默认约 380×560，可拖动标题栏、调整大小和切换置顶。标题和检查子项完整换行，长清单可滚动，窗口可放大至 560×900（受屏幕可用范围限制）。直接勾选今天的 checklist 子项，查看最近两条提醒；全部勾选后可打开事项确认处理结果。关闭主窗口后仍驻留，记住上次位置、大小、置顶和显示状态；点 × 仅隐藏便签。
- **项目**：维护状态、进度及最新进展，保留普通任务看板。程序开发项目可启用六种开发路线、目标与里程碑、下一步推荐和待验收任务；也可让 Agent 填写完整项目文件，预览后一次导入所有项目表单。
- **记录**：编辑工作流水和 Markdown 笔记。普通笔记不会默认进入汇报素材，可创建关联提醒。
- **汇报素材**：选择日期，预览并取消不需要的条目，再复制或导出 Markdown 给外部 Agent。应用不会发送数据或自动生成成果描述。
- **Agent 配置导入**：粘贴 JSON 或选择文件，校验和预览后确认应用。可导出现有配置，让 Agent 修改后再次导入。

程序采用北京时间。工作日指周一至周五；不包含节假日调休。周期事项只生成软件运行当日记录，不补造未运行日期。此前已经生成的未完成事项仍保留。

提醒窗口不抢键盘焦点。关闭提醒不等于完成；稍后提醒默认 10 分钟。关机、休眠或退出期间无法实时弹窗，恢复运行后合并提示当天漏发事项。安全桌面及独占全屏场景不保证置顶。

## Agent 配置

### 完整项目表单（v0.2.1）

在项目页点击“Agent 填写项目”，或在现有项目点击“导入 / 导出项目信息”，可保存结构化模板文件，让 Agent 根据你的描述填写。拿到 JSON 文件后选择文件导入或粘贴，点击“校验并预览”，查看新增／修改、字段前后值和受保护记录，再确认创建或更新。

完整配置覆盖项目名称、说明、负责人、状态、人工进度、最新进展、归档，以及开发流程中的目标范围、路线、协作方式、引导程度、任务数量上限、参与人、里程碑、目标日期、开发任务、依赖、责任边界、跟进日期、沟通／接口／变更和交接包。不需要逐个打开表单填写。

给 Agent 的文件与说明：

- [完整项目模板](examples/project-template.json)：新建项目可从这里填写，包含所有填写位置，使用前替换“待填写”示例。
- [完整项目 JSON Schema](examples/project.schema.json)：机器可读的字段约束。
- [Agent 填写指南](examples/PROJECT_AGENT_GUIDE.md)：可复制提示词、字段说明、新建和更新规则。

新建时可以省略 `project.id`；首次创建后，导出带真实 id 的文件继续更新。从当前项目打开入口时，导入目标绑定当前项目，明确填写其他项目 id 会被拒绝。相同 id 的基本信息按完整配置更新，省略可选字段会恢复默认值；已有项目省略 `workflow` 时保留其流程。流程中的未出现条目和已操作记录继续受到保护。Agent 自报完成或接收不会代替实际验收。

此文件使用 `kind: "kanban-project"`，与下面的日期事项、旧开发流程格式分开。项目配置不包含私人笔记、工作流水、日期事项或周期检查；但包含你明确写入流程的参与人信息和交付物位置，导出前请检查预览。文件不会自动发送给外部 Agent。

### 日期事项与检查配置

把 `examples/kanban.schema.json` 和 `examples/weekly-routine.json` 提供给 Agent，或者将现有配置导出给它修改。

可使用以下提示：

> 请按附带的 Kanban v1 JSON Schema 生成提醒配置。保留已有事项的 id。工作日 09:30 检查运维状态，每周五 17:00 整理汇报素材，时区为 Asia/Shanghai。不填写不存在的 project_id。只返回完整 JSON。

同 id 采用完整配置替换，省略可选字段会恢复默认值；预览会显示字段清空。今天和未来尚未开始的执行记录同步更新；已经勾选、开始、完成、跳过、手动编辑或选择稍后提醒的记录受到保护。日期规则改动可撤销未开始的实例，历史不删除。

JSON Schema 描述结构；应用还会校验真实日期、重复 id、项目存在性和提醒时间等跨字段规则。单次最多 500 条，任意错误阻止整批写入。空配置不能导入。配置不包含暂停状态、历史记录或笔记；完整迁移请使用备份。

### 开发项目与协作（v0.2.0）

项目中的“开发工作台”默认收起，需要时点“展开开发工作台”；每个项目记住上次展开状态，收起不会清空尚未保存的编辑。展开后可启用开发流程，选择新手带做、原型验证、敏捷迭代、持续看板、阶段交付或限定投入。填写本次目标和验收标准，沿里程碑推进；在开发任务中记录责任、依赖、处理结果及交接。详细用法见 [开发流程使用说明](docs/WORKFLOWS.md)。

协作方式可选择个人、小组或跨部门。参与人是本地文字记录，不是账号。接收、验收和沟通确认由你按实际情况登记，不会自动向其他人发送任务或消息。跟进日期可转成原有本地提醒事项。

流程提供给外部 Agent 的任务说明和独立 JSON 配置，可先预览再复制。流程配置按稳定 id 合并，未出现的条目保留，已开始的任务和已完成的里程碑受到保护；修改时从导出文件开始并保留 id。此格式不能用于原有的事项导入入口。普通笔记不会自动进入流程配置或任务说明。流程数据随完整备份一起保存。

开发流程样例见 `examples/development-workflow.json`，结构说明见 `examples/workflow.schema.json`。使用样例前，将 `project_id` 改成目标项目导出配置里的真实 id。Schema 描述结构，应用还会校验依赖、完成依据、交接和真实日期。

既有项目默认继续保持普通项目，启用开发路线不会删除原任务。切换路线也保留现有里程碑和任务。开发任务完成结果进入工作流水，重新完成同一任务不重复增加流水。

## 本地数据与备份

正式版数据库：`%APPDATA%\Kanban\kanban.db`。开发版：`%APPDATA%\Kanban-dev\kanban.db`。数据不存入安装目录。

在设置中导出 `.kanban-backup` 文件。恢复为全量替换，程序会在应用数据目录的 `backups` 中自动保存恢复前备份。损坏或不兼容的文件会被拒绝，恢复失败事务回滚。安装目录与业务数据分开，卸载默认保留个人数据。

从 Electron 版迁移到 v0.4.0，请依次操作：

1. 在旧版设置中导出 `.kanban-backup` 备份。
2. 从旧版托盘菜单选择“退出”；仅关闭主窗口仍会驻留后台。
3. 在 Windows“已安装的应用”中卸载旧版。卸载默认保留个人数据，不要手动删除 `%APPDATA%\Kanban`。
4. 安装并启动新版，新版会自动读取同一路径的数据库，无需重新填写项目或导入所有事项。

两种安装器的安装登记不同，直接安装新版可能留下重复卸载条目和旧程序；新版安装器不会自动卸载 Electron 版。已验证旧数据读取与两版备份互相恢复，跨框架卸载及安装的完整过程尚未实机验收。后续 Rust 版计划通过同一 NSIS 安装器覆盖升级并保留数据，版本间覆盖升级仍需随实际版本验证。此版本不提供自动更新，详细边界见 [迁移说明](docs/RUST_MIGRATION.md)。

首次用新版本打开已有数据时，会先自动保存升级前数据库快照，再进入界面；失败则停止启动。同版本启动不重复备份。v0.1.0 不支持新版开发流程数据，降级请使用升级前备份，勿直接用旧版编辑新版数据。

本地数据库和备份没有独立密码或应用级加密，依赖 Windows 用户和文件权限。开机启动默认关闭，可在安装后自行开启。首版为未签名自用安装包，可能出现 Windows 发布者提示。

## 开发

开发环境：Node.js 22.12+、npm、Rust stable 和 Windows x64。Windows 标准构建使用 Rust MSVC 工具链，需安装 Visual Studio C++ Build Tools 与 Windows SDK；开发运行同样需要 WebView2。以上编译工具仅供开发者使用。

```powershell
npm ci
npm run dev
```

```powershell
npm run typecheck
npm test
npm run test:rust
npm run schema
npm run schema:workflow
npm run schema:project
npm run schema:rust
npm run build:web
npm run test:harness
npm run test:compat
npm run pack
npm run test:e2e
npm run dist
```

`npm run dev` 启动 Tauri 开发版；`npm run build:web` 只构建前端。`npm run pack` 构建本机可执行程序，`npm run dist` 构建当前用户 NSIS 安装包，均自动构建前端。默认产物在 `src-tauri/target/release/`，安装包在其 `bundle/nsis/` 下；指定 Rust target 时，路径中增加对应 target 目录。发包时将 NSIS 产物复制为 `dist/Kanban-<版本>-Setup.exe`。直接分发可执行程序时还需保留同目录的 `WebView2Loader.dll`，部门使用建议发安装包。

本次发布实际使用 `x86_64-pc-windows-gnu` 工具链构建；标准 MSVC 路径未在本轮验证。选择 GNU 时，需另装可用的 x64 GCC 工具链并将 `gcc` 放入 PATH；项目的 `.cargo/config.toml` 仅为该 target 指定 GCC，不改变默认 Rust target。可执行 `rustup target add x86_64-pc-windows-gnu` 后，使用 `npm run dist -- --target x86_64-pc-windows-gnu` 打包。首次构建会下载 Rust crates 和 Tauri 打包工具。

主要分层：`src-tauri/src` 负责 Rust 存储、业务、提醒调度和 Windows 集成；`src/renderer` 保留 React 界面，通过受限的桌面接口调用原生功能；`src/shared` 保存类型与校验契约。`npm run schema:rust` 从这些契约生成 Rust 使用的 JSON Schema，`build:web` 也会自动生成，直接用 Cargo 构建前需确保已同步。正式版使用内嵌前端资源，不启动本地 HTTP 服务。原 `src/main`、`src/preload` 及 Electron 开发依赖保留用于行为对照和迁移回归，不进入 Tauri 安装包；旧版入口为 `dev:electron`、`build:electron` 和 `test:electron-baseline`。

测试自动创建独立临时数据目录，不读写真实个人数据库。`npm test` 保留原有业务与界面逻辑基线；`test:rust` 验证 Rust 业务规则，`test:compat` 对照两版数据行为和备份格式，`test:e2e` 操作 WebView2 窗口。兼容测试前用 `test:harness` 构建专用的 `store-probe`，它不进入正式安装包；界面测试前运行 `pack` 构建桌面程序。测试会查找默认、GNU 或 MSVC 的构建目录，也可分别用 `KANBAN_STORE_PROBE`、`KANBAN_RUST_EXE` 指定对应程序。单元与兼容测试使用可注入时钟，不需要改变系统时间。实际执行结果及尚未覆盖的安装、休眠等边界统一记录在 [验收记录](docs/VERIFICATION.md)。

需求见 [PRD](docs/PRD.md)，实施与验证进度见 [实施计划](docs/IMPLEMENTATION_PLAN.md)。

## 版本管理

源码使用本地 Git 管理，当前版本为 `0.4.0`。没有配置或推送远程仓库。版本变化见 [更新记录](CHANGELOG.md)，测试结果及安装包校验值见 [验收记录](docs/VERIFICATION.md)。

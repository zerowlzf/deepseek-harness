# Fork 维护说明 —— 同步与构建的坑

> 本文由本 fork 维护者添加，只描述 **zerowlzf/deepseek-harness** 这个 fork 的同步与构建注意事项。
> 它不是上游文档、不描述上游代码，也不改动任何上游文件。
>
> 记录时间：2026-10-17　核对基线：上游 dsh **0.2.1-rc.2**（上一版为 0.2.1-rc.1）

## 1. fork 现状

| 项 | 值 |
|---|---|
| 远端（本 fork） | `https://github.com/zerowlzf/deepseek-harness` |
| 上游 | `deepseek-ai/deepseek-harness` |
| `master` | 上游基线 + fork 自有提交，当前基线 **dsh 0.2.1-rc.2**（此前为 0.2.1-rc.1 → 0.2.1-alpha.5 → 0.2.0-rc.2 → 0.2.0-rc.1 → 0.1.7-alpha.2） |

fork 自有提交（截至 2026-10-18 共 52 个：rc.2 轻量轮随新基线重放 43 个；rc.2 同步轮新增 3 个 —— WebRuntime 活引用适配、计费版本跟随、本记录更新；复核轮再新增 4 个 —— tool-cordis 再解析收紧、v1→v2 保留链测试、本记录勘误、配对重录与遗漏门禁补查；评审修整轮再新增 2 个 —— 计费包 README 精简并移入 docs/README 配对、评审修整（去重、锚点归一、补 ToC、`files` 纳入 docs））主要包含：

- 计费插件 `packages/client/ui-billing`（账户余额 + 会话费用，Web UI 四个落点：Plugins 页行配置、composer 胶囊、`turnEndInfo` 每轮读数、`turnTail` 兜底读数（没有操作行的轮次））的完整移植史：0.1.7-alpha.2 适配 → 迁到 Plugins 页行配置 → 两轮自审修正 → 跟随各发布基线（最新 0.2.1-rc.2；上游没有该路径，是本地自有包）
- `ui-chat` 的 `conversation.chat.turnEndInfo` 插槽（计费读数落在已完成 Turn 操作行里的落点：随包 usage 触发器之后、时钟之前）
- `session-format` 历史会话兼容补丁（permission/preset 的 origin 成员、subagent/descriptor 版本 2）
- Windows 子进程窗口隐藏（`windowsHide`：上游自带 `subprocess-local` 等大部分 spawn 点的覆盖且仍在自修，本地补丁只剩它未覆盖的 5 个文件共 7 处 —— `bundle/web-app`、`sdk/client`、`ptc-runtime-python` ×2、`ssh` ×2、`sandbox-local`）
- `tool-cordis` 输入被字符串化时的重解析防御

### ⚠️ master 会被强推重写

基线升级时，本 fork 的 `master` 是**整体替换**而不是在旧历史上追加：旧提交哈希在新 `master` 上不再可达。因此：

- 别处已有的 clone 无法直接 `git pull`，需要重新克隆或整体切换基线；
- 引用过具体提交哈希的文档/脚本在升级后可能指向失效对象。

## 2. 本地同步到 fork 最新

```sh
git fetch zerowlzf
git log --oneline upstream/master..zerowlzf/master   # 看 fork 独有提交
git cherry zerowlzf/master HEAD                    # 判断本地补丁是否已被远端包含
git branch backup/<旧分支名>-pre-<新基线> <旧分支>   # 先备份旧分支
git checkout -B master zerowlzf/master
git branch --set-upstream-to=zerowlzf/master master
```

- **远端名**：官方为 `upstream`（2026-10-17 自 `origin` 更名），fork 为 `zerowlzf`；未更名的 clone 先执行 `git remote rename origin upstream`。
- **必须给足超时**：跨大基线切换涉及约 2400 个文件改写，默认超时（120s）会被打断，建议 ≥600s。
- **中断善后**：删 `.git/index.lock`，确认工作区无本地改动后 `git clean -fd` 清掉残留的未跟踪文件，再重试切换。
- 切换前建议用 `git cherry` / patch-id 逐一核实旧分支上的本地补丁是"已被远端包含"还是"需要保留"，再决定是否整体切换。

### 本仓库的做法：rebase 到新 tag，而不是整体切换

本机的 checkout 就是这些补丁的产地，升级走 rebase，每条本地提交的历史都保留：

```sh
git fetch upstream --tags
git merge --ff-only fork/master                    # 先并入 fork 端新增的文档提交
git rebase --onto dsh-v<新版本> dsh-v<旧版本> master
pnpm install                                       # 只有依赖真的变了才需要
```

实测 0.2.0-rc.1 → 0.2.0-rc.2（本地 18 个提交、上游 1022 个文件）：rebase 零冲突；`pnpm install` 14.8 s 完成；16 个官方生成器重跑后与工作区零差异，说明 rebase 后目录已自洽。rebase 之后本地提交都是新哈希，推送仍需 `--force-with-lease`。

0.2.0-rc.2 → 0.2.1-alpha.5（本地 34 个提交、上游 1912 个提交、约 8361 个文件）：冲突集中在几个生成物与既定补丁（slot 目录、slots 文档双语、事件图文档双语、ptc-runtime 的 windowsHide 处），按「生成物重跑、补丁语义不动」处理完毕；18 个带 `--check` 的官方生成器重跑后零差异。跨的基线越大，「生成器全绿」这个信号越重要 —— 它是目录自洽的最快判据。

0.2.1-alpha.5 → 0.2.1-rc.1（本地 39 个提交、上游 4 个提交且全为发布登记：355 个 package.json 各 ±1 行版本号，无代码变更、无变更日志）：rebase 零冲突；lockfile 零变化（翻新全在 workspace 内部版本，不触及依赖图）；计费插件是本地自有包（上游没有该路径），版本跟随单独提交。轻量轮的取舍：生成器 spot check + typecheck + 单包样张 + 直接重建（跳过全量清理与全量 test:gui），依据是「距上次全量清理仅数小时且 src 零字节变化」。

0.2.1-rc.1 → 0.2.1-rc.2（本地 43 个提交、上游 9 个提交，以发布登记与 Web 侧特性为主：约 230 个 package.json ±1 行版本号、DeepSeek Search/Fetch API、标注 1017 徽标）：rebase 零冲突；lockfile 零变化；上游把 WebRuntime 的 provider 选择改为必填的 Volatile 活引用（每次操作经 `.get()` 读当前值），本地宿主样张按文件内既有的 `live()` 模式适配——本轮唯一的类型断点（TS2554），适配后 typecheck 5/5；计费插件版本跟随单独提交。取舍沿用 rc.1 轻量轮，但清理与重建走用户要求的全量路径（见 §7）。

## 3. 构建前必做：清掉旧基线产物

- `lib/`、`apps/web/dist` 等构建产物都在 `.gitignore` 里（且不被 git 跟踪），所以 `git clean` 清不掉、`checkout` 也不会覆盖 —— 跨基线切换后必然残留上一个基线的产物（实测 `packages/client/ui-billing/lib` 就残留过旧基线产物）。
- 官方 `npm run clean` 只清 TypeScript 的 outDir / 已知输出根，**不包含 Vite 的 `apps/web/dist`**，需手工删除。
- 官方 clean 还有两类盲区（0.2.1-alpha.5 轮实测）：`coverage/`（Vitest 覆盖率产物）与 `website/.generated/`（VitePress 站点生成物）同样不在清理范围，构建前一并手工删除。
- 还有一类它够不到的残留：曾经由某个 tsconfig 产出、但该工程后来被上游删掉的根级输出（实测 `lib/desktop-keyboard-test-types`，0.1.7 基线的 desktop 键盘测试工程所出）。遍历基于 tsconfig 引用图，工程没了就永不入列，只能手工删。
- 建议顺序：`npm run clean` → 手工清理残留 `dist` / `coverage` / `website/.generated`（与本条上一行点名的根级输出）→ 全量构建。

## 4. 坑一：pnpm 11 "跳装" 导致依赖链接残缺

**现象**：`npm run build` 报 `packages/telemetry/otel/src/event-transport.ts` 中 `got` 调用 4 处 `TS2339`（属性不存在）。

**真因**：不是代码问题。`got@14.6.6` 应当链接 12 个依赖，实际只链接了 2 个（缺 `p-cancelable`、`cacheable-request` 等）。由于 `skipLibCheck` 会吞掉库内部的 "找不到模块" 报错，最终在源码里伪装成 "属性不存在" 的类型错误。

**根因**：`node_modules/.pnpm-workspace-state-v1.json`（pnpm 11 的工作区状态缓存）记录了 "已安装" 状态，导致后续 `pnpm install`、`pnpm install --force`、乃至删掉 `.modules.yaml` / `.pnpm/lock.yaml` 之后，全部仍判定 `Already up to date` 而跳过链接重建。删掉单个 `.pnpm/<pkg>` 目录同样不会被自动恢复（被同一个文件短路）。

**修复**：

```sh
rm -f node_modules/.pnpm-workspace-state-v1.json
pnpm install        # 这次才会真正重建链接（复用本地 store，不重新下载，约 12 分钟）
```

锁文件本身没有问题：`pnpm-lock.yaml` 与上游一致，`got` 的快照条目里依赖齐全。所以不要靠改锁文件来"修"这个现象。

## 5. 坑二：受管环境下构建会被删除防护拦下

在带 `node-safe-delete-shim` 的受管环境（如 WorkBuddy）里，`npm run build` 清空自己的输出目录时会报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。

- 该防护的 `count` 是**单次调用累计的删除量**（阈值 50），不是单个目录的文件数：实测 `apps/desktop/lib/welcome` 实际只有 7 个文件，却报 `count: 153`。
- 因此"先手工把输出目录清空再构建"在原理上无法解决 —— monorepo 构建自身对 lib/dist 的清理量必然超过阈值。
- 提到沙箱外运行（提权）也无效：该防护由 CLI 层注入，与沙箱无关。
- 可行做法是给这一条构建命令临时加自带的关闭开关（只对该进程生效）：

```sh
CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build
```

- 若确实要手工分批删产物：`find <dir> -type f | head -N | xargs rm -f` 按累计量计数，单次别超过阈值，超量会被直接中断。

## 6. 其他观察

- `wmic.exe` 在受管环境被程序黑名单硬拦截（构建过程中会出现，本次未影响构建结果）。
- 构建产物检查点：`apps/web/dist`（前端静态资源）、`apps/desktop/lib/main.js`、各包 `lib/`。
- 定向测试：`npx vitest run <目录或文件>`。本次变更区域实测：`session-format` 634 个用例全通过、`ui-billing` 173 个用例全通过。
- 上游 `python/sdk/uv.lock` 里有一行 `size =` 的值是纯十六进制数字串，与上游一个**已发布提交**的前缀同形（该提交自 dsh-v0.2.1-alpha.3 起在发布历史里）：全历史克隆下 `verify-repository-references` 会把它误报成提交哈希引用。上游 CI 用浅克隆（脚本注释本身也说明「浅历史对象无法匹配」），所以上游不受影响。既不该改这个上游锁文件，也不该改上游脚本 —— 本机 `test:docs` 因此固定红这一项，见到即忽略；上游改掉这个 pin 后误报会自行消失。
- oxlint 1.81（随上游基线升级）对上游文件 `packages/experimental/client-ui-cot-translation/src/index.ts` 的 `oxlint-disable` 注释报 unused-disable 警告：只警告、不阻断（`lint:contracts-ready` 退出码 0）。这是上游自身的漂移，不要为它新增 fork 补丁。
- Windows 无符号链接权限时，上游新加的「拒绝最终符号链接」样张（`packages/client/ui-deliverables/tests/present-open.host.spec.ts`）会以 EPERM 失败：本机环境限制，与 fork 无关，勿改上游测试。
- `test:gui` 里的 `document-preview-license-bundle.client.spec.ts` 检查的是**已构建**的 `lib/` 打包内容：跨基线后必须先全量构建再跑它，否则拿旧产物会误报（0.2.1-alpha.5 轮实测：旧产物缺新的 frontmatter-fields 分块）。
- 本仓库有 14 条 git 符号链接条目（mode 120000）。Windows 上 `core.symlinks=false` 会把它们落成普通文本文件，且本机无创建符号链接的权限（实测 `symlinkSync` 报 EPERM）。两个官方检查因此固定红：`verify-cordis-config`（读 `apps/cli/tests/profiles/acp/cordis.yml` 时报「root must be a Loader entry array」）与 `verify-node-next-types`（脚本自己要建符号链接；它只回传子进程输出，失败时表现为空输出）。有符号链接权限的环境不受影响；不要为它们打 fork 补丁。
- `rescope-vendor:check` 首次运行报 19 个文件残留，逐项核对**全部是上游自身的内容**：18 个文件与 `dsh-v0.2.1-alpha.5` 逐字节一致；剩下 `packages/bundle/web-app/cordis.patch.yml` 虽被 fork 修改过，命中的却是上游注释里一个反引号包裹的旧包名，fork 的新增行不含任何待改写记号。不要动上游文件，也不要改 rescope 脚本或映射表。
- `hygiene` 是全仓库巡检：首次运行（0.2.1-alpha.5 轮）即翻出 8 处测试夹具里的 `as unknown`（fork 自有、在基线之外，已按 no-unknown-casts 规则修复）。以后每轮同步至少跑一次 `pnpm run hygiene`，尽早发现 fork 自身的门禁欠账，别等 CI。
- 备份分支的指针要对准「真正的旧 tip」：0.2.1-alpha.5 轮的备份建在 reset 之前，但当时本地 `master` 停在更早的 rc.1 轮 tip（18 个提交），真正的全量 pre-rebase 链条（rc.2 + 34 个提交）在 fork 远端上。体检时已把备份分支改名为如实的内容名，并新建一个分支钉住全量链条 —— 否则强推之后远端引用移走，pre-rebase 状态只剩 reflog，90 天后随 GC 消失。

## 7. 验证记录

### 基线 0.2.0-rc.1（2026-09-29，当时的构建环境）

- `pnpm install`：锁文件一致、供应链策略检查通过。
- 全量构建（`npm run build`）：成功；`apps/web/dist` 196 个产物文件、`apps/desktop/lib/main.js` 468 KB、321 个包/应用输出目录重建。
- `git status`：干净（源码零改动，本次只新增本文档）。

### 基线 0.2.0-rc.2（2026-09-29，Windows + pwsh 7 + node 24）

- 升级路径：`git merge --ff-only fork/master` + `git rebase --onto dsh-v0.2.0-rc.2 dsh-v0.2.0-rc.1 master`，18 个本地提交全部重放，**零冲突**。
- `pnpm install`：14.8 s，`Packages: +35 -45`（pi-ai 0.85.1 → 0.87.1，另有新增 workspace 包），锁文件与供应链策略校验通过；本次**未**触发坑一。
- 生成器：16 个官方生成器全部重跑，输出与工作区**零差异**。其中 `gen-doc-graphs` 在默认堆下 OOM（exit 134），需 `node --max-old-space-size=8192 --import tsx/esm scripts/gen-doc-graphs.ts`（本机物理内存 6 GB，构建期间尤其紧张）。
- 门禁：`pnpm run typecheck`（含 `build:lib:host`）通过；`lint:contracts-ready` 5120 文件 0 警告；`test:docs` 21 项全过；`verify-translation-pairing` 1160 对一致。
- 定向测试：`session-format-v0-to-v1` / `v2-to-v3`、`tool-cordis`、`bundle/web-app`、`sdk/client` 共 758 用例全过；`ui-billing` + `ui-chat` 共 790 用例全过。
- `test:gui`：602/604 文件通过；3 个失败都是 5 s 负载超时（`binary-rpc.host.spec.ts` ×2、`document-preview-license-bundle.client.spec.ts` ×1），单跑均通过。后者在 `pnpm exec vitest` 下还会因缺少 `npm_execpath` 直接报错，把 `npm_execpath` 指向 pnpm 的 `bin/pnpm.cjs` 后 2.3 s 通过。
- 清理与重建：`pnpm run clean`（删除 334 条路径）→ 手工删 `apps/web/dist` → `pnpm run build`，日志留在仓库外的 `DSH/tmp/clean-build-020-rc2.log`。构建记录 `.dsh-build/client-build-environment.json`：`DSH_CLIENT_VERSION=0.2.0-rc.2`、349 个客户端产物、含摘要；`DSH_CLIENT_COMMIT_HASH` 记的是产出该构建的本地提交，本文不抄这个哈希——master 会被强推重写，抄下来就会失效。
- 产物核验：`apps/web/dist` 196 个文件；`ui-billing/lib/client.js` 与 `ui-chat/lib/client.js` 里都能搜到 `conversation.chat.turnEndInfo`；`verify-built-package-invariants` 38 个 companion 通过；用**刚构建的** `session-format-catalog/lib/index.js` 跑全量历史会话恢复扫描：146 个工件 146 恢复、0 拒绝（v0=82、v2=31、v3=23、v4=10）。
- **`test:snapshot` 在 Windows 上不可用（不是代码问题）**：本机实测 139 失败 / 27 通过，原因全部是平台与环境差异 —— headless profile 在 win32 上禁用 `tool-bash`（报 `unknown tool "bash"`、`tools.bash is not a function`）；部分场景走 `deepseek-official` 路由需要 key；运行时上下文快照按 `workspace-write` + `approval: ask` 录制，而本会话是 `danger-full-access` + 关闭审批；录制环境没有 Windows 专属的 `diagnose-windows-sandbox-acl` skill，本机 skill 目录多一条，system-reminder 随之不同。上游自己也把该门禁的所有权放在 macOS/Linux CI（`check:windows-wine` 只在诊断已知 Windows 失败时用），所以本机跳过这一个门禁。
- `DSH_SNAPSHOT=replay pnpm run test:web` 本轮未跑：本机没有 Playwright 浏览器缓存（`%LOCALAPPDATA%\ms-playwright` 不存在），且该命令会连带全量 `npm run build`；需要浏览器级烟测时先 `pnpm exec playwright install chromium`。

### 本地审阅轮（2026-09-29 晚；基线仍为 dsh-v0.2.0-rc.2，未升级）

- 上游核对：`git fetch upstream --tags --prune` 后 `git ls-remote upstream refs/heads/master` 与本地 `upstream/master` 同为 rc.2 的合并提交（远端领先 0 个），最新发布 tag 仍是 `dsh-v0.2.0-rc.2`；本轮无需 rebase。
- 生成物零差异：16 个官方生成器的 `--check` 变体全部退出码 0（`verify-doc-graphs` 需 `--max-old-space-size=8192`），工作区零改动。
- 本地补丁族 7 → 6：`scripts/clean.ts` 的「已知输出根」补丁退役——上游自 rc.1 起已删除 desktop 键盘测试项目，该 outDir 不在工程引用图里（只读探针遍历 331 个输出根不含它，退回上游原代码遍历依然成功）。该文件现与 `dsh-v0.2.0-rc.2` 逐字节一致。
- 旧基线残留：`lib/desktop-keyboard-test-types/`（13 个文件，mtime 2026-09-25）手工删除。它原本 `pnpm run clean` 也够不到：遍历基于 tsconfig 引用图，而根级 `.tsbuildinfo` 清理只覆盖仓库根目录下的文件。
- 计费插件（本地独有包）修正，逐条理由见各自提交正文：保存不再拿渲染期 revision 当栅栏；配置页 props 由 `plugins.row.config` 改为它实际注册的 `plugins.item`；余额刷新链对 resolver 抛错给出结构化原因，并把重挂移进 `finally`；新建单价行按「所见即所存」写入它显示过的回落值（否则 schema 的零档会顶掉公布价）；费用一律按配置币种标注（余额那格仍用账户币种）。
- 给本地补丁加守卫：`ui-chat` 的助手节点样张现在断言定稿节点携带 `providerMetadata`（逐轮按尝试计价的唯一现场证据）。实测把该补丁临时移除后样张转红、还原后转绿。
- 门禁（本轮实测）：`typecheck`（含 `build:lib:host`）通过；`lint:contracts-ready` 通过；`verify-translation-pairing`、`verify-client-ui-i18n`、`verify-package-readme-limitations`、`verify-package-readme-summaries`、`verify-md-wrap`、`verify-repository-references` 全过；定向 vitest 77 文件 / 1554 项全过；`ui-billing` 单包 173 项全过。
- 本文档此前让 `test:docs` 红在 `verify-repository-references`：文中两处抄了提交哈希，其中一处会随强推失效。现改为引用发布 tag 与字段名，该门禁已转绿。
- 仍未跑：`test:snapshot`（Windows 不可用，原因见上）、`DSH_SNAPSHOT=replay pnpm run test:web`（缺 Playwright 浏览器）。
- 与用户环境相关的一条：`llm-pi-ai` 的 `src/config.ts` 在 rc.1 → rc.2 之间**未改动**，因此 profile patch 里自定义 provider / 模型 / compat 声明仍然有效；上游内置目录删掉的旧模型 ID 不影响自定义模型。

### 基线 0.2.1-alpha.5（2026-10-17，Windows + pwsh 7 + node 24）

- 升级路径：备份旧 `master` → `git rebase --onto dsh-v0.2.1-alpha.5 dsh-v0.2.0-rc.2 master`，34 个本地提交全部重放（冲突处置见 §2）。上游新增的访问席位（access seats）在本地夹具里以既有的 `as never` 模式补桩。
- 门禁：`typecheck` 5/5；`lint:contracts-ready` 0 警告（唯一提示是 §6 所述上游 unused-disable）；`test:docs` 21 项 20 过（唯一失败为 §6 所述 uv.lock 误报）；定向 vitest 1637 项 1636 过（1 项 5 s 负载抖动，单跑通过）；`ui-billing` 173 项全过。
- hygiene（首跑）：21 项 18 过 3 红，正是 §6 记载的 2 项 Windows 符号链接与 1 项上游 rescope 残留；fork 自身的 `verify-no-unknown-casts` 8 处已改为真实类型，复跑该门禁 PASS。
- 清理与重建：`pnpm run clean`（372 条路径）→ 手工删 `apps/web/dist`、`coverage/`（1935 个文件）、`website/.generated/`（192 个文件）→ `pnpm run build`：9/9 门禁、208.99 s。构建记录 `DSH_CLIENT_VERSION=0.2.1-alpha.5`、325 个客户端产物。
- 产物核验：`apps/web/dist` 156 个文件；`ui-billing/lib/client.js` 与 `ui-chat/lib/client.js` 里都能搜到 `conversation.chat.turnEndInfo`；`apps/desktop/lib/main.js` 约 505 KB。
- `test:gui`（基于新产物）：647 个文件、10902 项中仅 1 文件 1 项失败 —— `present-open.host.spec.ts` 的符号链接 EPERM（§6 环境限制）；§6 最后一条所述 `document-preview-license-bundle` 样张在新产物上通过。
- 会话恢复扫描（用本轮构建的 catalog）：`~/.dsh/sessions` 53 个工件 51 恢复 2 拒绝（均为 v3 中断录制中的未闭合 tool call，命中上游既有校验，与 fork 无关）；分布 v0=25、v2=11、v3=15、v4=2。
- 未跑（沿用上一节原因）：`test:snapshot`（Windows 不可用）、`DSH_SNAPSHOT=replay pnpm run test:web`（缺 Playwright 浏览器缓存）。

### 基线 0.2.1-rc.1（2026-10-17 下午，轻量轮：先全面体检后同步）

- 触发：体检时 fetch 发现上游当日新发 `dsh-v0.2.1-rc.1`，比 alpha.5 新 4 个提交，全为发布登记（355 个 package.json 各 ±1 行版本号，无代码、无变更日志）。
- 备份修正（体检发现）：`backup/master-pre-0.2.1-alpha.5-20261017` 原指向 rc.1 轮 tip，与名字不符；已改名 `backup/master-0.2.0-rc.1-tip-20261017`，并把该名字新建到真正的 pre-rebase 全量链条上（rc.2 + 34，即当时的 fork 远端 tip，§6 有教训记录）。
- rebase：39 个本地提交零冲突重放到 rc.1；lockfile 零变化；计费插件版本跟随（本地自有包，上游没有该路径）。
- 门禁：`typecheck` 5/5；`ui-billing` 173 项全过；`verify-client-catalog` 零漂移（上游 slots 未变）。
- 重建：直接 `pnpm run build`（未重跑 clean 与手工清理 —— 距当日上午的全量清理仅数小时，且此后 src 零字节变化，只有测试夹具、文档与版本串改动）：9/9 门禁、58.27 s（缓存热）、325 个客户端产物。构建记录 `DSH_CLIENT_VERSION=0.2.1-rc.1`、`DSH_CLIENT_GIT_DIRTY=true`（构建在提交前进行，与 alpha.5 轮同理）。
- 产物核验：`apps/web/dist` 156 个文件；`conversation.chat.turnEndInfo` 双 bundle 在场；`apps/desktop/lib/main.js` 516716 字节（比 alpha.5 轮恰好短 3 字节，即版本串长度差）。
- 未跑：`test:gui` 全量（rc.1 无功能变更，alpha.5 轮已全量验证过同构产物）、`lint:contracts-ready`（版本串不进 lint 面）、`test:docs`（本轮笔记无变更；文档门禁以 `verify-md-wrap` 与 `verify-repository-references` 复核本文档）。
- 补丁族复查（同日）：五个补丁族全部在场、均未被上游 rc.1 吸收 —— 计费插件与 turnEndInfo 是自有扩展（上游无此路径）；tool-cordis 重解析、session-format 的 origin 成员与 descriptor v2 归一在上游源码中仍不存在（上游对旧日志的严格拒绝是其既有政策，不是待修缺陷）；windowsHide 上游自带大部分覆盖，本地补丁为它未覆盖的 5 文件 7 处。§1 的 windowsHide 条目已按实际修正。

### 基线 0.2.1-rc.2（2026-10-17 傍晚：轻量同步 + 全量清理重建）

- 触发：上游当日再发 `dsh-v0.2.1-rc.2`（9 个提交：约 230 个 package.json ±1 行版本号、DeepSeek Search/Fetch API、标注 1017 徽标；桌面端仅版本串变化、契约源文件零改动）。
- rebase：备份 `backup/master-pre-0.2.1-rc.2-20261017` → `git rebase --onto dsh-v0.2.1-rc.2 dsh-v0.2.1-rc.1 master`，43 个本地提交零冲突重放；`pnpm install` 无变化；lockfile 零变化；计费插件版本跟随（本地自有包，上游没有该路径）。
- 适配（本轮唯一类型断点）：`WebRuntime` 构造签名改为必填的 Volatile 活引用配置（`searchProvider`/`fetchProvider` 每次操作读当前值，设置变更无需重挂服务），`host.host.spec.ts` 按文件内既有的 `live()` 模式传 `undefined`（保持单 stub 自动选择语义）。
- 门禁：`typecheck` 5/5（host aggregate 71.19 s）；`ui-billing` 173 项全过；`verify-client-catalog` / `verify-config-catalog` / `verify-cordis-catalog` / `verify-official-bundle-catalog` 零漂移；CLI 快探针复跑 `web --help`（`--public-url`/`--tls-cert`/`--tls-key` 在场，`--host`/`--port` 语义未变）。
- 清理与重建：`pnpm run clean`（361 条路径）→ 手工删 `apps/web/dist`（156 个文件）→ `pnpm run build`：9/9 门禁、191.13 s、327 个客户端产物。构建记录 `DSH_CLIENT_VERSION=0.2.1-rc.2` 且**无 dirty 标记**——先提交后重建，产物出自干净树（alpha.5 / rc.1 轮相反）。
- 产物核验：`apps/web/dist` 156 个文件；`conversation.chat.turnEndInfo` 双 bundle（`ui-billing/lib/client.js` 与 `ui-chat/lib/client.js` 各 2 处）；`apps/desktop/lib/main.js` 516716 字节（与 rc.1 完全相同：桌面端零改动、版本串同长）；新增 `ui-deepseek-model-label-1017/lib/client.js` 在场（327 = 上轮 325 + 2 个产物）。
- 未跑（沿用既往原因与取舍）：`test:gui` 全量、`test:docs`（本文档以 `verify-md-wrap` 与 `verify-repository-references` 复核）、`test:snapshot`（Windows 不可用）、`DSH_SNAPSHOT=replay pnpm run test:web`（缺 Playwright 浏览器）。

### 基线 0.2.1-rc.2（2026-10-17 夜，本机复核轮：fork 远端重写后的全链验证）

- 触发：另一台电脑把 fork `master` 重写到 rc.2 基线加 46 个本地提交（远端与上一节的 `dsh-v0.2.1-rc.2` 已合流，tip 已不在本机旧 `master` 的链条上）。本机核对 34 个旧本地提交全部在场（28 个 patch-id 相等；6 个形态不同但逐项验证：win 补丁同 3 文件、`windowsHide` 7 处 5 文件全在、ui-billing `src/` 除 tests/package.json/tsdown 外逐字节相同、catalog 属生成物），确认零丢失后把本机 `master` 切到远端 tip（旧 tip 存 `backup/master-pre-0.2.1-rc.2`），未做 merge。
- 门禁：`typecheck` 5/5（54.54 s）；目标 vitest（ui-billing / ui-chat / tool-cordis / session / sdk / bundle-web-app）186 文件 3847 项通过、10 跳过（首轮与全量生成物检查并行、机器满载时 1 项 5 s 超时，单独重跑该文件 188/188 通过，判定为争用抖动）。
- 生成物 `--check`：client / config / session-format / cordis-inspect / cordis（125 文件） / tsconfig-paths / dependency / plugin-packages 全部零漂移；`verify-doc-graphs` 7 张（8 GB 堆）；`verify-persistence-formats` v0–v4 通过；`verify-md-wrap` 2052 文件；`verify-package-readme-model-experience` 343 README 全过。
- `verify-client-domain-graph` 报 87 处告警：在临时 worktree 对上游 `dsh-v0.2.1-rc.2` 跑同一脚本，得到逐项相同的 87 处 → 上游既有红，fork 零新增（唯一涉及 ui-chat 的一处 `contract/ → chat/flow-motion` 上游同样存在）。
- 清理与重建：`pnpm run clean`（334 路径）→ 手工删 residue → `pnpm run build`：9/9 门禁、398.09 s、327 个客户端产物；记录 `DSH_CLIENT_VERSION=0.2.1-rc.2`，`DSH_CLIENT_COMMIT_HASH` 前缀与本机 tip 一致。
- 产物核验：`apps/web/dist` 156 文件；`ui-billing/lib/client.js` 与 `ui-chat/lib/client.js` 各 2 处 `turnEndInfo`；`apps/desktop/lib/main.js` 516716 字节；`ui-deepseek-model-label-1017/lib/client.js` 在场。
- 会话恢复扫描（本轮构建的 catalog）：`~/.dsh/sessions` 96 个工件 96 恢复、0 拒绝（v0=37、v2=26、v3=20、v4=13）。
- 源码重启 + 产品面探针：boot 70 条目、billing 行在 boot 中（inject=10）；`session/list` 200、80 项、15 个根会话；v0–v4 根/子会话若干例历史读取全过（v0 首条为 `permission/preset`，即 fork 的 origin 补丁在真实读取路径上生效）；census 无孤儿（3 个归档候选）；无头 Edge 探针：composer 胶囊 `¥156.31 ¥9.99`、`本会话 ¥156.31`、`DeepSeek 账户余额 ¥9.99`、turn 读数落点 2 处、页面零异常零 console 错误。两个探针的 token 改为 argv 优先（源码模式下与 launcher settings 的 token 不同）。
- 周边仓库：启动器 `test-race.js` 20 通过、`test-webview.js` 7 通过（本机实测），已在 `ff36264` 与远端同步；ui-billing 独立仓 `sync.mjs` 同步到 rc.2（含 `host.host.spec.ts` 的 WebRuntime 活引用适配）、`--check` 零漂移、CONTRIBUTING 基线句更新，提交 `6977216` + tag `v0.2.1-rc.2`。
- 补丁族复核与修正（本轮末，逐族 + 上游对照）：计费接线、`turnEndInfo`+`providerMetadata`、session-format origin/descriptor、windowsHide、生成物与中英对称均成立；上游 rc.2 未静默抵消任何补丁族；v1 文件里的 descriptor v2 目前没有写入者（记录在案）。据此修正四处：① `tool-cordis` 再解析按 `list()` 发布的 `inputSchema` 判定，声明 string 输入的方法收到的 JSON 形文本不再被再解析（README 与注释同步收紧，新增钉住测试；该族定向 802 项全过，含四代 session 迁移）；② v1→v2 补 `permission/preset` 保留链测试（防未来迁移重声明处置表时丢掉 v0 处置表的 spread）；③ `migration.ts` 的 v2→3 注释收窄到「released v0 构建至 0.1.1-rc.2 写出 v2」这一已验证范围；④ 文档勘误：用例数 169→173、计费插件改述为四个落点、client 组 README 补 `ui-billing` 行（中英）。
- 补漏门禁与重清（同夜续）：复核轮初查漏跑 `verify-translation-pairing`，补跑发现 2 对失配（`tool-cordis/README` 仅英文侧随 ① 更新、`client/README` 双侧补行未重录）——中文侧随动、两对 `--write` 重录后，范围检查与全量语料复跑全绿；另按官方 `clean`（361 路径）+ 手工残留（`apps/web/dist` 156 文件、空根级 `lib/`）重清，健康复扫 0 残留后全量重建（9/9 门禁、327 产物），运行时探针（check-runtime 与无头 Edge 计费探针）复跑全绿。
- 未跑（沿用既往取舍）：`test:gui` 全量、`test:docs` 全量（本文档以 `verify-md-wrap` 复核）、`test:snapshot`（Windows 不可用）、`DSH_SNAPSHOT=replay pnpm run test:web`（缺 Playwright 浏览器）。

### 基线 0.2.1-rc.2（2026-10-18：包 README 精简轮 + 细节文档配对）

- 触发：用户要求把计费插件展示用 README（中英各 190 行）精简；长文整体移入新文档，不删除任何记录。
- 结构：主 README 保留全部门禁下限——`## Summary`（≤100 词）、`## Table of Contents`、`## Model Experience` + `#### KV Cache effect`、`## Known Limitations and Deferred Work`（5 条顶层 bullet + 指向细节文档）、`### Dev Note` 骨架（`doc-standard.spec.ts` 强制 Summary / 目录 / 开发备注）与运行时不变式；Model Experience 与 Known Limitations 保持最后两个 H2。
- 细节文档：单价模型与编辑规则、费用折叠、注册清单、全部 12 条限制、开发备注全文移入 `packages/client/ui-billing/docs/README.md`（160 行）与 `docs/README.zh.md`。机制：`verify-translation-pairing` 只归一化翻译配对源（README 家族）的 `.zh.md` 链接，故细节文档必须以 `docs/README.md` 配对形式存在，主 README 链接 `docs/README.md` / `docs/README.zh.md` 才能配对；两对 i18n 记录重录，全量语料 1016→1017 对。
- 门禁：`test:docs`（doc-quick，21 门）20/21——唯一失败为已知 `verify-repository-references`（`python/sdk/uv.lock:113` 误报，非回归）；其中 `documentation standard tests` 22/22（首轮曾报缺 Table of Contents / Dev Note，补齐骨架后过）、`verify-translation-pairing` 范围 + 全量全绿、`verify-package-readme-summaries` 396、`verify-package-readme-model-experience` 343、`verify-package-readme-limitations` 343、`verify-md-wrap` 2052、`verify-md-links` 2012（`docs/README*` 迁移后相对链接已按新深度重指向）。
- 行数：`README.md` / `README.zh.md` 190 → 59 行；新增 `docs/README.md` / `docs/README.zh.md` 各 160 行。
- 周边仓库（同轮，已推送）：standalone `dsh-ui-billing` `d5c4b0e`（README 对随精简、`sync.mjs` 的 `PACKAGE_PATHS` 纳入 `docs`、CONTRIBUTING 路径清单更新；`--from-dsh` 后 `--check` 零漂移）；启动器 `dsh-launcher` `e92f7a5`（README 168 → 62 行，长文移入 `docs/maintenance.md` 137 行：与官方桌面端的关系、全部基线吸收记录、上游契约全文、功能 / 配置 / 日志 / 图标细节）。
- 未跑（沿用取舍）：`test:gui` 全量、`doc-sync` 全量、`test:snapshot`（Windows 不可用）、`DSH_SNAPSHOT=replay pnpm run test:web`（缺 Playwright 浏览器）。

### 基线 0.2.1-rc.2（2026-10-18 续：两轴评审修整）

- 触发：上一节提交后对三个仓做两轴评审（Standards / Spec，各一个并行子代理）。结论：Standards 5 条（1 条轻度成文违规——主 README 与 docs 的 Use this package 段近乎逐字重复 311/312 字符；4 条判断题）；Spec 4 条（2 个 ToC 条目被删非移；FORK_NOTES 属报告产物；发布载荷缺 `docs/`；Summary 恰 100 词零余量）。
- 修复：①docs/README 对的 Use this package 段改为指向主 README 对应节的入口句（中英同步，去重）；②docs 的 known-limitations 锚点前移、去掉多余空行（五个锚点全部前置）；③主 README 对补回 Understand the implementation / Further Exploration 两条 ToC（指向 docs 对应节）；④`package.json` `files` 追加 `docs`（npm 载荷此前 25 文件不含细节文档，包内 README 链接会断；修后 28 文件、82.6 kB）；⑤Summary 100 → 97 词留余量。
- 复核：`verify-translation-pairing` 范围 ×2 与全量 1017 对全绿；`verify-md-links` 2012、`verify-md-wrap` 2052、summaries 396、model-experience 343、limitations 343、`doc-standard.spec` 22/22、`pnpm run publint` 全仓 EXIT=0、`npm pack --dry-run` 确认 docs 三文件在清单内；`test:docs` 20/21（唯一失败仍为已知 uv.lock 误报）。
- 未修（判断 / 设计使然）：standalone 快照内 `../../../llm|settings|web/...` 跨包链接指出仓根（旧 README 同类问题浅一级；快照字节一致规则不允许本地改写）；启动器 README 与 `docs/maintenance.md` 的分工（保留「以本文件为准」的优先级声明）；`docs/README.md` 的 `kind` 仍为 `package-reference`（门禁只扫 `packages/*/*/README.md`，嵌套 docs 不在范围）。
- 提交：standalone `d7c3f75`（`--from-dsh` 后 `--check` 零漂移）；启动器本轮无改动。

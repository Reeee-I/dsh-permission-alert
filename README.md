# dsh-permission-alert

DeepSeek Harness（DSH）**权限确认响铃提醒**插件（宿主侧）。

当 Agent 尝试执行「当前沙箱权限模式不足以执行」的操作（向工作区外写文件、把操作升级到 `workspace-write` / `danger-full-access`、运行高风险 Shell 命令等），DSH 会在 Web 界面弹出一个等待用户批准的确认请求。如果用户没盯着屏幕，这个请求很容易被错过，Agent 的整条流程就卡在“等待用户确认”上。

本插件在 DSH **正在等待用户确认**的时间窗口内，用**系统提示音**反复提醒（无需任何外部音频文件），用户一旦批准或拒绝，声音**立即停止**。

---

## 它如何工作（与真实 DSH API 的对应关系）

> ⚠️ 插件开发时若照抄社区教程里的 `ctx.tools.on('beforeExecute')` 是**行不通**的——该 API 在 DSH（Cordis 4）中不存在。本插件的实现基于对本机运行时 Service/Event Catalog 的实测：

真实的工具调用生命周期事件是 `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result`，而「需要用户确认」统一汇入 **approval 服务**（`@deepseek-ai/dsh-user-approval`）：

```
Agent 调用 write/edit/pwsh… 等工具（权限模式不足）
   │
   ▼
approval 服务（session.append → 会话日志）
   │  ┌──────────── 追加审计事件 approval/asked  { id, toolName, reason, callId }
   │  │              （此刻 DSH 开始等待用户 → 插件开始响铃提醒）
   │  ▼
   ctx.waterfall('approval/request', …)   ← Web 端 answerer 认领并弹出确认框
   │
   │  用户点击 允许 / 拒绝 / 取消（或请求被中止）
   │  ▼
   session.append(approval/decided { id, outcome })  ← 插件收到后立即停止响铃
```

- 插件监听宿主事件 `'session/event'`（post-commit 会话事件流），过滤其中的 `approval/asked` 与 `approval/decided` 审计事件。
- 这是**纯观察者**实现：不参与 `approval/request` 瀑布流、不认领请求、不阻塞、不干扰 DSH 自身的权限校验。
- `approval/asked` 的 `toolName` / `reason` 字段用于日志与 `watchTools` 过滤。
- 为什么不用 `approval/request`？Web 端 answerer 会直接“认领”该 waterfall（不调用 `next()`），后注册的监听器不一定被执行；审计事件则与执行顺序无关，语义上就是“开始等待 / 等待结束”两个确定的时间点。
- 沙箱直接 **deny**（没有询问、没有等待）的操作**不会响铃**——没有等待就没有需要提醒的东西，这是刻意为之。

## 功能特性

- 🔔 审批询问到达 → 延迟 0.6s 宽容期（自动决定的询问听不到杂音）→ 开始响铃
- 🔁 每 1.5 秒一声、一轮 5 声；一轮结束仍无人响应则 30 秒后再响一轮；默认最长持续 10 分钟（全部可配置）
- ⏹ 用户批准 / 拒绝 / 取消 → `approval/decided` 到达 → **立即停止**（含正在播放的子进程）
- 🎯 `watchTools` 可按工具名前缀过滤（空 = 全部）；`enabled: false` 一键静默
- 🔊 跨平台系统提示音（Windows PowerShell / macOS afplay·say / Linux paplay·aplay），无外部音频文件；支持自定义命令
- 🧹 资源自动清理：监听器随插件 fiber 销毁，`apply` 返回的 disposer 在卸载时停止所有响铃会话与子进程
- 🔁 会话回放 / 事件去重：已决的 `approval/asked` 不会重复响铃

## 目录结构

```text
dsh-permission-alert/
├── package.json          # DSH bundle 插件元数据（type: module）
├── tsconfig.json         # TypeScript 编译配置（src → lib）
├── cordis.patch.yml      # 插件挂载声明（bundle patch）
├── src/
│   └── index.ts          # 宿主侧插件本体（TypeScript 源码，含详细注释）
└── README.md             # 本文件
```

`npm run build`（tsc）把 `src/index.ts` 编译为 `lib/index.js`，即插件实际加载的入口。

## 安装

### 方式 A：本地开发安装（推荐先这样试）

```powershell
# 在项目根目录执行（用 link: 直接链接源码，改完代码重新 build + 重启 dsh web 即可）
dsh plugin --profile web add link:.\dsh-permission-alert
```

- `dsh plugin` 会把包加入 profile（`%USERPROFILE%\.dsh\profiles\web`）的 `dsh.profile.bundles` 并写入其 `node_modules`
- 完成后**重启 `dsh web`**，再 F5 刷新浏览器
- 如果之后移动了源码目录，必须到新位置重新 `add link:...`（旧链接记录的是绝对路径）
- 安装冲突时可先 `dsh plugin --profile web remove dsh-permission-alert` 再重试

> 提示：若 `add` 时报 `ERR_PNPM_UNEXPECTED_STORE`（store 位置不一致，例如 profile 的 `node_modules` 由旧 pnpm 安装），在 profile 目录（`%USERPROFILE%\.dsh\profiles\web`）执行一次 `pnpm install` 让依赖按当前 store 重新链接，或 `pnpm config set store-dir <旧store路径> --global` 对齐 store 后再试。

### 方式 B：发布到 npm 后安装

```powershell
npm publish
# 任意机器：
dsh plugin --profile web add dsh-permission-alert
```

### 卸载

```powershell
dsh plugin --profile web remove dsh-permission-alert
```

## 配置

所有配置项都有默认值，不开箱也能直接用。默认值见下表：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 全局开关。`false` 时完全静默 |
| `watchTools` | string[] | `[]` | 只对 `toolName` 以任一前缀开头（忽略大小写）的询问响铃；空数组 = 全部 |
| `firstDelayMs` | number | `600` | 宽容期：询问开始多久后响第一声（自动决定的询问在此窗口内被取消，零噪音） |
| `intervalMs` | number | `1500` | 每声间隔 |
| `maxBeeps` | number | `5` | 每轮响几声（0 = 一直响到响应/超时） |
| `repeatDelayMs` | number | `30000` | 一轮结束后若仍无人响应，多久再响一轮（0 = 不重复） |
| `maxTotalMs` | number | `600000` | 单次询问响铃总时长上限（0 = 不限） |
| `sound` | string | `'auto'` | `auto` / `powershell` / `say` / `afplay` / `paplay` / `aplay` / `bell` / `none` |
| `customBeep` | string[] | `null` | 自定义提示音命令 argv（优先于 `sound`） |
| `log` | boolean | `true` | 输出响铃开始/停止日志 |

按 profile 覆盖配置：编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加一段 id-targeted 覆盖，例如：

```yaml
- id: dsh-permission-alert
  config:
    enabled: true
    watchTools: []          # 全部审批询问都提醒
    firstDelayMs: 400
    intervalMs: 1500
    maxBeeps: 4
    repeatDelayMs: 20000
    maxTotalMs: 600000
    sound: auto
```

保存后重启 `dsh web` 生效（改配置 = 插件 fiber 重启，正在进行的响铃会话会立即停止）。

## 声音说明（跨平台，零依赖）

| 平台 | 默认方案 | 说明 |
| --- | --- | --- |
| Windows | `powershell.exe` → `SystemSounds.Exclamation.Play()`，失败则 `[console]::beep(880,240)` | 桌面会话一定有声音；备选方案在 Windows Terminal 里可能只闪视觉铃 |
| macOS | `afplay /System/Library/Sounds/Glass.aiff`，失败则 `say …` | |
| Linux | `paplay` bell.oga，失败则 `aplay` Front_Center.wav | 文件路径因发行版而异，全失败自动降级 |
| 全部 | 降级：向 stdout 写 BEL（`\x07`） | 终端开启响铃才有声，仅调试用 |

播放完全走 `node:child_process.spawn`（非阻塞、`windowsHide`、不等待退出、卸载时 kill）。

## 手动验证

- 最简单的验证方式：让 Agent 执行一个需要升级权限的操作（例如向工作区外写一个文件，触发 `sandbox_permissions` 审批），此时应听到提示音；点击允许/拒绝后声音立即停止。
- 若确认弹窗出现但没声音，先看宿主日志里 `[dsh-permission-alert] ⏳ …` 是否出现：
  - 没出现 → 事件没监听到（确认插件已加入 bundles 且重启过）；尝试把 `sound` 改成 `bell` 并在终端观察 BEL。
  - 出现了 → 声音方案问题，按上表检查/改用 `customBeep`。

## 已知限制

- 只对「有等待」的权限确认响铃；沙箱直接拒绝的操作不响铃（设计如此）。
- 审批策略为 `never`（自动拒绝）或没有可用 answerer 时，询问会瞬间 fail-closed，宽容期会滤掉这期间的任何声音。
- 声音来自宿主机器；无头 / CI 环境通常没有可用音频输出（可用 `log: true` 观察）。
- 插件只读取审计事件中的 `toolName` / `reason` / `id` 等最小字段，不读取工具参数、不修改任何权限判定。

## 开发

```powershell
npm install        # 安装构建期依赖（typescript、@types/node、@deepseek-ai/cordis 类型）
npm run build      # 编译 src/index.ts → lib/index.js
```

构建产物 `lib/index.js` 是插件实际加载入口（`package.json` 的 `main`），`cordis.patch.yml` 是挂载声明，二者均已包含在 `files` 中。

## License

MIT

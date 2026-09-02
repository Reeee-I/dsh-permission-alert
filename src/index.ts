/**
 * dsh-permission-alert —— DeepSeek Harness 权限确认响铃提醒插件（宿主侧）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 问题背景
 * ────────────────────────────────────────────────────────────────────────────
 * DSH 的权限模型是分层的 SandboxMode（read-only / workspace-write /
 * danger-full-access）。当 Agent 尝试执行"当前权限模式不足以执行"的操作
 * （例如向工作区外写文件、运行高风险的 Shell 命令、把某个文件操作升级到
 * workspace-write / danger-full-access）时，DSH 会把一次"审批询问"发给 Web
 * 界面等待用户批准。如果用户没有时刻盯着屏幕，确认弹窗可能被错过，Agent
 * 的整条流程就会一直卡在“等待用户确认”上。
 *
 * 本插件在“DSH 正在等待用户确认”的窗口期内用系统提示音反复提醒（无需任何
 * 外部音频文件），用户一旦批准/拒绝，声音立即停止。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 检测机制（为什么监听这些事件）
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠ 重要：DSH（Cordis 4）里并不存在 "ctx.tools.on('beforeExecute')" 这类
 *   API。真实的工具调用生命周期事件是（见 Service/Event Catalog）：
 *
 *   tools/pre-execute  (waterfall) —— 放行 / 拒绝 / 询问的决策点
 *   tools/execute      (waterfall) —— 实际分发
 *   tools/post-execute (waterfall) —— 归一化结果
 *   tools/result       (emit)      —— 冻结的最终结果
 *
 *   而“需要用户确认”这件事，最终都汇入 approval 服务（@deepseek-ai/
 *   dsh-user-approval）：
 *
 *   approval/request  (waterfall) —— 组合 answerers 询问用户。
 *       ⚠ 它会被 Web 端的 answerer“认领”（直接返回结果、不调用 next()），
 *         后注册的监听器不一定会被执行，因此不适合作为可靠的“观察点”。
 *
 *   真正可靠、与执行顺序无关的观察点，是 approval 服务的**审计事件**：
 *   每次询问都会先向会话日志追加 approval/asked（id / toolName / reason /
 *   callId），得到结果后再追加 approval/decided（id / outcome）。两者通过
 *   'session/event' 事件（post-commit append feed）广播给所有监听者——
 *   这是纯观察者语义，不参与瀑布流、不阻塞、不干扰审批链。
 *
 *   时序：
 *     session.append('approval/asked')   ← 我们在这里开始响铃（带一个
 *                                           宽容延迟，自动决定的请求听不到声）
 *     → Web UI 展示确认弹窗，用户思考 / 点击
 *     session.append('approval/decided') ← 我们在这里立即停止响铃
 *
 *   因此本插件监听：ctx.on('session/event')，过滤 type 为 approval/asked 与
 *   approval/decided 的会话审计事件。（事件负载里的 toolName/reason 还能
 *   告诉我们“是哪个工具 / 为什么需要确认”，用于日志与 watchTools 过滤。）
 *
 *   权限模式（SandboxMode）本身不直接出现在这些事件里——真正的判定发生在
 *   approval 询问之前/之中；本插件只关心“此刻是否在等用户”，这正是
 *   approval/asked → approval/decided 窗口所表达的。被沙箱直接拒绝（没有
 *   询问、没有等待）的操作不会响铃——没有等待，也就没有需要提醒的东西。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 插件形态说明
 * ────────────────────────────────────────────────────────────────────────────
 * - 宿主侧普通 Node ESM 模块（type: module，main: lib/index.js），
 *   导出 { name, apply }（与 dsh-whale-widget 相同的 Cordis 对象插件形态）。
 * - apply(ctx, config)：Cordis 会把插件行的 config 作为第二个参数传入。
 * - 不依赖任何 Service（没有 inject）：只用 ctx.on 监听事件 + node:child_process
 *   播提示音。资源清理：ctx.on 监听器随插件 fiber 自动销毁；apply 返回的
 *   disposer 会在插件卸载时被 Cordis 收集执行（停止所有响铃会话与子进程）。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

/* ============================================================================
 * 一、配置类型与默认值
 * ========================================================================= */

/**
 * 插件对外暴露的配置（全部可选）。写在 profile 的插件行 config: {...} 里，
 * 或通过 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml 做 id-targeted 覆盖。
 */
export interface PluginConfig {
  /** 全局开关：false 时插件完全静默（不监听、不响铃）。默认 true。 */
  enabled?: boolean
  /**
   * 只对 toolName 以列表中任意一项开头（忽略大小写）的审批询问响铃。
   * 空数组 = 对所有审批询问响铃（默认）。例如：['write', 'edit', 'pwsh']。
   */
  watchTools?: string[]
  /** 询问开始后延迟多久响第一声（毫秒）。默认 600。
   *  该延迟用于跳过“瞬间就自动决定”的询问（策略为 never、被中止、
   *  无 answerer 而 fail-closed 等），避免无意义的杂音。 */
  firstDelayMs?: number
  /** 每次响铃之间的间隔（毫秒）。默认 1500（需求：每 1.5 秒一次）。 */
  intervalMs?: number
  /** 每一轮最多响几声。默认 5（需求：连续 3-5 次）。0 = 一直响到用户响应。 */
  maxBeeps?: number
  /** 一轮响完后若用户仍未响应，等待多久开始下一轮（毫秒）。默认 30000。
   *  0 = 不重复（一轮后保持安静，直到用户响应 / 会话结束）。 */
  repeatDelayMs?: number
  /** 单个询问的响铃总时长上限（毫秒），防止“用户永远不响应”时无限响铃。
   *  默认 600000（10 分钟）。0 = 不限。 */
  maxTotalMs?: number
  /**
   * 声音方案：
   *  'auto'        —— 按操作系统自动选择（默认）
   *  'powershell'  —— 强制用 Windows PowerShell 播放提示音
   *  'say' / 'afplay' —— macOS 语音 / 系统音效
   *  'paplay' / 'aplay' —— Linux
   *  'bell'        —— 只写终端 BEL 字符（\x07，通常无音，仅调试用）
   *  'none'        —— 不播放任何声音（保留日志）
   */
  sound?: 'auto' | 'powershell' | 'say' | 'afplay' | 'paplay' | 'aplay' | 'bell' | 'none'
  /**
   * 自定义提示音命令（完整 argv，不含 shell 包装），例如：
   *   ["powershell.exe", "-NoProfile", "-Command", "[console]::beep(880,300)"]
   * 设置后优先于 sound。
   */
  customBeep?: string[] | null
  /** 是否输出日志（console.log）。默认 true。 */
  log?: boolean
}

/** 解析并规范化后的只读配置（apply 启动时计算一次；改配置 = 重启插件）。 */
export interface ResolvedConfig {
  enabled: boolean
  watchTools: readonly string[]
  firstDelayMs: number
  intervalMs: number
  maxBeeps: number
  repeatDelayMs: number
  maxTotalMs: number
  sound: NonNullable<PluginConfig['sound']>
  customBeep: readonly string[] | null
  log: boolean
}

const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  watchTools: [],
  firstDelayMs: 600,
  intervalMs: 1500,
  maxBeeps: 5,
  repeatDelayMs: 30000,
  maxTotalMs: 600000,
  sound: 'auto',
  customBeep: null,
  log: true,
}

const SOUND_KINDS: ReadonlySet<string> = new Set([
  'auto', 'powershell', 'say', 'afplay', 'paplay', 'aplay', 'bell', 'none',
])

/** 把未知来源的原始配置清洗成合法值（数值取整、钳制到非负；非法项回退默认）。 */
function resolveConfig(raw: unknown): ResolvedConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<PluginConfig>

  const num = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : NaN
    return Number.isNaN(n) || n < 0 ? fallback : n
  }
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback

  const sound = typeof src.sound === 'string' && SOUND_KINDS.has(src.sound)
    ? src.sound as ResolvedConfig['sound']
    : DEFAULT_CONFIG.sound

  const custom = Array.isArray(src.customBeep)
    ? src.customBeep.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : null

  return {
    enabled: bool(src.enabled, DEFAULT_CONFIG.enabled),
    watchTools: Array.isArray(src.watchTools)
      ? src.watchTools.filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map((item) => item.toLowerCase())
      : DEFAULT_CONFIG.watchTools,
    firstDelayMs: num(src.firstDelayMs, DEFAULT_CONFIG.firstDelayMs),
    intervalMs: num(src.intervalMs, DEFAULT_CONFIG.intervalMs),
    maxBeeps: num(src.maxBeeps, DEFAULT_CONFIG.maxBeeps),
    repeatDelayMs: num(src.repeatDelayMs, DEFAULT_CONFIG.repeatDelayMs),
    maxTotalMs: num(src.maxTotalMs, DEFAULT_CONFIG.maxTotalMs),
    sound,
    customBeep: custom && custom.length > 0 ? custom : null,
    log: bool(src.log, DEFAULT_CONFIG.log),
  }
}

/* ============================================================================
 * 二、本地类型（与运行时代理接口的最小叶子字段对齐）
 *
 * 我们只读取会话审计事件里需要的最小标量字段，绝不整体复制 live 对象。
 * ========================================================================= */

/**
 * 使 ctx.on('session/event', ...) 在编译期获得参数类型。
 * 运行时该事件由 dsh-session 声明（this: Scoped<Session>, session, event），
 * 这里只做本地最小化声明；若将来与完整 dsh 类型同编，会自动合并为重载。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Post-commit 会话事件 append feed（观察点，emit 模式）。 */
    'session/event'(this: unknown, session: LiveSessionLike, event: LiveSessionEventLike): void
  }
}

/** 会话审计事件负载（approval 服务追加的 SessionEvent.data）。 */
interface ApprovalAuditData {
  /** 审批询问的唯一 id（approval/asked 与 approval/decided 成对出现）。 */
  id?: string
  /** 该询问针对的工具名（如 write / edit / pwsh / cordis …）。 */
  toolName?: string
  /** 工具调用的 callId（当询问方有具体调用时）。 */
  callId?: string
  /** 询问方给出的、面向人类的解释（例如权限判定原因）。 */
  reason?: string
  /** approval/decided 的结果（allowed-once | rejected | cancelled | unavailable）。 */
  outcome?: string
}

/** 'session/event' 携带的最小 live session 视图（只读叶子字段）。 */
interface LiveSessionLike {
  id?: string
  /** 当前会话已提交的事件数组（用于查重：历史已决的 asked 不再响铃）。 */
  events?: ReadonlyArray<{ type?: string; data?: { id?: string } }>
}

/** 'session/event' 携带的最小会话事件视图。 */
interface LiveSessionEventLike {
  type?: string
  data?: ApprovalAuditData
}

/* ============================================================================
 * 三、提示音播放器（跨平台，无外部音频文件）
 *
 * 播放策略：优先系统自带提示音命令（spawn 非阻塞子进程，不等待退出），
 * 依次尝试候选命令，全部失败后降级为终端 BEL 字符。每一声都是一个独立
 * 短进程（约 0.3-1 秒），用户批准后调用 cancel() 立即 kill 当前进程并停止
 * 后续调度。
 * ========================================================================= */

/** 一组平台相关的候选命令（argv 列表；spawn 尝试第一个成功的）。 */
type CommandChain = ReadonlyArray<ReadonlyArray<string>>

// Windows PowerShell：SystemSounds.Exclamation 在桌面会话一定可听；console
// beep 作为备选（在 Windows Terminal 里可能只闪视觉铃）。
const WIN_CMD: CommandChain = [
  ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[System.Media.SystemSounds]::Exclamation.Play()'],
  ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[console]::beep(880, 240)'],
]
// macOS：系统音效 afplay；say 语音兜底。
const MAC_CMD: CommandChain = [
  ['afplay', '/System/Library/Sounds/Glass.aiff'],
  ['say', 'Attention. An action needs your approval.'],
]
// Linux：paplay / aplay（文件路径可能因发行版而异，失败自动换下一个）。
const LIN_CMD: CommandChain = [
  ['paplay', '/usr/share/sounds/freedesktop/stereo/bell.oga'],
  ['aplay', '/usr/share/sounds/alsa/Front_Center.wav'],
]

/** 根据配置与平台构建候选命令链；空链 = 每声只写 BEL（或无声）。 */
function buildCommandChain(cfg: ResolvedConfig, platform: NodeJS.Platform): { chain: CommandChain; bell: boolean } {
  if (cfg.customBeep) return { chain: [cfg.customBeep], bell: false }
  switch (cfg.sound) {
    case 'powershell': return { chain: WIN_CMD, bell: false }
    case 'afplay': return { chain: [MAC_CMD[0]], bell: false }
    case 'say': return { chain: [MAC_CMD[1]], bell: false }
    case 'paplay': return { chain: [LIN_CMD[0]], bell: false }
    case 'aplay': return { chain: [LIN_CMD[1]], bell: false }
    case 'bell': return { chain: [], bell: true }
    case 'none': return { chain: [], bell: false }
    case 'auto':
    default:
      if (platform === 'win32') return { chain: WIN_CMD, bell: false }
      if (platform === 'darwin') return { chain: MAC_CMD, bell: false }
      return { chain: LIN_CMD, bell: true }
  }
}

class BeepPlayer {
  private readonly chain: CommandChain
  private readonly useBell: boolean
  private readonly log: (msg: string) => void
  private readonly children = new Set<ChildProcess>()
  private disposed = false

  constructor(cfg: ResolvedConfig, log: (msg: string) => void) {
    const built = buildCommandChain(cfg, process.platform)
    this.chain = built.chain
    this.useBell = built.bell
    this.log = log
  }

  /** 播放一声：尝试链上的命令，成功即返回；全部失败则降级 BEL。 */
  async play(): Promise<void> {
    if (this.disposed || this.chain.length === 0) {
      if (!this.disposed && this.useBell) this.writeBell()
      return
    }
    for (const argv of this.chain) {
      if (await this.spawnTry(argv)) return
    }
    if (this.useBell) this.writeBell()
  }

  /** 用户已响应 / 插件卸载：立刻结束所有正在响铃的子进程。 */
  cancel(): void {
    for (const child of this.children) {
      try {
        child.kill()
      } catch {
        /* 子进程可能已退出，忽略 */
      }
    }
    this.children.clear()
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  /** 尝试 spawn 一个命令；'spawn' 事件视为成功，'error'（如 ENOENT）视为失败。 */
  private spawnTry(argv: readonly string[]): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(argv[0], argv.slice(1) as string[], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        })
      } catch (err) {
        this.log(`[dsh-permission-alert] 无法启动提示音命令: ${String(err)}`)
        resolve(false)
        return
      }
      this.children.add(child)
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      child.once('error', (err) => {
        this.children.delete(child)
        if (!this.disposed) this.log(`[dsh-permission-alert] 提示音命令不可用，尝试备用方案: ${String(err)}`)
        finish(false)
      })
      child.once('spawn', () => finish(true))
      child.once('exit', () => this.children.delete(child))
      // 不阻塞宿主进程退出
      child.unref()
    })
  }

  /** 最后手段：向宿主 stdout 写 BEL 控制字符（终端开启响铃才有声）。 */
  private writeBell(): void {
    try {
      process.stdout.write('\x07')
    } catch {
      /* stdout 可能已关闭 */
    }
  }
}

/* ============================================================================
 * 四、单个“等待确认”会话的响铃调度
 *
 * 调度节奏（默认值）：
 *   第 0.6s（firstDelayMs，宽容期）  —— 若仍未决定，开始第 1 声
 *   之后每 1.5s（intervalMs）一声，共 5 声（maxBeeps）为“一轮”
 *   一轮结束仍无人响应 → 30s（repeatDelayMs）后再响一轮
 *   最多持续 10 分钟（maxTotalMs），到点自动放弃（防无限响铃）
 * 用户在任意时刻批准/拒绝 → 外部调用 stop()，声音立刻停止。
 * ========================================================================= */

type SessionDone = () => void

class AlertSession {
  private cancelled = false
  private timer: NodeJS.Timeout | null = null
  private readonly cancelWaiters: Array<() => void> = []

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly player: BeepPlayer,
    private readonly log: (msg: string) => void,
    private readonly done: SessionDone,
    readonly toolName: string,
    readonly reason: string | undefined,
  ) {}

  /** 开始调度：先等 firstDelayMs 宽容期（自动决定的询问在此窗口内被取消，零噪音）。 */
  start(): void {
    if (this.cancelled) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runLoop()
    }, this.cfg.firstDelayMs)
  }

  /** 用户已响应（approval/decided 到达）或插件卸载：立即停止。 */
  stop(): void {
    if (this.cancelled) return
    this.cancelled = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const waiters = this.cancelWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** 等待 ms 或直到被 stop() 唤醒；返回 true = 正常超时，false = 被取消。 */
  private wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.cancelled) {
        resolve(false)
        return
      }
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        resolve(ok)
      }
      this.timer = setTimeout(() => finish(true), ms)
      this.cancelWaiters.push(() => finish(false))
    })
  }

  private async runLoop(): Promise<void> {
    const deadline = this.cfg.maxTotalMs > 0
      ? Date.now() + this.cfg.maxTotalMs
      : Number.POSITIVE_INFINITY
    try {
      while (!this.cancelled && Date.now() < deadline) {
        if (this.cfg.maxBeeps <= 0) {
          // maxBeeps=0：无限循环，每 intervalMs 一声，直到用户响应/超时。
          await this.player.play()
          if (this.cancelled || Date.now() >= deadline) break
          const ok = await this.wait(this.cfg.intervalMs)
          if (!ok) break
          continue
        }
        // 一轮：连响 maxBeeps 声，每声间隔 intervalMs。
        for (let i = 0; i < this.cfg.maxBeeps && !this.cancelled; i++) {
          await this.player.play()
          if (this.cancelled) break
          if (i + 1 < this.cfg.maxBeeps) {
            const ok = await this.wait(this.cfg.intervalMs)
            if (!ok) break
          }
        }
        if (this.cancelled || this.cfg.repeatDelayMs <= 0 || Date.now() >= deadline) break
        const ok = await this.wait(this.cfg.repeatDelayMs)
        if (!ok) break
      }
    } catch (err) {
      this.log(`[dsh-permission-alert] 响铃调度异常: ${String(err)}`)
    } finally {
      this.done()
    }
  }
}

/* ============================================================================
 * 五、会话管理器
 *
 * 把 'session/event' 流里的 approval/asked 与 approval/decided 翻译成
 * AlertSession 的 start/stop，并处理：工具名过滤、重复/回放去重、插件
 * 卸载时全量清理。
 * ========================================================================= */

class AlertManager {
  private readonly cfg: ResolvedConfig
  private readonly player: BeepPlayer
  private readonly log: (msg: string) => void
  private readonly sessions = new Map<string, AlertSession>()
  private disposed = false

  constructor(cfg: ResolvedConfig) {
    this.cfg = cfg
    this.log = cfg.log
      ? (msg: string) => { console.log(msg) }
      : () => { /* 日志已关闭 */ }
    this.player = new BeepPlayer(cfg, this.log)
  }

  /**
   * 'session/event' 监听入口（emit 模式，纯观察者）。
   * 注意：session/event 对象是 live 数据，这里只读取 id/type/data 叶子字段。
   */
  onSessionEvent(session: unknown, event: unknown): void {
    if (this.disposed || !this.cfg.enabled) return

    const ev = event as LiveSessionEventLike
    if (typeof ev?.type !== 'string') return
    const data = ev.data ?? {}

    const sessionId = typeof (session as LiveSessionLike)?.id === 'string'
      ? (session as LiveSessionLike).id as string
      : ''
    const id = typeof data.id === 'string' ? data.id : ''
    if (!sessionId || !id) return

    if (ev.type === 'approval/asked') {
      const toolName = typeof data.toolName === 'string' ? data.toolName : ''
      const reason = typeof data.reason === 'string' ? data.reason : undefined
      this.begin(session as LiveSessionLike, sessionId, id, toolName, reason)
    } else if (ev.type === 'approval/decided') {
      const outcome = typeof data.outcome === 'string' ? data.outcome : ''
      this.end(sessionId, id, outcome)
    }
  }

  /** 插件卸载：停止所有响铃会话、杀掉所有提示音子进程。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.player.dispose()
  }

  // ---------- 内部实现 ----------

  private key(sessionId: string, id: string): string {
    return `${sessionId}\u0000${id}`
  }

  private begin(session: LiveSessionLike, sessionId: string, id: string, toolName: string, reason: string | undefined): void {
    // 工具名过滤：watchTools 非空时只关心匹配前缀的询问。
    if (this.cfg.watchTools.length > 0) {
      const name = toolName.toLowerCase()
      const hit = this.cfg.watchTools.some((prefix) => name.startsWith(prefix))
      if (!hit) return
    }

    // 去重（会话回放 / 事件重复）：若该 id 在会话日志里已出现 approval/decided
    // （历史已决），则这是一条迟到的 asked，不再响铃。
    if (this.isAlreadyDecided(session, id)) return

    const k = this.key(sessionId, id)
    if (this.sessions.has(k)) return // 同一 id 已开始

    if (this.cfg.log) {
      this.log(`[dsh-permission-alert] ⏳ ${toolName || '未知工具'} 需要你的确认${reason ? ` —— ${reason}` : ''}，开始响铃提醒`)
    }
    const alert = new AlertSession(
      this.cfg, this.player, this.log,
      () => { this.sessions.delete(k) }, // done：调度自然结束（超时）时移除
      toolName, reason,
    )
    this.sessions.set(k, alert)
    alert.start()
  }

  private end(sessionId: string, id: string, outcome: string): void {
    const k = this.key(sessionId, id)
    const alert = this.sessions.get(k)
    if (!alert) return
    this.sessions.delete(k)
    alert.stop()
    if (this.cfg.log) {
      this.log(`[dsh-permission-alert] ✅ 确认请求已处理（${outcome || '已决定'}），停止响铃`)
    }
  }

  /** 在会话事件尾部（最近 ~200 条）查该 id 是否已有 decided，避免回放误响。 */
  private isAlreadyDecided(session: LiveSessionLike, id: string): boolean {
    const events = session?.events
    if (!Array.isArray(events)) return false
    const max = Math.min(events.length, 200)
    for (let i = events.length - 1; i >= events.length - max; i--) {
      const item = events[i]
      if (!item || typeof item !== 'object') continue
      if (item.type === 'approval/decided' && item.data?.id === id) return true
      if (item.type === 'approval/asked' && item.data?.id === id) return false
    }
    return false
  }
}

/* ============================================================================
 * 六、插件导出（Cordis 对象插件）
 * ========================================================================= */

export const name = 'dsh-permission-alert'

/**
 * 插件主入口。Cordis 以 (ctx, config) 调用；config 来自 profile 插件行的
 * config 字段（见 README）。
 *
 * 依赖说明：本插件不读取任何 Service（因此不声明 inject），只使用
 * ctx.on 监听 'session/event'，以及 node:child_process 播放系统提示音。
 *
 * @returns 卸载 disposer：插件被禁用/热更新/移除时由 Cordis 收集执行，
 *          立即停止所有响铃并清理子进程（满足“资源自动清理”要求）。
 */
export function apply(ctx: Context, rawConfig: unknown = {}): () => void {
  const cfg = resolveConfig(rawConfig)
  const manager = new AlertManager(cfg)

  // 监听会话事件流（post-commit append feed）——监听器随插件 fiber 自动销毁。
  ctx.on('session/event', (session: unknown, event: unknown) => {
    manager.onSessionEvent(session, event)
  })

  if (cfg.enabled && cfg.log) {
    console.log('[dsh-permission-alert] 已启用：将在审批询问等待期间响铃提醒')
  }

  // 卸载时：停止所有响铃会话 + 终止提示音子进程。
  return () => manager.dispose()
}

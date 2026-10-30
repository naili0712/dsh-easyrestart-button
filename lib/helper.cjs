'use strict'

/**
 * dsh-easyrestart-button — 分离 helper。
 *
 * 由 host 半用「桌面应用本身 + ELECTRON_RUN_AS_NODE=1」启动，因此不依赖系统
 * Node，也不依赖 `dsh` 在 PATH 里。它是交接期间唯一能活过宿主的东西，所以
 * 整件事由它做完：
 *
 *   1. 等一小会儿，让 host 的 HTTP 响应先送达浏览器；
 *   2. 结束 Electron 主进程 —— 故意不带 /T：host 子进程必须活下来，才能在
 *      IPC 断开后走自己的优雅关闭（`application.shutdown`），把会话日志
 *      正常落盘。带 /T 会把 host 一起强杀，那才是真的会丢数据；
 *   3. 等主进程消失，再等监听端口释放（用「连接」探测，不用「绑定」——
 *      试探性绑定恰恰会占住替代进程要用的那个端口）；
 *   4. 端口迟迟不放时兜底：先清掉残留的桌面进程（helper 自己、已经结束的主进程与
 *      **host** 都排除在外），端口若仍被占，才单独结束 host —— 它本该自己优雅退出，
 *      所以这一步是最后手段，代价（它的会话日志可能不完整）会如实写进日志；
 *   5. 用干净的环境拉起新实例 —— 必须去掉 ELECTRON_RUN_AS_NODE，否则新的
 *      「应用」会以 Node 模式启动，变成一个没有窗口的进程；
 *   6. 新实例立刻退出就再试，试完还不行才认输并弹窗叫人手动打开 —— 否则
 *      用户只会看到窗口再也没回来，而日志里写着「已拉起」。
 *
 * 还有一条贯穿全程的原则：**「问不出来」不等于「没有」**。tasklist 查不到进程时
 * 返回 null 而不是空列表，调用方据此区分「这个进程已经没了」与「进程表读不到」——
 * 后者若被当成前者，就会跳过结束主进程，随后在旧实例还活着时再拉起一个。
 *
 * 用法：node helper.cjs <handoff.json>
 * 所有诊断写入 handoff 里指定的 logPath；这个进程的 stdio 是 ignore。
 */

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

/** 主进程消失的等待上限。 */
const MAIN_EXIT_TIMEOUT_MS = 15000
/** 端口释放的等待上限。 */
const PORT_FREE_TIMEOUT_MS = 30000
/** 默认的交接前等待。 */
const DEFAULT_DELAY_MS = 1500
/** 默认的拉起尝试次数。存活判据现在由主窗口与崩溃日志共同决定，不再用固定秒数。 */
const DEFAULT_RELAUNCH_ATTEMPTS = 3
/** 两次拉起尝试之间的间隔。 */
const RELAUNCH_RETRY_GAP_MS = 1500
/** 新实例接管端口的等待上限。 */
const PORT_RELISTEN_TIMEOUT_MS = 20000
/** 主进程结束后，等 Host 自己退出的上限。它要在这段时间里把 cookie 库与凭据写完。 */
const HOST_EXIT_TIMEOUT_MS = 20000
/** Host 退出后再静置一会儿，给文件系统落盘。 */
const HOST_SETTLE_MS = 2000
/** 新实例主窗口出现的等待上限。 */
const WINDOW_READY_TIMEOUT_MS = 30000
/** 新实例要稳定存活多久，才算「界面真的回来了」。 */
const SHELL_STABLE_MS = 12000
/** 能把「新实例崩没崩」看出来的观察窗口。 */
const CRASH_WATCH_MS = 15000
/** 启动握手失败时，自动隔离 cookie 库并重试的次数。 */
const COOKIE_RECOVERY_ATTEMPTS = 1
/** 查进程表的超时（PowerShell 冷启动约 1 秒，留足余量）。 */
const PROCESS_QUERY_TIMEOUT_MS = 8000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 从 `netstat -ano` 的输出里挑出「回环（或通配）地址上正在 LISTEN 的 TCP 行」。
 *
 * 用来回答一个问题：**新拉起的实例到底接没接上界面**。0.2.1-rc.2 起桌面版不再
 * 固定用 19387 —— 每次启动挑一个空闲端口（实测 19387 → 14246 → 8418 → 10317），
 * 所以「等旧端口回来」这个判据已经失效，只能反过来找「谁在听」。
 *
 * 解析不出来返回 `null`，与 `tasklist` 那条同一条原则：**「问不出来」不等于
 * 「没有」**。调用方据此说「无法确认」，而不是报「没接回端口」。
 * @param {string} text - `netstat -ano` 的原始输出。
 * @returns {{ port: number, pid: number }[] | null} 监听条目，或 null 表示读不懂。
 */
function parseNetstatListeners(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/u.exec(line)
    if (match === null) continue
    if (!/^(?:127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|\[::\])$/u.test(match[1])) continue
    const port = Number(match[2])
    const pid = Number(match[3])
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue
    rows.push({ port, pid })
  }
  return rows
}

/** 比较路径时统一分隔符、大小写与尾部分隔符。 */
function normalizePath(value) {
  return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

/**
 * 按 Windows 的规则把命令行拆成参数。
 *
 * 只需要处理常见的两种写法：引号包裹、以及引号里的 `\"`。刻意不实现完整的
 * 反斜杠连写规则 —— 遇到 `\"` 时调用方会直接放弃复用原始参数（见
 * {@link relaunchArgsFrom}），所以这里不需要为罕见形态承担有损解析的风险。
 * @param {string} text - 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
function tokenizeCommandLine(text) {
  const tokens = []
  let current = ''
  let started = false
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '"') {
      current += '"'
      started = true
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * 从主进程的命令行里取出「除可执行文件之外」的启动参数。
 *
 * 重启必须把原来的参数带上：否则一个用 `--user-data-dir` 或别的开关启动的
 * 实例，重启后会悄悄变成默认形态。拿不准就返回 null —— 调用方退回「不带参数
 * 拉起」，也就是 0.1.x 的行为，绝不会因为解析而拉错东西。
 * @param {string | null | undefined} commandLine - 主进程命令行。
 * @param {string} exe - 期望的可执行文件绝对路径。
 * @returns {string[] | null} 参数数组（可能为空），或 null 表示放弃复用。
 */
function relaunchArgsFrom(commandLine, exe) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return null
  // 带转义引号的命令行不做有损解析，直接放弃。
  if (commandLine.includes('\\"')) return null
  const tokens = tokenizeCommandLine(commandLine)
  if (tokens.length === 0) return null
  if (normalizePath(tokens[0]) !== normalizePath(exe)) return null
  const args = tokens.slice(1)
  // 同一个可执行文件有好几种身份：主进程、host、渲染/GPU 子进程都用它。
  // 带上 `--type=` 或 `--expose-internals` 说明抓到的是 Chromium 子进程或宿主，
  // 那不是「用户当初怎么启动这个应用」的答案 —— 宁可退回不带参数。
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null
  }
  return args
}

/**
 * 兜底清理时应当结束哪些 pid。
 *
 * 兜底强杀原先按映像名匹配，会连「同名但来自别的目录」的副本一起杀掉。
 * 有了可执行文件路径就只杀同一份程序；拿不到路径的条目一律不动。
 *
 * `skip` 是「不能混在残留进程里顺手杀掉」的那几个 pid：helper 自己、已经结束的
 * 主进程，以及 **host**。host 用的是同一个可执行文件，但它必须有机会自己优雅退出
 * （会话日志要靠它落盘）——所以它由 {@link performRestart} 在端口迟迟不放时单独、
 * 显式地处理，而不是被这条批量清理顺手带走。
 * @param {{ pid: number, path: string | null }[]} processes - 进程表。
 * @param {string} exe - 目标可执行文件。
 * @param {(number | undefined)[]} [skip] - 不参与批量清理的 pid。
 * @returns {number[]} 应当结束的 pid。
 */
function leftoverPids(processes, exe, skip = []) {
  const wanted = normalizePath(exe)
  const skipSet = new Set((Array.isArray(skip) ? skip : []).filter((pid) => Number.isInteger(pid) && pid > 0))
  const pids = []
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 0) continue
    if (typeof entry.path !== 'string' || entry.path === '') continue
    if (normalizePath(entry.path) !== wanted) continue
    if (skipSet.has(entry.pid)) continue
    pids.push(entry.pid)
  }
  return pids
}

/**
 * 查同名进程的 pid、可执行文件路径与命令行。
 *
 * 用 `-EncodedCommand` 送脚本：Windows 上把带引号的 PowerShell 脚本塞进
 * `-Command` 的转义规则很容易出错，base64 完全绕开它。任何失败都返回 null，
 * 调用方各自退回保守行为（不复用参数、按映像名兜底）。
 * @param {string} exeName - 映像名（含扩展名）。
 * @returns {{ pid: number, path: string | null, commandLine: string | null }[] | null} 进程表，或 null。
 */
function queryApplicationProcesses(exeName) {
  const safeName = String(exeName).replace(/'/gu, "''")
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    `Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  let out = ''
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      break
    } catch (error) {
      out = ''
      if (error && error.code !== 'ENOENT') return null
    }
  }
  const text = out.trim()
  if (text === '') return []
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((entry) => ({
      pid: Number(entry?.ProcessId),
      path: typeof entry?.ExecutablePath === 'string' ? entry.ExecutablePath : null,
      commandLine: typeof entry?.CommandLine === 'string' ? entry.CommandLine : null,
    })).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return null
  }
}

/**
 * 重启没成功时叫人手动打开应用。
 *
 * 只在「主进程已经结束、新实例又起不来」这条路上出现 —— 那时窗口再也不会
 * 回来，日志没人看，弹窗是唯一能把话说到用户眼前的办法。尽力而为：弹不出来
 * 就算了，绝不因此影响别的流程。
 * @param {string} text - 提示内容。
 * @returns {boolean} 是否已把请求发出去。
 */
function alertUser(text) {
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, 'DeepSeek Harness') | Out-Null`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch {
      /* 换下一个 shell */
    }
  }
  return false
}

/**
 * 交接并重启。
 * @param {object} handoff - 交接描述。
 * @param {(line: string) => void} note - 诊断写入。
 * @returns {Promise<void>} 完成（无论成功或已记录失败）。
 */

/**
 * 主窗口现在是不是最大化。
 *
 * 为什么要问：DSH 自己不保存窗口状态（userData 里没有 window-state），
 * helper 用 spawn 拉起的新实例只能拿到默认尺寸。所以重启前记一下，
 * 重启后再用 Win32 还原，用户就不会每次重启都被缩回默认大小。
 *
 * 失败一律当作「不是最大化」：读不到窗口状态不该影响重启本身。
 * @param {number} pid - Electron 主进程。
 * @returns {boolean} 最大化时为 true。
 */
function windowIsMaximized(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const script = [
    `Add-Type -Namespace DshW -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);'`,
    '$p = Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue',
    'if ($p -and $p.MainWindowHandle -ne 0) { [DshW.U]::IsZoomed($p.MainWindowHandle) } else { "False" }',
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 6000, windowsHide: true })
    return out.trim().toLowerCase().startsWith('true')
  } catch {
    return false
  }
}

/**
 * 把新实例的主窗口还原成最大化。
 *
 * 新进程要先有窗口句柄（MainWindowHandle 非 0）才谈得上还原，所以这里等一等：
 * 最多约 12 秒，拿不到就放弃 —— 重启已经成功了，窗口大小不值得再报错。
 * @param {number} pid - 新拉起的 Electron 主进程。
 * @param {(line: string) => void} note - 诊断写入。
 */
function restoreMaximized(pid, note) {
  if (!Number.isInteger(pid) || pid <= 0) return
  const script = [
    `Add-Type -Namespace DshW -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'`,
    'for ($i = 0; $i -lt 48; $i++) {',
    '  $p = Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue',
    '  if ($p -and $p.MainWindowHandle -ne 0) { [DshW.U]::ShowWindow($p.MainWindowHandle, 3) | Out-Null; "OK"; break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    note('maximize restore: ' + out.trim().slice(0, 40))
  } catch (error) {
    note('maximize restore failed: ' + String((error && error.message) || error))
  }
}

/** 桌面壳的 userData 目录；推不出来返回 null。 */
function desktopUserDataDir() {
  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || appData === '') return null
  return path.join(appData, '@deepseek-ai', 'dsh-desktop')
}

/**
 * sinceMs 之后新出现的 host 崩溃日志。
 *
 * 这是「新实例到底有没有握手成功」最可靠的证据：壳崩在 `startup` 阶段时，
 * Electron 会先写一份 `crash-…-host.log` 再退出，比「进程还在不在」稳。
 * 目录读不了返回 null —— 与 tasklist 同一条原则，不把「问不出来」当「没有」。
 * @param {string} logsDir - 日志目录。
 * @param {number} sinceMs - 起始时刻（毫秒）。
 * @returns {string[] | null} 新出现的文件名，或 null。
 */
function newCrashLogs(logsDir, sinceMs) {
  try {
    const hits = []
    for (const name of fs.readdirSync(logsDir)) {
      if (!/^crash-.*-host\.log$/u.test(name)) continue
      try {
        if (fs.statSync(path.join(logsDir, name)).mtimeMs >= sinceMs) hits.push(name)
      } catch {
        /* 观察期间被删掉的文件不算数 */
      }
    }
    return hits
  } catch {
    return null
  }
}

/**
 * 新实例主窗口的状况。
 *
 * 只问主窗口句柄，不问端口：17:55 那次事故里，host 子进程先把端口监听起来，
 * 壳却还要再过几秒才握手 —— 端口在听不等于界面回来了。
 * @param {number} pid - 新实例主进程。
 * @returns {'window' | 'running' | 'gone' | 'unknown'} 窗口已出现 / 进程在但没窗口 / 进程没了 / 问不出来。
 */
function windowStateOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone'
  const script = [
    '$ProgressPreference="SilentlyContinue"',
    `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { "gone" } elseif ($p.MainWindowHandle -ne 0) { "window" } else { "running" }',
  ].join('; ')
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 6000, windowsHide: true }).trim().toLowerCase()
    if (out === 'gone' || out === 'window' || out === 'running') return out
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 等新实例把主窗口交出来。
 * @param {number} pid - 新实例主进程。
 * @param {number} timeoutMs - 等待上限。
 * @returns {Promise<'window' | 'gone' | 'timeout' | 'unknown'>} 结果。
 */
async function waitForWindow(pid, timeoutMs) {
  const by = Date.now() + timeoutMs
  let last = 'unknown'
  while (Date.now() < by) {
    const state = windowStateOf(pid)
    if (state === 'window') return 'window'
    if (state === 'gone') return 'gone'
    last = state
    await sleep(700)
  }
  return last === 'running' ? 'timeout' : 'unknown'
}

/**
 * 把桌面壳的 cookie 库备份走，让下一次启动自己重建。
 *
 * 这是启动握手失败的已知解药：壳在 `desktop welcome` 那一步被 401 回绝时，
 * 换掉 `Network/Cookies` 后就能重新换票。只搬 cookie，不碰 profile 其余文件；
 * 备份留成带时间戳的目录，随时可以还原。
 * @param {string | null} dataDir - 桌面壳 userData 目录。
 * @param {(line: string) => void} note - 诊断写入。
 * @returns {boolean} 是否真的搬走了至少一个文件。
 */
function quarantineCookies(dataDir, note) {
  if (dataDir === null) {
    note('cookie recovery skipped: the desktop userData directory is unknown')
    return false
  }
  const networkDir = path.join(dataDir, 'Network')
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const backupDir = path.join(dataDir, `Network.bak-cookie-${stamp}`)
  let moved = 0
  for (const name of ['Cookies', 'Cookies-journal']) {
    const from = path.join(networkDir, name)
    if (!fs.existsSync(from)) continue
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      fs.copyFileSync(from, path.join(backupDir, name))
      fs.rmSync(from, { force: true })
      moved += 1
    } catch (error) {
      note(`could not quarantine ${name}: ${String((error && error.message) || error)}`)
    }
  }
  if (moved > 0) note(`quarantined ${String(moved)} cookie file(s) into ${backupDir}`)
  else note('cookie recovery found nothing to quarantine')
  return moved > 0
}

async function performRestart(handoff, note) {
  const mainPid = Number(handoff.mainPid)
  const exe = String(handoff.exe ?? '')
  const hostPid = Number(handoff.hostPid)
  const port = Number(handoff.port)
  const delayMs = Number(handoff.delayMs) > 0 ? Number(handoff.delayMs) : DEFAULT_DELAY_MS
  const attempts = Number(handoff.relaunchAttempts) > 0 ? Number(handoff.relaunchAttempts) : DEFAULT_RELAUNCH_ATTEMPTS
  // 各段等待上限都可以被交接描述覆盖：冒烟测试要靠它把「端口迟迟不放」「窗口一直不出现」
  // 这类路径在几百毫秒内跑完，而不是真的等满正式值。缺省仍是正式的那几个值。
  const mainExitTimeoutMs = Number(handoff.mainExitTimeoutMs) > 0 ? Number(handoff.mainExitTimeoutMs) : MAIN_EXIT_TIMEOUT_MS
  const portFreeTimeoutMs = Number(handoff.portFreeTimeoutMs) > 0 ? Number(handoff.portFreeTimeoutMs) : PORT_FREE_TIMEOUT_MS
  const portRelistenTimeoutMs = Number(handoff.portRelistenTimeoutMs) > 0 ? Number(handoff.portRelistenTimeoutMs) : PORT_RELISTEN_TIMEOUT_MS
  const hostExitTimeoutMs = Number(handoff.hostExitTimeoutMs) > 0 ? Number(handoff.hostExitTimeoutMs) : HOST_EXIT_TIMEOUT_MS
  const hostSettleMs = Number(handoff.hostSettleMs) >= 0 ? Number(handoff.hostSettleMs) : HOST_SETTLE_MS
  const windowTimeoutMs = Number(handoff.windowTimeoutMs) > 0 ? Number(handoff.windowTimeoutMs) : WINDOW_READY_TIMEOUT_MS
  const shellStableMs = Number(handoff.shellStableMs) > 0 ? Number(handoff.shellStableMs) : SHELL_STABLE_MS
  const crashWatchMs = Number(handoff.crashWatchMs) > 0 ? Number(handoff.crashWatchMs) : CRASH_WATCH_MS
  const cookieRecoveryAttempts = Number.isInteger(handoff.cookieRecoveryAttempts) && handoff.cookieRecoveryAttempts >= 0
    ? handoff.cookieRecoveryAttempts
    : COOKIE_RECOVERY_ATTEMPTS
  const alertOnFailure = handoff.alertOnFailure !== false
  // 重启前记下窗口状态（DSH 自己不持久化它）。
  const wasMaximized = windowIsMaximized(mainPid)
  if (wasMaximized) note('main window is maximized; will restore after relaunch')

  /** 进程是否还活着（信号 0 只做存在性检查）。 */
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * 端口上是否有人监听。
   * @param {number} p - 端口。
   * @returns {Promise<boolean>} 有人应答时为 true。
   */
  const listening = (p) => new Promise((resolve) => {
    let settled = false
    const probe = net.connect({ host: '127.0.0.1', port: p })
    const finish = (value) => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(value)
    }
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    probe.setTimeout(500, () => finish(false))
  })

  /**
   * 强杀一个 pid。
   * @param {number} pid - 目标。
   * @returns {boolean} taskkill 是否成功。
   */
  const killPid = (pid) => {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 解析 tasklist 的 CSV 输出。只取 `"名字","pid"` 这种 ASCII 结构，
   * 因此中文系统上的提示行不会干扰解析。
   *
   * **查不出来返回 `null`，不是空数组。** 「没有这个进程」和「问不出来」是两件事：
   * 把后者当成前者，会得出「主进程已经没了」的错误结论，于是跳过结束主进程这一步，
   * 后面就会在旧实例还活着的时候再拉起一个。
   * @param {string[]} args - 传给 tasklist 的参数。
   * @returns {{ image: string, pid: number }[] | null} 进程列表，或 null 表示查不出来。
   */
  const tasklist = (args) => {
    try {
      const out = execFileSync('tasklist', args, { encoding: 'utf8', windowsHide: true })
      return [...out.matchAll(/"([^"]*)","(\d+)"/gu)]
        .map((match) => ({ image: match[1], pid: Number(match[2]) }))
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
    } catch {
      return null
    }
  }

  /**
   * 目标 pid 当前的映像名，用于确认它确实是我们要结束的那个进程。
   * @param {number} pid - 目标。
   * @returns {{ known: boolean, image: string | null }} `known: false` 表示查不出来
   *   （不是「这个进程不存在」）；`known: true` 且 `image: null` 才是它确实已经不在了。
   */
  const imageNameOf = (pid) => {
    const rows = tasklist(['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'])
    if (rows === null) return { known: false, image: null }
    const found = rows.find((entry) => entry.pid === pid)
    return { known: true, image: found === undefined ? null : found.image }
  }

  /** 当前所有同名桌面应用进程（含 helper 自己）；查不出来时回 null。 */
  const applicationPids = () => {
    if (exe === '') return []
    const rows = tasklist(['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/FO', 'CSV', '/NH'])
    return rows === null ? null : rows.map((entry) => entry.pid)
  }

  /**
   * 当前所有「在回环地址上 LISTEN 的端口」及其归属进程；netstat 不可用时回 null。
   * @returns {{ port: number, pid: number }[] | null} 条目，或 null 表示问不出来。
   */
  const listListening = () => {
    try {
      const out = execFileSync('netstat', ['-ano'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
      })
      return parseNetstatListeners(out)
    } catch {
      return null
    }
  }

  note(`helper started: helper=${process.pid} host=${hostPid} main=${mainPid} port=${port} exe=${exe}`)

  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    note('refusing: the handoff carries no usable main process id')
    return
  }
  if (exe === '') {
    note('refusing: the handoff carries no application executable')
    return
  }

  // 1. 先让浏览器拿到「已排程重启」的响应。
  await sleep(delayMs)

  // 1b. 趁主进程还活着，问一次它的命令行与可执行文件路径：重启要带上原参数，
  //     兜底强杀也要按路径认人。查不到就走老路，不影响重启本身。
  const processes = queryApplicationProcesses(path.basename(exe))
  const mainEntry = Array.isArray(processes) ? processes.find((entry) => entry.pid === mainPid) ?? null : null
  const relaunchArgs = relaunchArgsFrom(mainEntry?.commandLine, exe)
  note(relaunchArgs === null
    ? 'launch arguments unavailable; relaunching with no arguments'
    : `preserving ${String(relaunchArgs.length)} launch argument(s): ${JSON.stringify(relaunchArgs)}`)

  // 2. 确认目标身份，然后结束主进程（不带 /T）。
  const expected = path.basename(exe).toLowerCase()
  const probe = imageNameOf(mainPid)
  if (probe.known && probe.image !== null && probe.image.toLowerCase() !== expected) {
    note(`refusing: pid ${mainPid} is "${probe.image}", not "${expected}"`)
    return
  }
  if (!probe.known) {
    // 问不出进程表（tasklist 不可用之类）：身份核不了，但目标 pid 是宿主亲口给的。
    // 这里照样结束它 —— 不结束的话，下面会在旧实例还活着的时候再拉起一个。
    note(`could not read the process table; ending pid ${mainPid} without an image-name check`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  } else if (probe.image === null) {
    note(`main process ${mainPid} is already gone; skipping the kill`)
  } else {
    note(`ending the Electron main process ${mainPid} ("${probe.image}") without /T, so the host can close gracefully`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  }

  // 3. 等主进程消失。
  const goneBy = Date.now() + mainExitTimeoutMs
  while (Date.now() < goneBy && alive(mainPid)) await sleep(200)
  note(alive(mainPid) ? `main process still alive after ${mainExitTimeoutMs}ms` : 'main process exited')

  // 4. 等端口释放；迟迟不放就兜底清理残留进程。
  if (Number.isInteger(port) && port > 0) {
    const freeBy = Date.now() + portFreeTimeoutMs
    while (Date.now() < freeBy && await listening(port)) await sleep(300)
    if (await listening(port)) {
      note(`port ${port} is still held; terminating leftover application processes`)
      // 优先只杀「同一份可执行文件」的进程（同名但来自别的目录的副本不动）；
      // 一条路径都拿不到时才退回按映像名匹配 —— 那是唯一还能把应用救回来的办法。
      // host 与主进程、helper 自己都排除在外：host 另有单独的一步（见下）。
      const skip = [process.pid, mainPid, hostPid]
      const own = Array.isArray(processes) ? leftoverPids(processes, exe, skip) : null
      let candidates
      if (own !== null && own.length > 0) {
        candidates = own
      } else {
        const byImage = applicationPids()
        if (byImage === null) {
          note('the process table is unavailable; no leftover process could be identified')
          candidates = []
        } else {
          note(own === null ? 'process paths unavailable; falling back to image-name matching' : 'no matching executable path; falling back to image-name matching')
          candidates = byImage.filter((pid) => !skip.includes(pid))
        }
      }
      for (const pid of candidates) {
        note(`killing leftover pid ${pid}`)
        killPid(pid)
      }
      await sleep(1500)

      // 最后一道，且只有这一道会碰到 host：端口到现在还没放，说明卡住的正是它 ——
      // 它本该在主进程消失后自己优雅退出。到这里只能结束它，代价是它的会话日志
      // 可能不完整，所以先如实写进日志；它绝不混在上面那批「残留进程」里被顺手带走，
      // 免得日志读起来像「host 一直活着」。
      if (Number.isInteger(hostPid) && hostPid > 1 && hostPid !== process.pid && hostPid !== mainPid
        && await listening(port) && alive(hostPid)) {
        note(`the host (pid ${hostPid}) still holds port ${port}; ending it as a last resort — its session logs may be incomplete`)
        note(killPid(hostPid) ? `taskkill /PID ${hostPid} /F ok` : `taskkill /PID ${hostPid} /F reported an error`)
        await sleep(1500)
      }
    } else {
      note(`port ${port} released`)
    }
  }

  // 4b. 等 Host 真正退出，再静置一会儿。
  //
  // 旧版只等「端口释放」，端口一空就拉起新实例。但 Host 退出前还要把 cookie 库、
  // 凭据和会话日志写完；这个窗口被压到最短时，新壳可能读到一半的状态，然后卡在
  // `desktop welcome` 的握手 401 上（2026-10-30 连续 6 次启动失败就是这条路径）。
  if (Number.isInteger(hostPid) && hostPid > 1 && hostPid !== process.pid) {
    const hostGoneBy = Date.now() + hostExitTimeoutMs
    while (Date.now() < hostGoneBy && alive(hostPid)) await sleep(200)
    note(alive(hostPid)
      ? `the host (pid ${String(hostPid)}) is still alive after ${hostExitTimeoutMs}ms; continuing anyway`
      : `the host (pid ${String(hostPid)}) exited`)
  }
  if (hostSettleMs > 0) {
    await sleep(hostSettleMs)
    note(`settled ${String(hostSettleMs)}ms after the host exit barrier`)
  }

  // 5. 拉起新实例，并且用「窗口出现 + 没有新崩溃日志」判断它到底成没成。
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    // Node 模式下这两个变量会跟着继承；不清掉，新实例会变成一个没有窗口的进程。
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'DSH_DESKTOP_NODE_EXECUTABLE') delete env[key]
  }

  const dataDir = desktopUserDataDir()
  const logsDir = dataDir === null ? null : path.join(dataDir, 'logs')
  const quietPids = [process.pid, mainPid, hostPid]

  /**
   * 拉起一次，并判断界面到底有没有回来。
   *
   * 与旧版最大的区别：不再把「进程还活着」当成成功。新实例的 host 子进程会先
   * 监听端口，壳却可能还要几秒才握手；17:55 那次就是端口已在听、壳随即崩掉，
   * 旧判据却写了「restart complete」。现在要同时满足：主窗口出现，以及观察窗口
   * 内没有新增 crash 日志。
   * @param {string} label - 写进日志的轮次名。
   * @returns {Promise<{ pid: number | null, reason: string }>} 结果。
   */
  const launchAndVerify = async (label) => {
    const launchedAt = Date.now()
    let spawned = null
    try {
      const child = spawn(exe, relaunchArgs ?? [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.dirname(exe),
        env,
      })
      child.on('error', (error) => note(`relaunch failed: ${String((error && error.message) || error)}`))
      spawned = child.pid
      child.unref()
      note(`relaunched "${exe}" as pid ${String(spawned)} (${label})`)
    } catch (error) {
      return { pid: null, reason: `spawn threw: ${String((error && error.stack) || error)}` }
    }
    if (!Number.isInteger(spawned)) return { pid: null, reason: 'spawn returned no pid' }

    // 5a. 等主窗口。窗口没出来之前，不谈「重启成功」。
    const windowState = await waitForWindow(spawned, windowTimeoutMs)
    if (windowState === 'gone') {
      const crashes = logsDir === null ? null : newCrashLogs(logsDir, launchedAt)
      const detail = crashes !== null && crashes.length > 0 ? ` (crash log: ${crashes.join(', ')})` : ''
      return { pid: null, reason: `the new process was gone before its window appeared${detail}` }
    }
    if (windowState === 'timeout') note(`window not observed within ${String(windowTimeoutMs)}ms; continuing to watch crash logs`)
    if (windowState === 'unknown') note('the new process window state could not be read (powershell unavailable?)')
    if (wasMaximized) restoreMaximized(spawned, note)

    // 5b. 稳定观察：进程还在，且没有新增崩溃日志，才算稳。
    const watchBy = Math.max(launchedAt + shellStableMs, Date.now() + crashWatchMs)
    while (Date.now() < watchBy) {
      if (!alive(spawned)) return { pid: null, reason: 'the new process exited during the stability window' }
      const crashes = logsDir === null ? null : newCrashLogs(logsDir, launchedAt)
      if (crashes !== null && crashes.length > 0) {
        return { pid: null, reason: `the new instance wrote a crash log: ${crashes.join(', ')}` }
      }
      await sleep(500)
    }
    if (windowState === 'window') return { pid: spawned, reason: 'window ready' }
    return { pid: spawned, reason: `window_state=${windowState}` }
  }

  const baseAttempts = Math.max(attempts, 1)
  const recoveryAttempts = Math.max(cookieRecoveryAttempts, 0)
  const totalAttempts = baseAttempts + recoveryAttempts
  let childPid = null
  let lastReason = 'not attempted'
  let recovered = false

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (attempt > 1) {
      note(`relaunch attempt ${attempt}/${totalAttempts} in ${RELAUNCH_RETRY_GAP_MS}ms`)
      await sleep(RELAUNCH_RETRY_GAP_MS)
    }
    const outcome = await launchAndVerify(`attempt ${attempt}/${totalAttempts}`)
    if (outcome.pid !== null) {
      childPid = outcome.pid
      break
    }
    lastReason = outcome.reason
    note(`attempt ${attempt} did not take: ${outcome.reason}`)

    // 5c. 启动握手失败的已知解药：把坏掉的 cookie 库备份走，让下一轮重建。
    // 只在失败明显发生在启动阶段时才做 —— 进程没起来、或写了 startup 崩溃日志。
    const looksLikeStartupFailure = /crash log: crash-|gone before its window|exited during the stability window/u.test(outcome.reason)
    if (!recovered && recoveryAttempts > 0 && looksLikeStartupFailure) {
      recovered = true
      note('the new instance failed during startup authentication; quarantining the cookie store')
      quarantineCookies(dataDir, note)
      await sleep(1500)
    }
  }

  if (childPid === null) {
    note(`the restart did not take after ${String(totalAttempts)} attempt(s); the application is not running (last: ${lastReason})`)
    if (alertOnFailure) {
      note(alertUser(`重启失败：应用没能自动打开。请手动启动 DeepSeek Harness（日志：${String(handoff.logPath ?? '')}）。`)
        ? 'failure notice dispatched to the user'
        : 'could not dispatch the failure notice')
    }
    return
  }

  // 成功后顺手记一下它的监听端口，便于人核对；这不再是「成功」的判据。
  const listenBy = Date.now() + Math.min(portRelistenTimeoutMs, 5000)
  let readyPort = null
  while (Date.now() < listenBy) {
    const entries = listListening()
    if (entries !== null) {
      const sameImage = applicationPids()
      if (sameImage !== null) {
        const candidates = entries.filter(
          (entry) => sameImage.includes(entry.pid) && !quietPids.includes(entry.pid),
        )
        if (candidates.length > 0) {
          readyPort = candidates[0].port
          break
        }
      }
    }
    await sleep(500)
  }
  const portNote = readyPort === null ? '' : `; listening on port ${readyPort}`
  note(`restart complete: the main window is up on pid ${String(childPid)}${recovered ? ' (after cookie recovery)' : ''}${portNote}`)
}

/**
 * 脚本入口：读交接描述，然后动手。
 * @returns {Promise<void>} 完成。
 */
async function start() {
  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') {
    process.exit(1)
  }

  let handoff
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))
  } catch {
    process.exit(1)
  }

  const logPath = String(handoff.logPath ?? '')
  /**
   * 追加一行诊断。日志不可写时静默——诊断失败不该拖垮重启本身。
   * @param {string} line - 内容。
   */
  const note = (line) => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 没有日志也要继续 */
    }
  }

  try {
    await performRestart(handoff, note)
  } catch (error) {
    note(`helper failed: ${String((error && error.stack) || error)}`)
  }
}

if (require.main === module) {
  start().catch(() => { process.exitCode = 0 })
}

module.exports = {
  normalizePath,
  tokenizeCommandLine,
  relaunchArgsFrom,
  leftoverPids,
  parseNetstatListeners,
  queryApplicationProcesses,
  performRestart,
}

/**
 * 异步跑子进程（**不要用 `execFileSync`**）。
 *
 * 为什么：扩展的 `execute` 跑在 agent-host 的 Node event loop 上。`execFileSync` 会**阻塞**
 * 这个 event loop；而主进程每 15s ping 一次、10s 没响应就判定 host 死掉并重启（见
 * pi-desktop `host-manager.ts` 的 PING_INTERVAL_MS / PING_TIMEOUT_MS）。于是「编译 / 探针构建」
 * 这类 >10s 的同步子进程 = 触发 `agent-host ping timeout — killing`，**那次工具调用直接丢失**。
 *
 * 这里统一用异步 `execFile`（Promise 化），并在出错时把 stdout/stderr 挂回 error 上，
 * 方便调用方按需展示（与原 `execFileSync` 的 catch 用法兼容）。
 */
import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 超时（毫秒），默认 5 分钟。 */
  timeoutMs?: number;
  /** 输出上限，默认 64MB。 */
  maxBuffer?: number;
}

export function runAsync(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 300_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as Error & { stdout?: string; stderr?: string };
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * 把同一个 key 上的任务串行化（前一个结束——无论成败——再跑下一个）。
 *
 * 用途：同一回合可能有**多个并行 tool call**，它们会同时去构建**同一个探针工程**；
 * 并发 `dotnet build` 会有锁/还原冲突的风险。串行化后第二个调用会等第一个建完，
 * 再在锁内重新判断 `probeUpToDate` → 直接跳过。
 */
const chains = new Map<string, Promise<unknown>>();

export function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  chains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

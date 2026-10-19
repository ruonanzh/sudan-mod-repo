/**
 * .NET SDK 探测（**共享**：check_runtime 与 install_runtime 都用这一份，避免两边各写一套后漂移）。
 *
 * 判据：能在本机跑起来、且 `dotnet --version` 有输出的 dotnet 可执行文件。
 * 候选覆盖「PATH → 用户级 ~/.dotnet → 系统级」——用户级是 install_runtime 推荐的装法，
 * 默认**不在 PATH 上**；只看 PATH 会导致「按指引装完仍被判缺 SDK」，所以必须都探。
 *
 * 多个候选都在时选**主版本最高**的：用户级的新 SDK 不该被 PATH 上的旧版本顶掉。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export interface DotnetProbe {
  found: boolean;
  /** 例如 "8.0.404" */
  version: string | null;
  major: number | null;
  /** 实际可执行文件路径（**总是尽量给完整路径** ✓：来自 PATH 的裸名会被解析成绝对路径 ✓）*/
  path: string | null;
}

/** 所有可能要探的 dotnet 位置（顺序仅用于展示，最终按版本选优） */
export function dotnetCandidates(): string[] {
  const bin = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const out = ["dotnet"]; // PATH
  out.push(join(os.homedir(), ".dotnet", bin));
  if (process.platform === "win32") {
    out.push("C:\\Program Files\\dotnet\\dotnet.exe");
    if (process.env.LOCALAPPDATA)
      out.push(join(process.env.LOCALAPPDATA, "Microsoft", "dotnet", "dotnet.exe"));
  } else if (process.platform === "darwin") {
    out.push("/usr/local/share/dotnet/dotnet");
  }
  return [...new Set(out)];
}

/**
 * PATH 里的**裸文件名** → 绝对路径 ✓（自己扫 PATH，**不启子进程** ✓ —— 免得冻住 agent-host 的 event loop ✗）
 * · Windows 看 `PATHEXT`（.EXE / .CMD / … ✓）；POSIX 直接找同名文件 ✓
 * · 找不到返回 null ✓（调用方退回裸名 ✓ 行为与以前一致 ✓）
 */
export function resolveOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function runVersion(p: string): string | null {
  try {
    return execFileSync(p, ["--version"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const parts = (v: string): number[] => v.split(".").map((n) => parseInt(n, 10) || 0);

/** 版本号比较（a - b 的符号）；用于从多个 dotnet 里选最高的那个 */
function cmpVersion(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 探一次 .NET SDK：所有候选各跑一次 `--version`，选版本最高的那个。 */
export function probeDotnet(): DotnetProbe {
  const found: { path: string; version: string }[] = [];
  for (const raw of dotnetCandidates()) {
    // ⭐ 裸名（PATH 候选）先解析成**完整路径** ✓ —— 否则落库成 "dotnet" ✗，
    //    之后在**不带 PATH** 的进程里 execFile("dotnet") 会跑不起来 ✗（U42 B1 那条 ✓）
    const c = raw === "dotnet" || raw === "dotnet.exe" ? (resolveOnPath(raw) ?? raw) : raw;
    if (c !== "dotnet" && c !== "dotnet.exe" && !existsSync(c)) continue;
    const v = runVersion(c);
    if (v) found.push({ path: c, version: v });
  }
  if (found.length === 0) return { found: false, version: null, major: null, path: null };
  found.sort((a, b) => cmpVersion(b.version, a.version));
  const best = found[0];
  return { found: true, version: best.version, major: parts(best.version)[0] ?? null, path: best.path };
}

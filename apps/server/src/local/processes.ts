// この PC で動いているプロセスの一覧（pid・親の pid・実行ファイル名）。
// Windows の CreateToolhelp32Snapshot を bun:ffi で直接呼ぶ（PowerShell を起動するより速く、約 30ms）。
// 対象は Windows 11 だけ。ほかの OS では空の一覧を返し、生きているかの判定は process.kill に任せる。

import { platform } from "node:os";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** 実行ファイル名（例：claude.exe）。大文字・小文字は OS が返したまま */
  name: string;
}

export type ProcTable = Map<number, ProcInfo>;

const TH32CS_SNAPPROCESS = 0x2;
/** PROCESSENTRY32W の大きさ（x64）。th32ProcessID は 8、th32ParentProcessID は 32、szExeFile は 44 バイト目から */
const ENTRY_SIZE = 568;
const OFF_PID = 8;
const OFF_PPID = 32;
const OFF_NAME = 44;
// INVALID_HANDLE_VALUE（-1）は ptr として 2^64-1 に近い数で返る

type Kernel32 = {
  CreateToolhelp32Snapshot: (flags: number, pid: number) => unknown;
  Process32FirstW: (h: unknown, entry: unknown) => number;
  Process32NextW: (h: unknown, entry: unknown) => number;
  CloseHandle: (h: unknown) => number;
};

let kernel32: { symbols: Kernel32; ptr: (b: Uint8Array) => unknown } | null | undefined;

async function loadKernel32(): Promise<typeof kernel32> {
  if (kernel32 !== undefined) return kernel32;
  if (platform() !== "win32") return (kernel32 = null);
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const lib = dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  kernel32 = { symbols: lib.symbols as unknown as Kernel32, ptr: (b) => ptr(b) };
  return kernel32;
}

const decoder = new TextDecoder("utf-16le");

/** 今動いているプロセスの一覧。取れなければ空 */
export async function snapshotProcesses(): Promise<ProcTable> {
  const out: ProcTable = new Map();
  const k = await loadKernel32();
  if (!k) return out;
  const h = k.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (typeof h !== "number" || h <= 0 || h >= 2 ** 63) return out;
  try {
    const buf = new Uint8Array(ENTRY_SIZE);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, ENTRY_SIZE, true);
    const p = k.ptr(buf);
    let ok = k.symbols.Process32FirstW(h, p);
    while (ok) {
      let end = OFF_NAME;
      while (end < ENTRY_SIZE - 1 && (buf[end] || buf[end + 1])) end += 2;
      const pid = dv.getUint32(OFF_PID, true);
      out.set(pid, { pid, ppid: dv.getUint32(OFF_PPID, true), name: decoder.decode(buf.subarray(OFF_NAME, end)) });
      ok = k.symbols.Process32NextW(h, p);
    }
  } finally {
    k.symbols.CloseHandle(h);
  }
  return out;
}

/** pid から親へ、最大 depth 段たどる（自分を含む）。途中で一覧にない pid に当たれば止める */
export function ancestors(table: ProcTable, pid: number, depth = 8): ProcInfo[] {
  const out: ProcInfo[] = [];
  const seen = new Set<number>();
  let cur = table.get(pid);
  while (cur && out.length < depth && !seen.has(cur.pid)) {
    out.push(cur);
    seen.add(cur.pid);
    cur = cur.ppid ? table.get(cur.ppid) : undefined;
  }
  return out;
}

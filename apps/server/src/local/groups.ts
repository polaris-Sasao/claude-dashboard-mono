// セッションを起動元ごとのまとまりに分ける（docs/plan.md の「まとまり」）。
// 判定は entrypoint と、Claude Code のプロセスから親へたどった実行ファイル名で行う。
// Windows 11・Claude Code 2.1.319／2.1.321 で確かめた形（2026-11-10）：
//   VS Code の拡張      claude.exe ← 窓ごとの拡張機能用 Code.exe ← VS Code 本体
//   VS Code のターミナル claude.exe ← シェル ← ターミナル用 Code.exe（窓をまたいで共有）← VS Code 本体
//   Windows Terminal   claude.exe ← シェル ← WindowsTerminal.exe（窓・タブをまたいで共有）
//   Claude Desktop     claude.exe ← Desktop の本体

import type { GroupKind } from "@kanseishitsu/shared";
import type { ProcInfo } from "./processes";

export interface GroupKey {
  groupId: string;
  kind: GroupKind;
}

const lower = (s: string) => s.toLowerCase();

/**
 * @param chain Claude Code 自身から親へたどったプロセス（先頭が Claude Code）。取れなければ空
 */
export function classify(entrypoint: string | null, chain: ProcInfo[]): GroupKey {
  const ep = entrypoint ?? "";
  if (ep === "claude-vscode") {
    // 親（拡張機能用の Code.exe）が窓ごとに分かれる。親が分からなければ、そのセッションだけのまとまりにする
    const parent = chain[1];
    return { groupId: parent ? `vscode:${parent.pid}` : `vscode:pid-${chain[0]?.pid ?? "unknown"}`, kind: "vscode" };
  }
  if (ep === "claude-desktop") return { groupId: "desktop", kind: "desktop" };
  if (ep === "cli") {
    const names = chain.slice(1).map((p) => lower(p.name));
    // 近い親から順に見る。VS Code の中で開いた Windows Terminal などは、近いほうを採る
    for (const n of names) {
      if (n === "code.exe") return { groupId: "vscode-terminal", kind: "vscode-terminal" };
      if (n === "windowsterminal.exe") return { groupId: "windows-terminal", kind: "windows-terminal" };
    }
  }
  return { groupId: `other:${ep || "unknown"}`, kind: "other" };
}

const KIND_ORDER: Record<GroupKind, number> = { vscode: 0, "vscode-terminal": 1, "windows-terminal": 2, desktop: 3, other: 4 };

export function groupOrder(a: { kind: GroupKind; firstStartedAt: string }, b: { kind: GroupKind; firstStartedAt: string }): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.firstStartedAt.localeCompare(b.firstStartedAt);
}

/** まとまりの見出し。VS Code の窓は、その窓のセッションの作業フォルダの名前を補足に出す */
export function groupLabel(kind: GroupKind, groupId: string, projects: string[]): { label: string; sub: string } {
  const uniq = [...new Set(projects.filter(Boolean))];
  switch (kind) {
    case "vscode":
      return { label: "VS Code", sub: uniq.join(" ・ ") };
    case "vscode-terminal":
      return { label: "VS Code ターミナル", sub: "" };
    case "windows-terminal":
      return { label: "Windows Terminal", sub: "" };
    case "desktop":
      return { label: "Claude Desktop", sub: "" };
    default:
      return { label: "そのほか", sub: groupId.replace(/^other:/, "") };
  }
}

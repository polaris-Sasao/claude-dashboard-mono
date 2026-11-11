// 表示用の変換（プロジェクト名・モデル名）

export function projectFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "(不明)";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** モデル ID・表示名から画面のラベル（例：Opus 5.5）を作る */
export function modelLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.toLowerCase().match(/(opus|sonnet|haiku|fable)[-\s]?(\d+)(?:[-.](\d{1,2}))?(?![\d])/);
  if (!m) {
    // Agent ツールの model 指定（sonnet・opus など、版を含まない別名）
    const alias = raw.toLowerCase().match(/^(opus|sonnet|haiku|fable)$/);
    return alias ? alias[1]!.charAt(0).toUpperCase() + alias[1]!.slice(1) : raw;
  }
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";

export function modelFamily(label: string | null | undefined): ModelFamily {
  const l = (label ?? "").toLowerCase();
  if (l.includes("opus")) return "opus";
  if (l.includes("sonnet")) return "sonnet";
  if (l.includes("haiku")) return "haiku";
  if (l.includes("fable")) return "fable";
  return "other";
}

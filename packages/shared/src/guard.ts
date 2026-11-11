// フェーズ4：危険操作のガード。PreToolUse で Bash・PowerShell のコマンドを判定する。
// 判定はエージェントが手元で行う（監視サーバーに問い合わせないので、監視サーバーが止まっていても判定できる）。
// 誤検知を減らすため、引用符の中の文字列（コミットメッセージなど）とヒアドキュメントの本文は見ない。
// ただし bash -c "…"・powershell -Command "…"・eval "…" のように中身が実行される引用符は、中身も見る

export interface GuardRule {
  id: string;
  /** 画面と許可ダイアログに出す説明 */
  label: string;
  test: (cmd: string, raw: string) => boolean;
}

export interface GuardHit {
  id: string;
  label: string;
}

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;
/** 中身が実行される引用符の直前 */
const EXEC_PREFIX = /(?:\b(?:ba|z|da)?sh\s+-[a-z]*c|\beval|\bpwsh(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?|\bpowershell(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?|\bInvoke-Expression|\biex)\s*$/i;

/** 判定用にコマンドを整える：ヒアドキュメントの本文を除き、実行されない引用符の中身を空にする */
export function guardView(command: string): string {
  const noHeredoc = command.replace(HEREDOC, "");
  return noHeredoc.replace(QUOTED, (m, offset: number, whole: string) =>
    EXEC_PREFIX.test(whole.slice(Math.max(0, offset - 60), offset)) ? " " + unquote(m) + " " : "''",
  );
}

function unquote(q: string): string {
  return q.startsWith("'") ? q.slice(1, -1) : q.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** 1つのコマンドの区切り（; & | 改行）までを表す */
const ARGS = String.raw`[^;&|\n]*`;
const re = (s: string, flags = "i") => new RegExp(s, flags);
/** git の後のオプション（-C <フォルダ> のように値を取るものを含む） */
const GIT = String.raw`\bgit\s+(?:-\S+(?:\s+[^-\s;&|]\S*)?\s+)*`;

// rm -rf の対象として危険なもの：ルート、ホーム、カレント・親ディレクトリそのもの、ワイルドカードだけ
const RM_TARGET = String.raw`(?:/|/\*|~/?|~/\*|\$HOME/?|\$\{HOME\}/?|\$HOME/\*|\.|\./|\.\.|\.\./|\*|/Users/?|/home/?|/System\S*|/usr/?|/etc/?|/var/?|/Library/?|C:\\?\\?)`;
const RM_RF = re(
  String.raw`(?:^|[;&|(\s])(?:sudo\s+)?rm(?=${ARGS}\s(?:-[a-zA-Z]*[rR]|--recursive))(?=${ARGS}\s(?:-[a-zA-Z]*f|--force))${ARGS}\s${RM_TARGET}(?=\s|$|[;&|)])`,
);

// PowerShell の Remove-Item -Recurse -Force（ドライブのルート・ホーム）
const PS_TARGET = String.raw`(?:[A-Za-z]:\\?\*?|~\\?|\$env:USERPROFILE\\?|\$HOME\\?|\\)`;
const PS_RM = re(
  String.raw`\b(?:Remove-Item|rm|ri|del|rd|rmdir)\b(?=${ARGS}-Recurse)(?=${ARGS}-Force)${ARGS}\s${PS_TARGET}(?=\s|$|[;&|)])`,
);

export const GUARD_RULES: GuardRule[] = [
  {
    id: "git-push-force",
    label: "git push の強制上書き（--force）",
    test: (c) => re(String.raw`${GIT}push\b${ARGS}\s(?:--force(?![-\w])|-[a-zA-Z]*f\b|\+[\w/.-]+)`).test(c),
  },
  {
    id: "git-push-delete",
    label: "リモートのブランチの削除（git push --delete）",
    test: (c) => re(String.raw`${GIT}push\b${ARGS}\s(?:--delete\b|-d\b|:[\w/.-]+)`).test(c),
  },
  {
    id: "git-reset-hard",
    label: "未コミットの変更を消す（git reset --hard）",
    test: (c) => re(String.raw`${GIT}reset\b${ARGS}\s--hard\b`).test(c),
  },
  {
    id: "git-clean",
    label: "追跡していないファイルの削除（git clean -f）",
    test: (c) => re(String.raw`${GIT}clean\b${ARGS}\s-[a-zA-Z]*f`).test(c),
  },
  {
    id: "rm-rf-root",
    label: "ルート・ホーム・作業フォルダ全体の削除（rm -rf）",
    test: (c) => RM_RF.test(c) || PS_RM.test(c),
  },
  {
    id: "disk-erase",
    label: "ディスクの初期化・直接書き込み",
    test: (c) =>
      re(String.raw`(?:^|[;&|(\s])(?:sudo\s+)?(?:mkfs(?:\.\w+)?\b|diskutil\s+(?:erase\w*|zeroDisk|secureErase|partitionDisk)\b|format(?:\.com)?\s+[A-Za-z]:|Format-Volume\b|Clear-Disk\b)`).test(c) ||
      re(String.raw`\bdd\b${ARGS}\bof=/dev/`).test(c),
  },
  {
    id: "chmod-root",
    label: "ルート・ホーム以下の権限の一括変更",
    test: (c) => re(String.raw`(?:^|[;&|(\s])(?:sudo\s+)?ch(?:mod|own)\s+(?:-\S+\s+)*-R${ARGS}\s(?:/|~/?|\$HOME/?)(?=\s|$)`).test(c),
  },
  {
    id: "curl-pipe-sh",
    label: "ネットから取得したスクリプトをそのまま実行",
    test: (c) =>
      re(String.raw`\b(?:curl|wget)\b${ARGS}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b`).test(c) ||
      re(String.raw`\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b${ARGS}\|\s*(?:iex|Invoke-Expression)\b`).test(c),
  },
  {
    id: "sql-drop",
    // SQL は引用符の中に書かれるため、整える前のコマンドで見る
    label: "データベースのテーブル・データベースの削除（DROP・TRUNCATE）",
    test: (_c, raw) =>
      /\b(?:sqlite3|psql|mysql|mariadb|mongosh?|duckdb)\b/i.test(raw) &&
      /\b(?:drop\s+(?:table|database|schema)|truncate\s+(?:table\s+)?\w)/i.test(raw),
  },
  {
    id: "terraform-apply",
    label: "terraform apply・destroy（インフラの変更）",
    test: (c) => re(String.raw`\bterraform\s+(?:-\S+\s+)*(?:apply|destroy)\b`).test(c),
  },
  {
    id: "shutdown",
    label: "PC の停止・再起動",
    test: (c) => re(String.raw`(?:^|[;&|(\s])(?:sudo\s+)?(?:shutdown|reboot|halt|Stop-Computer|Restart-Computer)\b`).test(c),
  },
];

/** ツール呼び出しが危険操作に当たるか。当たらなければ null */
export function guardCheck(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): GuardHit | null {
  if (toolName !== "Bash" && toolName !== "PowerShell") return null;
  const raw = typeof toolInput?.command === "string" ? toolInput.command : "";
  if (!raw) return null;
  const view = guardView(raw);
  for (const r of GUARD_RULES) if (r.test(view, raw)) return { id: r.id, label: r.label };
  return null;
}

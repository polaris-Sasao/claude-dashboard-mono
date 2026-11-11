import { describe, expect, test } from "bun:test";
import { modelLabel, projectFromCwd, redactText } from "./index";

describe("表示用の変換", () => {
  test("cwd からプロジェクト名", () => {
    expect(projectFromCwd("/Users/a/dev/project-a")).toBe("project-a");
    expect(projectFromCwd("C:\\Users\\a\\project-b\\")).toBe("project-b");
    expect(projectFromCwd(null)).toBe("(不明)");
  });
  test("モデル ID からラベル", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("Sonnet 5.5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel(undefined)).toBeNull();
  });
});

describe("redactText", () => {
  test("トークン・パスワードを伏せ字にする", () => {
    expect(redactText("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactText("mysql -u root --password=hunter2xyz")).toBe("mysql -u root --password=＊＊＊");
    expect(redactText("curl -H 'Authorization: Bearer abc.def.ghijkl'")).not.toContain("abc.def.ghijkl");
    expect(redactText("git clone https://user:s3cretpw@github.com/x/y")).toBe("git clone https://user:＊＊＊@github.com/x/y");
    expect(redactText("ghp_0123456789abcdefghijABCDEFGHIJ")).toBe("＊＊＊");
  });
  test("普通の文は変えない", () => {
    const s = "週表示で祝日が反映されない不具合を修正し、テストを追加してください";
    expect(redactText(s)).toBe(s);
    expect(redactText("npm test -- --token-count")).toBe("npm test -- --token-count");
  });
});

import { codexModel, isCodexCall, todosFromInput } from "./index";

describe("isCodexCall", () => {
  const bash = (command: string) => isCodexCall("Bash", { command });
  test("codex の起動を検知する", () => {
    expect(bash("codex exec 'review'")).toBe(true);
    expect(bash("cd app && codex exec --full-auto 'fix'")).toBe(true);
    expect(bash("OPENAI_API_KEY=x codex 'hi'")).toBe(true);
    expect(bash("npx -y @openai/codex exec 'x'")).toBe(true);
    expect(isCodexCall("PowerShell", { command: "& codex.exe exec 'x'" })).toBe(true);
    expect(isCodexCall("mcp__codex__codex", {})).toBe(true);
  });
  test("codex という文字を含むだけのものは除外する", () => {
    expect(bash("cd codex-project && ls")).toBe(false);
    expect(bash("grep -r codex src/")).toBe(false);
    expect(bash("cat docs/codex.md")).toBe(false);
    expect(isCodexCall("Read", { file_path: "codex" })).toBe(false);
    // 文字列やヒアドキュメントの中身は対象外
    expect(bash(`git commit -m "& codex exec 'x'"`)).toBe(false);
    expect(bash("echo '; codex run'")).toBe(false);
    expect(bash("cat >> t.ts <<'EOF'\n  bash(\"& codex.exe exec 'x'\")\ncodex exec y\nEOF\nbun test")).toBe(false);
    expect(bash("cat > p.txt <<EOF\nhello\nEOF\ncodex exec 'after heredoc'")).toBe(true);
  });
  test("変数やフルパスでの起動も検知する", () => {
    // 実際に使われた形（VS Code の拡張機能の codex.exe を変数に入れて起動）
    const real =
      'cd "G:/work/x"; mkdir -p notes/codex .claude/codex/logs; C=$(ls -t /c/Users/*/.vscode/extensions/openai.chatgpt-*/bin/windows-x86_64/codex.exe 2>/dev/null | head -1); [ -z "$C" ] && C=$(command -v codex); echo "$C"; OUT="notes/codex/V3.md"; "$C" exec -C "$ROOT" -s read-only -m gpt-5.5 -o "$OUT" "レビューして; 報告して" < /dev/null > log 2>&1; echo "rc=$?"';
    expect(bash(real)).toBe(true);
    expect(codexModel("Bash", { command: real })).toBe("gpt-5.5");
    expect(bash("/c/Users/a/.vscode/extensions/openai.chatgpt-1/bin/codex.exe exec 'x'")).toBe(true);
    expect(bash('"C:/Program Files/Codex/codex.exe" exec "x"')).toBe(true);
    expect(isCodexCall("PowerShell", { command: '$c = (Get-Command codex).Source; & $c exec "x"' })).toBe(true);
  });
  test("版・使い方の表示と、フォルダ名に codex を含むだけの引数は数えない", () => {
    expect(bash('which codex; codex --version 2>&1 | head -2; cat .claude/codex/runner.sh')).toBe(false);
    expect(bash("codex --help")).toBe(false);
    expect(bash("mkdir -p notes/codex .claude/codex/logs")).toBe(false);
    expect(bash('OUT="notes/codex/a.md"; cat "$OUT"')).toBe(false);
  });
});

describe("todosFromInput", () => {
  test("TodoWrite の状態を変換する", () => {
    expect(todosFromInput({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] })).toEqual([
      { label: "a", status: "done" },
      { label: "b", status: "todo" },
    ]);
    expect(todosFromInput({})).toBeNull();
  });
});

describe("codexModel", () => {
  const bash = (command: string) => codexModel("Bash", { command });
  test("-m・--model・-c model= から読む", () => {
    expect(bash('codex exec -m gpt-5.5 "x"')).toBe("gpt-5.5");
    expect(bash("codex --model=o4-mini exec 'x'")).toBe("o4-mini");
    expect(bash('PATH=/x:$PATH codex exec --model "gpt-5-codex" "x"')).toBe("gpt-5-codex");
    expect(bash("codex -c model=gpt-5.5 exec 'x'")).toBe("gpt-5.5");
    expect(bash(`codex -c 'model="gpt-5.5"' exec x`)).toBe("gpt-5.5");
    expect(codexModel("PowerShell", { command: "& codex.exe exec -m gpt-5.5 'x'" })).toBe("gpt-5.5");
  });
  test("指定がない・Codex 以外の引数・Codex でないときは null", () => {
    expect(bash('codex exec "x"')).toBeNull();
    expect(bash('grep -m 1 foo a.txt && codex exec "x"')).toBeNull();
    expect(bash('codex exec "x"; python -m http.server')).toBeNull();
    expect(bash("python -m gpt-5.5")).toBeNull();
  });
  test("MCP 経由は入力の model を使う", () => {
    expect(codexModel("mcp__codex__codex", { prompt: "x", model: "gpt-5.5" })).toBe("gpt-5.5");
    expect(codexModel("mcp__codex__codex", { prompt: "x" })).toBeNull();
  });
});

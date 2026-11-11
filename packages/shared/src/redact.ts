// プロンプトやコマンドに含まれるトークン・パスワードらしい文字列を伏せ字にする

const MASK = "＊＊＊";

const PATTERNS: RegExp[] = [
  // 既知のトークン形式
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // 秘密鍵ブロック
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// key=value / key: value / "key": "value" 形式の値部分
const KEY_VALUE =
  /((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credential|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'&;,]{4,})/gi;

// Authorization: Bearer xxx
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;

// URL に埋め込まれた認証情報 https://user:pass@host
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;

export function redactText(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  out = out.replace(KEY_VALUE, (_m, k: string) => k + MASK);
  out = out.replace(BEARER, (_m, k: string) => k + MASK);
  out = out.replace(URL_CRED, (_m, a: string, _p: string, c: string) => a + MASK + c);
  return out;
}

/** JSON 値を再帰的にたどり、すべての文字列に redactText を適用する */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

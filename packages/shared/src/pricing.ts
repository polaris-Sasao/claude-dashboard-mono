// フェーズ5：会話記録のトークン数から費用を見積もる（statusLine の費用が届かない VS Code・Desktop 用）。
// 単価は Anthropic の API 料金（100万トークンあたりのドル。2026-09-25 時点、claude-api スキルの表）。
// キャッシュの書き込みは入力の 1.25 倍（5分）・2 倍（1時間）。会話記録に残らない裏側の呼び出しは含まれないため、
// statusLine の費用より少なめに出る（このプロジェクトのセッションで約12%少なかった）

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
}

/** [モデル名に含まれる文字列, 入力, 出力, キャッシュ読み出し]。上から順に照合する */
const PRICES: [RegExp, number, number, number][] = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable-5|mythos-5/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-9])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku/, 0.8, 4, 0.08],
];

export function priceOf(model: string): [number, number, number] {
  const m = model.toLowerCase();
  const hit = PRICES.find(([re]) => re.test(m));
  // 知らないモデルは Sonnet 相当として数える
  return hit ? [hit[1], hit[2], hit[3]] : [3, 15, 0.3];
}

export function estimateUsd(byModel: Record<string, Partial<TokenCounts>>): number {
  let usd = 0;
  for (const [model, c] of Object.entries(byModel)) {
    const [i, o, r] = priceOf(model);
    usd +=
      ((c.input ?? 0) * i + (c.output ?? 0) * o + (c.cacheRead ?? 0) * r + (c.cache5m ?? 0) * i * 1.25 + (c.cache1h ?? 0) * i * 2) /
      1e6;
  }
  return usd;
}

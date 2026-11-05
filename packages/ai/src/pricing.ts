// USD per million tokens, from Anthropic's published prices (checked 2026-10).
// Re-check https://platform.claude.com/docs/en/about-claude/pricing before relying on totals.
// Cache writes (5-minute TTL) cost 1.25× the input price.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Prompts up to 100K tokens. Cache prices here are estimates (1.25× / 0.1× input).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** "$0.0123": LLM costs are small, so four decimals. The locale is explicit (see intl-format). */
export const formatUsd = (amount: number) => usd.format(amount);

/** Undefined for a model without a known price, rather than a confident wrong number. */
export function costUsd(model: string, usage: TokenUsage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const dollars =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadInputTokens * price.cacheRead +
    usage.cacheCreationInputTokens * price.cacheWrite;
  return dollars / 1_000_000;
}

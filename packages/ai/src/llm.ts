import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { costUsd, type TokenUsage } from "./pricing.ts";

// The narrow interface the checks depend on: "give me JSON matching this schema".
// Tests use fakeLlmClient; production uses anthropicClient. Every call is metered.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredRequest<T> {
  /** What the call is for, e.g. "terminology.judge". Shows up in usage records. */
  purpose: string;
  /** Static instructions. Kept identical across calls so the prompt cache can reuse them. */
  system: string;
  /** The per-call input. */
  prompt: string;
  schema: z.ZodType<T>;
}

export interface LlmClient {
  readonly model: string;
  complete<T>(request: StructuredRequest<T>): Promise<T>;
}

export interface UsageRecord extends TokenUsage {
  purpose: string;
  model: string;
  costUsd?: number;
}

/** Collects the usage of every call made while reviewing one pull request. */
export class UsageMeter {
  readonly records: UsageRecord[] = [];

  record(purpose: string, model: string, usage: TokenUsage): void {
    this.records.push({ purpose, model, ...usage, costUsd: costUsd(model, usage) });
  }

  readonly failures: { purpose: string; error: string }[] = [];

  recordFailure(purpose: string, error: unknown): void {
    this.failures.push({ purpose, error: String(error) });
  }

  get totalCostUsd(): number {
    return this.records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  }
}

/** The model declined (a safety classifier, and the fallback model too). */
export class LlmRefusalError extends Error {
  readonly category: string | null;
  constructor(category: string | null) {
    super(`The model declined the request${category ? ` (${category})` : ""}`);
    this.category = category;
  }
}

export interface AnthropicClientOptions {
  model?: string;
  effort?: Effort;
  meter?: UsageMeter;
  /** Defaults to the SDK's own lookup (ANTHROPIC_API_KEY, ant auth login profiles…). */
  apiKey?: string;
}

export function anthropicClient(options: AnthropicClientOptions = {}): LlmClient {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  const model = options.model ?? "claude-opus-5-5";
  const effort = options.effort ?? "medium";

  return {
    model,
    async complete<T>(request: StructuredRequest<T>): Promise<T> {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16_000,
        // If a safety classifier declines, re-run on Anthropic's recommended fallback model
        // instead of failing the review.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The system prompt is the same on every call: cache it. Note the cache only kicks in
        // above a model-dependent minimum length; check cache_read_input_tokens in the usage.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.prompt }],
        output_config: { effort, format: betaZodOutputFormat(request.schema) },
      });

      const { usage } = response;
      options.meter?.record(request.purpose, response.model, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      });

      if (response.stop_reason === "refusal") {
        throw new LlmRefusalError(response.stop_details?.category ?? null);
      }
      if (response.stop_reason === "max_tokens" || !response.parsed_output) {
        throw new Error(
          `${request.purpose}: no valid output (stop_reason ${response.stop_reason})`,
        );
      }
      return response.parsed_output as T;
    },
  };
}

/** A scripted client for tests: answers from `respond`, validated by the same schema. */
export function fakeLlmClient(
  respond: (request: StructuredRequest<unknown>) => unknown,
  meter?: UsageMeter,
): LlmClient & { calls: StructuredRequest<unknown>[] } {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    model: "fake",
    calls,
    async complete<T>(request: StructuredRequest<T>): Promise<T> {
      calls.push(request as StructuredRequest<unknown>);
      meter?.record(request.purpose, "fake", {
        inputTokens: request.prompt.length,
        outputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
      return request.schema.parse(respond(request as StructuredRequest<unknown>));
    },
  };
}

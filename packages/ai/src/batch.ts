import type { LlmClient, StructuredRequest, UsageMeter } from "./llm.ts";

/** Split a long list so one prompt (and one failure) stays small. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * An LLM check must never fail the whole review: the deterministic rules' findings would be
 * lost with it. On error the batch contributes nothing and the failure is recorded.
 */
export async function tryComplete<T>(
  llm: LlmClient,
  request: StructuredRequest<T>,
  meter?: UsageMeter,
): Promise<T | undefined> {
  try {
    return await llm.complete(request);
  } catch (error) {
    meter?.recordFailure(request.purpose, error);
    return undefined;
  }
}

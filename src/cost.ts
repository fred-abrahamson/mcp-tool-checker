import type { Price } from "./schema.ts";

/**
 * What a run costs, and the cap that stops it.
 *
 * Prices live in config/models.json and go stale on their own: re-read the
 * vendors' pricing pages before a paid run and update them, with
 * `pricesCheckedOn`, in the same change.
 *
 * The cap is checked BEFORE every call against that call's worst case (its
 * estimated prompt plus every allowed output token), so spend can never pass
 * it. A run that reaches the cap stops and reports what it has.
 */

/** Token counts for one call, with cached and uncached input apart. */
export interface Usage {
  /** Input tokens billed at the full input rate. */
  input: number;
  /** Input tokens read from the vendor's prompt cache. */
  cachedInput: number;
  /** Input tokens written to Anthropic's prompt cache. */
  cacheWrite: number;
  /** Output tokens, reasoning included. */
  output: number;
}

export const ZERO_USAGE: Usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };

/** Output tokens a typical first-call response uses, for projecting a run before it starts. */
export const TYPICAL_OUTPUT_TOKENS = 600;

/** USD for one call. */
export function costUsd(price: Price, usage: Usage): number {
  return (
    (usage.input * price.input +
      usage.cachedInput * price.cachedInput +
      usage.cacheWrite * (price.cacheWrite ?? price.input) +
      usage.output * price.output) /
    1_000_000
  );
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** All input tokens of a usage, cached or not. */
export function inputTokens(usage: Usage): number {
  return usage.input + usage.cachedInput + usage.cacheWrite;
}

/**
 * A rough prompt-token count from text length, for projections and the cap
 * only. Deliberately generous (3 characters a token) so the cap errs safe.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** The most one call can cost: every prompt token at the dearest input rate, every output token used. */
export function worstCaseUsd(price: Price, promptTokens: number, maxOutputTokens: number): number {
  const dearestInput = Math.max(price.input, price.cacheWrite ?? 0);
  return (promptTokens * dearestInput + maxOutputTokens * price.output) / 1_000_000;
}

export class SpendCapReached extends Error {
  readonly capUsd: number;

  constructor(capUsd: number) {
    super(`the next call could pass the ${capUsd.toFixed(2)} USD cap, so the run stopped`);
    this.name = "SpendCapReached";
    this.capUsd = capUsd;
  }
}

/**
 * Tracks spend against a cap across concurrent calls: each call reserves its
 * worst case first and settles to its real cost after.
 */
export class SpendGuard {
  readonly capUsd: number;
  private spent = 0;
  private reserved = 0;

  constructor(capUsd: number) {
    if (!(capUsd > 0)) throw new Error("the spending cap must be a positive number of USD");
    this.capUsd = capUsd;
  }

  /** Reserves a call's worst case. Throws {@link SpendCapReached} when it would not fit. */
  reserve(worstUsd: number): void {
    if (this.spent + this.reserved + worstUsd > this.capUsd) throw new SpendCapReached(this.capUsd);
    this.reserved += worstUsd;
  }

  /** Releases a reservation and records what the call really cost (0 when it failed unbilled). */
  settle(worstUsd: number, actualUsd: number): void {
    this.reserved -= worstUsd;
    this.spent += actualUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }
}

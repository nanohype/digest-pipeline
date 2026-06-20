/**
 * Resilience utilities: timeout, retry-with-jitter
 * Agent: eng-backend
 *
 * Contract: every external client call is bounded by a timeout (≈8s for the
 * aggregators, up to 60s for Bedrock model inference) and, where the call is
 * idempotent, retried ≤3 attempts with jittered exponential backoff. AWS SDK
 * clients additionally carry a socket-level requestHandler timeout (see
 * common/aws.ts) so a stalled connection is aborted, not just abandoned.
 */

export interface RetryOptions {
  attempts: number;
  initialDelay: number;
  maxDelay?: number;
  jitter: boolean;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (err) {
    clearTimeout(timer!);
    throw err;
  }
}

export async function withRetry<T>(factory: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, initialDelay, maxDelay = 5_000, jitter } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await factory();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      const base = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
      const delay = jitter ? base * (0.5 + Math.random() * 0.5) : base;
      await sleep(delay);
    }
  }
  throw lastError;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

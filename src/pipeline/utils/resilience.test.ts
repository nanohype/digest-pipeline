import { describe, it, expect } from 'vitest';
import { withTimeout, withRetry, TimeoutError } from './resilience.js';

describe('withTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 50);
    expect(result).toBe('ok');
  });

  it('rejects with TimeoutError when the promise is too slow', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('surfaces the underlying rejection when the promise rejects first', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });
});

describe('withRetry', () => {
  it('returns the first successful attempt without retrying', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'done';
      },
      { attempts: 3, initialDelay: 1, jitter: false }
    );
    expect(result).toBe('done');
    expect(calls).toBe(1);
  });

  it('retries until success within the attempt budget', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return 'eventually';
      },
      { attempts: 5, initialDelay: 1, jitter: false }
    );
    expect(calls).toBe(3);
    expect(result).toBe('eventually');
  });

  it('throws the last error once the attempt budget is exhausted', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`fail-${calls}`);
        },
        { attempts: 3, initialDelay: 1, jitter: false }
      )
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3);
  });
});

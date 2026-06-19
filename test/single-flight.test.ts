// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it, vi } from 'vitest';
import { SingleFlight } from '../src/background/core/single-flight';

describe('SingleFlight — collapse concurrent ops into one execution', () => {
  it('runs the op ONCE for concurrent callers and gives them the same result', async () => {
    const gate = new SingleFlight<number>();
    let runs = 0;
    let release: (v: number) => void = () => {};
    const op = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          runs += 1;
          release = resolve;
        }),
    );

    const a = gate.run(op);
    const b = gate.run(op);
    const c = gate.run(op);
    expect(runs).toBe(1); // only one execution started
    expect(gate.isInFlight).toBe(true);

    release(42);
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42]);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('releases the slot after RESOLVE so the next call runs fresh', async () => {
    const gate = new SingleFlight<number>();
    expect(await gate.run(async () => 1)).toBe(1);
    expect(gate.isInFlight).toBe(false);
    expect(await gate.run(async () => 2)).toBe(2); // a NEW execution
  });

  it('releases the slot after REJECT (a failed refresh must not wedge the gate)', async () => {
    const gate = new SingleFlight<number>();
    await expect(
      gate.run(async () => {
        throw new Error('refresh failed');
      }),
    ).rejects.toThrow('refresh failed');
    expect(gate.isInFlight).toBe(false);
    expect(await gate.run(async () => 7)).toBe(7); // gate recovered
  });

  it('shares the rejection across all concurrent waiters', async () => {
    const gate = new SingleFlight<number>();
    let reject: (e: Error) => void = () => {};
    const op = () =>
      new Promise<number>((_resolve, r) => {
        reject = r;
      });
    const a = gate.run(op);
    const b = gate.run(op);
    reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
  });
});

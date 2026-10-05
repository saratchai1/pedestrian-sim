import { describe, expect, it } from 'vitest';
import { sampleOccupant, seededRandom } from '../src/profiles';

describe('seeded occupant generation', () => {
  it('repeats the same pseudo-random sequence for the same seed', () => {
    const a = seededRandom(20260918);
    const b = seededRandom(20260918);

    const first = Array.from({ length: 8 }, () => a());
    const second = Array.from({ length: 8 }, () => b());

    expect(first).toEqual(second);
  });

  it('repeats mixed-profile sampling for the same seed', () => {
    const sample = (seed: number) => {
      const random = seededRandom(seed);
      return Array.from({ length: 20 }, () =>
        sampleOccupant('mixed', 1.25, random),
      );
    };

    expect(sample(42)).toEqual(sample(42));
    expect(sample(42).every((item) => item.speed >= 0.35)).toBe(true);
  });
});

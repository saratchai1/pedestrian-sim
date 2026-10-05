import { describe, expect, it } from 'vitest';
import {
  configuredExitRate,
  effectiveExitWidth,
  measuredExitRate,
  nextAllowedPassTime,
} from '../src/flow';

describe('SFPE-style door flow math', () => {
  it('matches the documented Pathfinder 1 m maximum-flow example', () => {
    const effective = effectiveExitWidth(1.0, 0.15);
    const rate = configuredExitRate(1.0, 1.316, 0.15);

    expect(effective).toBeCloseTo(0.7, 10);
    expect(rate).toBeCloseTo(0.9212, 4);
  });

  it('scales maximum flow with effective door width', () => {
    expect(configuredExitRate(0.7, 1.316, 0.15)).toBeCloseTo(0.5264, 4);
    expect(configuredExitRate(2.0, 1.316, 0.15)).toBeCloseTo(2.2372, 4);
  });

  it('converts a configured rate to a non-banking delay timer', () => {
    const rate = configuredExitRate(1.0, 1.316, 0.15);
    expect(nextAllowedPassTime(10, rate)).toBeCloseTo(11.0855, 4);
  });

  it('computes measured flow from pass timestamps', () => {
    expect(measuredExitRate(10, 2, 11)).toBeCloseTo(1, 10);
    expect(measuredExitRate(1, 2, 2)).toBeNull();
  });

  it('keeps pathological widths numerically safe', () => {
    expect(effectiveExitWidth(0.2, 0.15)).toBe(0.05);
    expect(configuredExitRate(0.2, 1.316, 0.15)).toBeCloseTo(0.0658, 4);
  });
});

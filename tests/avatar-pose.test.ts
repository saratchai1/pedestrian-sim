import { describe, expect, it } from 'vitest';
import { humanWalkPose } from '../src/avatars/pose';

describe('human avatar walk pose', () => {
  it('stays effectively idle when the crowd agent is not moving', () => {
    const pose = humanWalkPose(0, 3, 10);
    expect(pose.moving).toBe(false);
    expect(pose.legSwing).toBe(0);
    expect(pose.armSwing).toBe(0);
    expect(pose.bob).toBe(0);
  });

  it('animates opposite arms and legs while walking', () => {
    const pose = humanWalkPose(1.25, 1.2, 4);
    expect(pose.moving).toBe(true);
    expect(Math.abs(pose.legSwing)).toBeGreaterThan(0.01);
    expect(pose.armSwing).toBeCloseTo(-pose.legSwing * 0.82, 10);
    expect(pose.bob).toBeGreaterThanOrEqual(0);
  });

  it('articulates alternating knees and elbows while walking', () => {
    const pose = humanWalkPose(1.3, 0.8, 2);

    expect(
      pose.leftKneeBend > 0 || pose.rightKneeBend > 0,
    ).toBe(true);
    expect(pose.leftElbowBend).toBeGreaterThanOrEqual(0);
    expect(pose.rightElbowBend).toBeGreaterThanOrEqual(0);
    expect(Math.abs(pose.sway)).toBeLessThanOrEqual(0.025);
  });

  it('keeps a subtle breathing motion while standing idle', () => {
    const pose = humanWalkPose(0, 0.9, 4);

    expect(pose.moving).toBe(false);
    expect(Math.abs(pose.breath)).toBeLessThanOrEqual(0.008);
  });

  it('caps forward lean at a small visual value', () => {
    const pose = humanWalkPose(20, 2, 1);
    expect(pose.lean).toBeLessThanOrEqual(0.08);
  });
});

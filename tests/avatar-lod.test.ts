import { describe, expect, it } from 'vitest';
import { selectAvatarLods, smoothAngle } from '../src/avatars/lod';

describe('human avatar LOD', () => {
  it('limits detailed avatars to the nearest configured count', () => {
    const lods = selectAvatarLods(
      [5, 10, 15, 20, 30, 60, 100],
      {
        detailDistance: 45,
        mediumDistance: 90,
        maxDetailed: 3,
      },
    );

    expect(lods).toEqual([
      'detail',
      'detail',
      'detail',
      'mid',
      'mid',
      'mid',
      'far',
    ]);
  });

  it('uses medium and far representations outside the detailed range', () => {
    expect(
      selectAvatarLods([50, 89, 91], {
        detailDistance: 30,
        mediumDistance: 90,
        maxDetailed: 10,
      }),
    ).toEqual(['mid', 'mid', 'far']);
  });

  it('smooths yaw through the shortest wrapped angle', () => {
    const current = Math.PI - 0.05;
    const target = -Math.PI + 0.05;
    const next = smoothAngle(current, target, 0.5);

    expect(Math.abs(next - current)).toBeLessThan(0.1);
  });
});

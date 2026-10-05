import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/profiles';
import {
  pointInPolygon,
  samplePointInPolygon,
} from '../src/spawn';

const polygon = [
  { x: 0, z: 0 },
  { x: 6, z: 0 },
  { x: 6, z: 4 },
  { x: 0, z: 4 },
];

describe('Spawn Area sampling', () => {
  it('samples points inside the polygon', () => {
    const random = seededRandom(1234);

    for (let i = 0; i < 100; i += 1) {
      const point = samplePointInPolygon(polygon, random);
      expect(pointInPolygon(point, polygon)).toBe(true);
    }
  });

  it('is repeatable for the same simulation seed', () => {
    const a = seededRandom(77);
    const b = seededRandom(77);

    const first = Array.from({ length: 12 }, () =>
      samplePointInPolygon(polygon, a),
    );
    const second = Array.from({ length: 12 }, () =>
      samplePointInPolygon(polygon, b),
    );

    expect(first).toEqual(second);
  });
});

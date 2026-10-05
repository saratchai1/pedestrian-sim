export type SpawnPoint2D = {
  x: number;
  z: number;
};

export function pointInPolygon(
  point: SpawnPoint2D,
  polygon: SpawnPoint2D[],
) {
  let inside = false;

  for (
    let i = 0, j = polygon.length - 1;
    i < polygon.length;
    j = i++
  ) {
    const a = polygon[i];
    const b = polygon[j];

    const intersects =
      a.z > point.z !== b.z > point.z &&
      point.x <
        ((b.x - a.x) * (point.z - a.z)) /
          ((b.z - a.z) || Number.EPSILON) +
          a.x;

    if (intersects) inside = !inside;
  }

  return inside;
}

export function polygonCentroid(polygon: SpawnPoint2D[]) {
  if (!polygon.length) return { x: 0, z: 0 };

  const total = polygon.reduce(
    (sum, point) => ({
      x: sum.x + point.x,
      z: sum.z + point.z,
    }),
    { x: 0, z: 0 },
  );

  return {
    x: total.x / polygon.length,
    z: total.z / polygon.length,
  };
}

export function samplePointInPolygon(
  polygon: SpawnPoint2D[],
  random: () => number,
) {
  if (polygon.length < 3) return polygonCentroid(polygon);

  const xs = polygon.map((point) => point.x);
  const zs = polygon.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  for (let attempt = 0; attempt < 160; attempt += 1) {
    const candidate = {
      x: minX + (maxX - minX) * random(),
      z: minZ + (maxZ - minZ) * random(),
    };

    if (pointInPolygon(candidate, polygon)) {
      return candidate;
    }
  }

  return polygonCentroid(polygon);
}

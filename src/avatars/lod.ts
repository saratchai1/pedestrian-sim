export type AvatarLod = 'detail' | 'mid' | 'far';

export type AvatarLodOptions = {
  detailDistance: number;
  mediumDistance: number;
  maxDetailed: number;
};

export const DEFAULT_AVATAR_LOD: AvatarLodOptions = {
  detailDistance: 45,
  mediumDistance: 90,
  maxDetailed: 72,
};

export function selectAvatarLods(
  distances: number[],
  options: AvatarLodOptions = DEFAULT_AVATAR_LOD,
): AvatarLod[] {
  const result: AvatarLod[] = distances.map((distance) =>
    distance <= options.mediumDistance ? 'mid' : 'far',
  );

  const candidates = distances
    .map((distance, index) => ({ distance, index }))
    .filter(({ distance }) => Number.isFinite(distance))
    .filter(({ distance }) => distance <= options.detailDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, options.maxDetailed));

  for (const candidate of candidates) {
    result[candidate.index] = 'detail';
  }

  return result;
}

export function smoothAngle(
  current: number,
  target: number,
  alpha: number,
) {
  const wrapped =
    Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + wrapped * Math.max(0, Math.min(1, alpha));
}

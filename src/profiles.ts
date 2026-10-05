export type ProfilePreset = 'custom' | 'adult' | 'mixed' | 'slow' | 'staff';

export type SampledOccupant = {
  profile: string;
  speed: number;
  radius: number;
};

type ProfileDefinition = {
  name: string;
  speed: number;
  spread: number;
  radius: number;
};

const profiles: Record<string, ProfileDefinition> = {
  adult: {
    name: 'Adult',
    speed: 1.25,
    spread: 0.12,
    radius: 0.24,
  },
  slow: {
    name: 'Slow / cautious',
    speed: 0.85,
    spread: 0.10,
    radius: 0.25,
  },
  staff: {
    name: 'Staff',
    speed: 1.45,
    spread: 0.12,
    radius: 0.24,
  },
};

export function seededRandom(seed: number) {
  let state = (seed | 0) || 1;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function sampleDefinition(
  definition: ProfileDefinition,
  random: () => number,
): SampledOccupant {
  const variation = (random() * 2 - 1) * definition.spread;

  return {
    profile: definition.name,
    speed: Math.max(0.35, definition.speed + variation),
    radius: definition.radius,
  };
}

export function sampleOccupant(
  preset: ProfilePreset,
  customSpeed: number,
  random: () => number,
): SampledOccupant {
  if (preset === 'custom') {
    return {
      profile: 'Custom',
      speed: Math.max(0.35, customSpeed * (0.92 + random() * 0.16)),
      radius: 0.24,
    };
  }

  if (preset === 'mixed') {
    const roll = random();

    if (roll < 0.7) return sampleDefinition(profiles.adult, random);
    if (roll < 0.9) return sampleDefinition(profiles.slow, random);
    return sampleDefinition(profiles.staff, random);
  }

  return sampleDefinition(profiles[preset], random);
}

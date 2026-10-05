import type { BuildPlan } from './build/geometry';

export type ScenarioSource = 'built' | 'manual';

export type SavedSimulationSettings = {
  scenarioSource: ScenarioSource;
  profilePreset: string;
  walkingSpeed: number;
  preMovementMax: number;
  seed: number;
  limitExitFlow: boolean;
  specificFlow: number;
  boundaryLayer: number;
  defaultExitWidth: number;
  manualOccupants: number;
  manualSpawnRadius: number;
};

export type SavedManualScenario = {
  spawn: { x: number; y: number; z: number } | null;
  exits: Array<{
    name?: string;
    width?: number;
    position: { x: number; y: number; z: number };
  }>;
};

export type EvacSimModel = {
  kind: 'evacsim-model';
  version: 1;
  name: string;
  savedAt: string;
  plan: BuildPlan;
  simulation: SavedSimulationSettings;
  manualScenario: SavedManualScenario;
};

export const MODEL_STORAGE_KEY = 'evacsim.saved-model.v1';

export function createEvacSimModel(
  name: string,
  plan: BuildPlan,
  simulation: SavedSimulationSettings,
  manualScenario: SavedManualScenario = { spawn: null, exits: [] },
  now = new Date(),
): EvacSimModel {
  return {
    kind: 'evacsim-model',
    version: 1,
    name: name.trim() || 'Untitled model',
    savedAt: now.toISOString(),
    plan: structuredClone(plan),
    simulation: structuredClone(simulation),
    manualScenario: structuredClone(manualScenario),
  };
}

export function isBuildPlan(value: unknown): value is BuildPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<BuildPlan>;
  return plan.version === 1 && Array.isArray(plan.elements);
}

export function isEvacSimModel(value: unknown): value is EvacSimModel {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<EvacSimModel>;
  return (
    model.kind === 'evacsim-model' &&
    model.version === 1 &&
    typeof model.name === 'string' &&
    typeof model.savedAt === 'string' &&
    isBuildPlan(model.plan) &&
    Boolean(model.simulation) &&
    typeof model.simulation === 'object' &&
    Boolean(model.manualScenario) &&
    typeof model.manualScenario === 'object'
  );
}

export function parseEvacSimModelFile(
  raw: string,
  fallbackSimulation: SavedSimulationSettings,
): EvacSimModel {
  const parsed: unknown = JSON.parse(raw);

  if (isEvacSimModel(parsed)) {
    return parsed;
  }

  // Backward compatibility with the original exported BuildPlan JSON.
  if (isBuildPlan(parsed)) {
    return createEvacSimModel(
      'Imported legacy plan',
      parsed,
      fallbackSimulation,
      { spawn: null, exits: [] },
    );
  }

  throw new Error('Unsupported EvacSim model file.');
}

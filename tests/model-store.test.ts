import { describe, expect, it } from 'vitest';
import {
  createEvacSimModel,
  parseEvacSimModelFile,
  type SavedSimulationSettings,
} from '../src/model-store';
import type { BuildPlan } from '../src/build/geometry';

const plan: BuildPlan = {
  version: 1,
  elements: [
    {
      id: 'spawn-1',
      type: 'spawn',
      points: [
        { x: 0, z: 0 },
        { x: 2, z: 0 },
        { x: 2, z: 2 },
        { x: 0, z: 2 },
      ],
      elevation: 0,
      occupants: 20,
    },
  ],
};

const simulation: SavedSimulationSettings = {
  scenarioSource: 'built',
  profilePreset: 'adult',
  walkingSpeed: 1.25,
  preMovementMax: 15,
  seed: 123,
  limitExitFlow: true,
  specificFlow: 1.316,
  boundaryLayer: 0.15,
  defaultExitWidth: 1,
  manualOccupants: 120,
  manualSpawnRadius: 3,
};

describe('EvacSim model persistence', () => {
  it('round-trips model, scenario settings, and manual scenario data', () => {
    const model = createEvacSimModel(
      'Test model',
      plan,
      simulation,
      {
        spawn: { x: 1, y: 0, z: 1 },
        exits: [
          {
            name: 'Manual Exit 1',
            width: 1.2,
            position: { x: 5, y: 0, z: 2 },
          },
        ],
      },
      new Date('2026-09-18T04:00:00.000Z'),
    );

    const parsed = parseEvacSimModelFile(
      JSON.stringify(model),
      simulation,
    );

    expect(parsed.name).toBe('Test model');
    expect(parsed.plan.elements[0].type).toBe('spawn');
    expect(parsed.simulation.scenarioSource).toBe('built');
    expect(parsed.manualScenario.spawn).toEqual({ x: 1, y: 0, z: 1 });
    expect(parsed.manualScenario.exits[0].width).toBe(1.2);
  });

  it('imports the old BuildPlan JSON format without losing geometry', () => {
    const parsed = parseEvacSimModelFile(
      JSON.stringify(plan),
      simulation,
    );

    expect(parsed.kind).toBe('evacsim-model');
    expect(parsed.name).toBe('Imported legacy plan');
    expect(parsed.plan.elements).toEqual(plan.elements);
    expect(parsed.manualScenario.spawn).toBeNull();
    expect(parsed.manualScenario.exits).toEqual([]);
  });
});

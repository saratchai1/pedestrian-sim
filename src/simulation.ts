import * as THREE from 'three';
import { Crowd, NavMeshQuery } from 'recast-navigation';
import { HumanCrowdHelper } from './avatars/human-crowd';
import { pathLength } from './navigation';
import {
  configuredExitRate,
  effectiveExitWidth,
  measuredExitRate,
  nextAllowedPassTime,
} from './flow';
import {
  sampleOccupant,
  seededRandom,
  type ProfilePreset,
} from './profiles';
import {
  polygonCentroid,
  samplePointInPolygon,
} from './spawn';

export type ExitTarget = {
  id: number;
  position: THREE.Vector3;
  name?: string;
  width?: number;
};

export type SpawnAreaTarget = {
  id: string;
  name?: string;
  points: Array<{ x: number; z: number }>;
  elevation: number;
  occupants: number;
};

export type SimConfig = {
  occupants: number;
  walkingSpeed: number;
  spawnRadius: number;
  profilePreset: ProfilePreset;
  preMovementMax: number;
  seed: number;
  limitExitFlow: boolean;
  specificFlow: number;
  boundaryLayer: number;
  defaultExitWidth: number;
  spawnAreas?: SpawnAreaTarget[];
};

type AgentRecord = {
  id: number;
  agent: any;
  exit: ExitTarget;
  profile: string;
  speed: number;
  preMovementDelay: number;
  started: boolean;
  queuedAt: number | null;
  queueWait: number;
  evacuatedAt: number | null;
  travelDistance: number;
  lastPosition: THREE.Vector3;
};

type ExitFlowState = {
  width: number;
  effectiveWidth: number;
  configuredRate: number;
  nextAllowedAt: number;
  currentQueue: number;
  peakQueue: number;
  passed: number;
  firstPassAt: number | null;
  lastPassAt: number | null;
};

export class EvacuationSimulation {
  readonly crowd: Crowd;
  readonly helper: HumanCrowdHelper;
  readonly agents: AgentRecord[] = [];
  readonly exitCounts = new Map<number, number>();
  readonly peakDensityByCell = new Map<string, number>();
  readonly exitFlowStates = new Map<number, ExitFlowState>();
  currentDensity = new Map<string, number>();
  time = 0;
  running = false;

  private accumulator = 0;
  private readonly fixedStep = 1 / 30;

  constructor(
    navMesh: any,
    private query: NavMeshQuery,
    spawn: THREE.Vector3 | null,
    exits: ExitTarget[],
    private config: SimConfig,
  ) {
    const random = seededRandom(config.seed);
    const spawnAreas = (config.spawnAreas || []).filter(
      (area) => area.points.length >= 3 && area.occupants > 0,
    );
    const requestedOccupants = spawnAreas.length
      ? spawnAreas.reduce(
          (sum, area) => sum + Math.max(1, Math.round(area.occupants)),
          0,
        )
      : config.occupants;

    if (!spawnAreas.length && !spawn) {
      throw new Error('No Spawn Area or manual spawn point is configured.');
    }

    this.crowd = new Crowd(navMesh, {
      maxAgents: Math.max(1, requestedOccupants),
      maxAgentRadius: 0.32,
    });

    const profileByAgentIndex = new Map<number, string>();

    const snappedExits = exits.map((exit) => {
      const result = query.findClosestPoint(exit.position);
      if (!result.success) {
        throw new Error('Exit ' + exit.id + ' is not close enough to the NavMesh.');
      }

      return {
        ...exit,
        position: new THREE.Vector3(result.point.x, result.point.y, result.point.z),
      };
    });

    for (const exit of snappedExits) {
      this.exitCounts.set(exit.id, 0);

      const width = Math.max(0.05, exit.width ?? config.defaultExitWidth);
      const effectiveWidth = effectiveExitWidth(width, config.boundaryLayer);
      const configuredRate = config.limitExitFlow
        ? configuredExitRate(width, config.specificFlow, config.boundaryLayer)
        : Number.POSITIVE_INFINITY;

      this.exitFlowStates.set(exit.id, {
        width,
        effectiveWidth,
        configuredRate,
        nextAllowedAt: 0,
        currentQueue: 0,
        peakQueue: 0,
        passed: 0,
        firstPassAt: null,
        lastPassAt: null,
      });
    }

    const startCandidates: Array<{
      candidate: THREE.Vector3;
      fallback: THREE.Vector3;
    }> = [];

    if (spawnAreas.length) {
      for (const area of spawnAreas) {
        const count = Math.max(1, Math.round(area.occupants));
        const centroid = polygonCentroid(area.points);
        const fallback = new THREE.Vector3(
          centroid.x,
          area.elevation,
          centroid.z,
        );

        for (let i = 0; i < count; i += 1) {
          const sampledPoint = samplePointInPolygon(area.points, random);
          startCandidates.push({
            candidate: new THREE.Vector3(
              sampledPoint.x,
              area.elevation,
              sampledPoint.z,
            ),
            fallback,
          });
        }
      }
    } else if (spawn) {
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));

      for (let i = 0; i < requestedOccupants; i += 1) {
        const radial =
          Math.sqrt((i + 0.5) / requestedOccupants) * config.spawnRadius;
        const angle = i * goldenAngle + random() * 0.08;

        startCandidates.push({
          candidate: new THREE.Vector3(
            spawn.x + Math.cos(angle) * radial,
            spawn.y,
            spawn.z + Math.sin(angle) * radial,
          ),
          fallback: spawn.clone(),
        });
      }
    }

    for (let i = 0; i < startCandidates.length; i += 1) {
      const source = startCandidates[i];
      const placed = query.findClosestPoint(source.candidate);
      const fallback = query.findClosestPoint(source.fallback);

      if (!placed.success && !fallback.success) {
        continue;
      }

      const p = placed.success ? placed.point : fallback.point;
      const start = new THREE.Vector3(p.x, p.y, p.z);
      const target = this.pickBestExit(start, snappedExits);

      if (!target) continue;

      const sampled = sampleOccupant(
        config.profilePreset,
        config.walkingSpeed,
        random,
      );

      const preMovementDelay = Math.max(0, config.preMovementMax) * random();

      const agent = this.crowd.addAgent(start, {
        radius: sampled.radius,
        height: 1.7,
        maxAcceleration: 3.2,
        maxSpeed: sampled.speed,
        collisionQueryRange: Math.max(0.9, sampled.radius * 4),
        pathOptimizationRange: 6,
        separationWeight: 2,
      });

      profileByAgentIndex.set(agent.agentIndex, sampled.profile);

      const started = preMovementDelay <= 0.0001;
      if (started) agent.requestMoveTarget(target.position);

      this.agents.push({
        id: i + 1,
        agent,
        exit: target,
        profile: sampled.profile,
        speed: sampled.speed,
        preMovementDelay,
        started,
        queuedAt: null,
        queueWait: 0,
        evacuatedAt: null,
        travelDistance: 0,
        lastPosition: start.clone(),
      });
    }

    if (!this.agents.length) {
      throw new Error('No occupants could be placed on a route to an exit.');
    }

    this.helper = new HumanCrowdHelper(this.crowd, {
      capacity: Math.max(1, requestedOccupants),
      profileByAgentIndex,
    });
  }

  private pickBestExit(start: THREE.Vector3, exits: ExitTarget[]) {
    let best: ExitTarget | null = null;
    let bestLength = Number.POSITIVE_INFINITY;

    for (const exit of exits) {
      const result = this.query.computePath(start, exit.position);
      if (!result.success || result.path.length < 2) continue;

      const length = pathLength(result.path);
      if (length < bestLength) {
        bestLength = length;
        best = exit;
      }
    }

    return best;
  }

  private evacuate(record: AgentRecord) {
    if (record.evacuatedAt !== null) return;

    record.evacuatedAt = this.time;
    record.queueWait = record.queuedAt == null
      ? 0
      : Math.max(0, this.time - record.queuedAt);

    this.exitCounts.set(
      record.exit.id,
      (this.exitCounts.get(record.exit.id) || 0) + 1,
    );

    const flow = this.exitFlowStates.get(record.exit.id);
    if (flow) {
      flow.passed += 1;
      if (flow.firstPassAt == null) flow.firstPassAt = this.time;
      flow.lastPassAt = this.time;
    }

    this.crowd.removeAgent(record.agent);
  }

  start() {
    this.running = true;
  }

  pause() {
    this.running = false;
  }

  private fixedUpdate(dt: number) {
    const nextTime = this.time + dt;

    for (const record of this.agents) {
      if (
        record.evacuatedAt === null &&
        !record.started &&
        record.preMovementDelay <= nextTime
      ) {
        record.started = true;
        record.agent.requestMoveTarget(record.exit.position);
      }
    }

    this.crowd.update(dt);
    this.time = nextTime;

    const density = new Map<string, number>();

    for (const record of this.agents) {
      if (record.evacuatedAt !== null) continue;

      const raw = record.agent.position();
      const position = new THREE.Vector3(raw.x, raw.y, raw.z);

      if (record.started && record.queuedAt == null) {
        record.travelDistance += position.distanceTo(record.lastPosition);
      }
      record.lastPosition.copy(position);

      const key = Math.floor(position.x) + ',' + Math.floor(position.z);
      density.set(key, (density.get(key) || 0) + 1);

      if (
        record.started &&
        record.queuedAt == null &&
        position.distanceTo(record.exit.position) <= 0.7
      ) {
        if (this.config.limitExitFlow) {
          record.queuedAt = this.time;
          record.agent.resetMoveTarget();
        } else {
          this.evacuate(record);
        }
      }
    }

    if (this.config.limitExitFlow) {
      for (const [exitId, flow] of this.exitFlowStates) {
        const queued = this.agents
          .filter(
            (record) =>
              record.evacuatedAt === null &&
              record.exit.id === exitId &&
              record.queuedAt !== null,
          )
          .sort((a, b) => {
            const byTime = (a.queuedAt || 0) - (b.queuedAt || 0);
            return byTime || a.id - b.id;
          });

        flow.currentQueue = queued.length;
        flow.peakQueue = Math.max(flow.peakQueue, queued.length);

        if (queued.length && this.time >= flow.nextAllowedAt) {
          this.evacuate(queued[0]);
          flow.nextAllowedAt = nextAllowedPassTime(
            this.time,
            flow.configuredRate,
          );
          flow.currentQueue = Math.max(0, flow.currentQueue - 1);
        }
      }
    } else {
      for (const flow of this.exitFlowStates.values()) {
        flow.currentQueue = 0;
      }
    }

    this.currentDensity = density;

    for (const [key, count] of density) {
      this.peakDensityByCell.set(
        key,
        Math.max(count, this.peakDensityByCell.get(key) || 0),
      );
    }

    if (this.agents.every((record) => record.evacuatedAt !== null)) {
      this.running = false;
    }
  }

  update(delta: number, cameraPosition?: THREE.Vector3) {
    if (!this.running) return;

    this.accumulator += Math.min(delta, 0.25);
    let stepped = false;

    while (this.accumulator >= this.fixedStep && this.running) {
      this.fixedUpdate(this.fixedStep);
      this.accumulator -= this.fixedStep;
      stepped = true;
    }

    if (stepped) this.helper.update(this.time, cameraPosition);
  }

  snapshot() {
    const evacuated = this.agents.filter((agent) => agent.evacuatedAt !== null);
    const waiting = this.agents.filter(
      (agent) => agent.evacuatedAt === null && !agent.started,
    ).length;
    const times = evacuated
      .map((agent) => agent.evacuatedAt || 0)
      .sort((a, b) => a - b);

    const average = times.length
      ? times.reduce((sum, value) => sum + value, 0) / times.length
      : null;

    const p95 = times.length
      ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)]
      : null;

    const queueWaits = evacuated.map((agent) => agent.queueWait);
    const averageQueueWait = queueWaits.length
      ? queueWaits.reduce((sum, value) => sum + value, 0) / queueWaits.length
      : null;

    const profileCounts = new Map<string, number>();
    for (const agent of this.agents) {
      profileCounts.set(agent.profile, (profileCounts.get(agent.profile) || 0) + 1);
    }

    const exitFlowMetrics = new Map(
      [...this.exitFlowStates.entries()].map(([id, flow]) => {
        return [
          id,
          {
            width: flow.width,
            effectiveWidth: flow.effectiveWidth,
            configuredRate: flow.configuredRate,
            currentQueue: flow.currentQueue,
            peakQueue: flow.peakQueue,
            measuredRate: measuredExitRate(
              flow.passed,
              flow.firstPassAt,
              flow.lastPassAt,
            ),
          },
        ] as const;
      }),
    );

    const maxQueue = Math.max(
      0,
      ...[...this.exitFlowStates.values()].map((flow) => flow.peakQueue),
    );

    return {
      time: this.time,
      total: this.agents.length,
      active: this.agents.length - evacuated.length,
      waiting,
      evacuated: evacuated.length,
      peakDensity: Math.max(0, ...this.peakDensityByCell.values()),
      maxQueue,
      averageQueueWait,
      averageEvacuationTime: average,
      p95EvacuationTime: p95,
      exitCounts: new Map(this.exitCounts),
      exitFlowMetrics,
      profileCounts,
      currentDensity: new Map(this.currentDensity),
    };
  }

  toCsv() {
    const header =
      'agent_id,profile,speed_mps,pre_movement_s,exit_id,queue_wait_s,evacuation_time_s,travel_distance_m\n';

    const rows = this.agents.map((agent) => {
      return [
        agent.id,
        JSON.stringify(agent.profile),
        agent.speed.toFixed(3),
        agent.preMovementDelay.toFixed(3),
        agent.exit.id,
        agent.queueWait.toFixed(3),
        agent.evacuatedAt === null ? '' : agent.evacuatedAt.toFixed(3),
        agent.travelDistance.toFixed(3),
      ].join(',');
    });

    return header + rows.join('\n');
  }

  dispose() {
    this.running = false;
    this.helper.dispose();
    this.crowd.destroy();
  }
}

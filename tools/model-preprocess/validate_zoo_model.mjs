import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = process.cwd();
const output = path.resolve(root, 'generated/models/zoo');
const visualPath = path.join(output, 'visual.glb');
const navPath = path.join(output, 'nav.glb');
const manifestPath = path.join(output, 'zoo-model.local.json');
const inspectionPath = path.join(output, 'model-inspection.md');
const agentArgument = process.argv.indexOf('--agents');
const agentCount = agentArgument < 0 ? 100 : Number(process.argv[agentArgument + 1]);
if (![100, 500, 1000].includes(agentCount)) {
  throw new Error('Choose --agents 100, 500, or 1000. Run 500/1000 only after the 100-agent validation passes.');
}
const reportPath = path.join(output, `validation-${agentCount}.json`);
const csvPath = path.join(output, `simulation-${agentCount}.csv`);

function fail(message) {
  throw new Error(message);
}

async function readModelFile(filePath) {
  const bytes = await fs.readFile(filePath);
  const arrayBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name: path.basename(filePath),
    arrayBuffer: async () => arrayBuffer,
  };
}

function meshCandidates(group, query, THREE) {
  group.updateMatrixWorld(true);
  const points = new Map();

  group.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh) || !mesh.visible || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position || position.count < 3) return;

    const index = mesh.geometry.getIndex();
    const triangleCount = Math.floor((index?.count ?? position.count) / 3);
    const sampleCount = Math.min(4, triangleCount);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const triangle = Math.floor(((sample + 0.5) * triangleCount) / sampleCount);
      const vertex = (corner) => {
        const offset = triangle * 3 + corner;
        const vertexIndex = index ? index.getX(offset) : offset;
        return new THREE.Vector3().fromBufferAttribute(position, vertexIndex).applyMatrix4(mesh.matrixWorld);
      };
      const a = vertex(0);
      const b = vertex(1);
      const c = vertex(2);
      const center = a.add(b).add(c).multiplyScalar(1 / 3);
      const snapped = query.findClosestPoint({ x: center.x, y: center.y, z: center.z });
      if (!snapped.success) continue;

      const point = snapped.point;
      const key = `${Math.round(point.x / 8)}:${Math.round(point.z / 8)}`;
      if (!points.has(key)) points.set(key, { x: point.x, y: point.y, z: point.z });
    }
  });

  return [...points.values()];
}

function spreadCandidates(candidates, count) {
  if (candidates.length <= count) return candidates;
  const remaining = new Set(candidates.map((_, index) => index));
  const selected = [0];
  remaining.delete(0);

  while (selected.length < count && remaining.size) {
    let bestIndex = -1;
    let bestDistance = -1;
    for (const index of remaining) {
      const point = candidates[index];
      let nearest = Number.POSITIVE_INFINITY;
      for (const selectedIndex of selected) {
        const other = candidates[selectedIndex];
        nearest = Math.min(nearest, Math.hypot(point.x - other.x, point.z - other.z));
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    selected.push(bestIndex);
    remaining.delete(bestIndex);
  }

  return selected.map((index) => candidates[index]);
}

function routeLength(query, start, end) {
  const result = query.computePath(start, end);
  if (!result.success || result.path.length < 2) return null;
  const last = result.path[result.path.length - 1];
  if (Math.hypot(last.x - end.x, last.y - end.y, last.z - end.z) > 2) return null;

  let length = 0;
  for (let i = 1; i < result.path.length; i += 1) {
    const a = result.path[i - 1];
    const b = result.path[i];
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return length;
}

function connectedScenario(points, query) {
  const count = points.length;
  const lengths = Array.from({ length: count }, () => Array(count).fill(null));
  for (let i = 0; i < count; i += 1) {
    lengths[i][i] = 0;
    for (let j = i + 1; j < count; j += 1) {
      const length = routeLength(query, points[i], points[j]);
      lengths[i][j] = length;
      lengths[j][i] = length;
    }
  }

  const best = [];
  for (let spawnIndex = 0; spawnIndex < count; spawnIndex += 1) {
    for (let firstExit = 0; firstExit < count; firstExit += 1) {
      if (firstExit === spawnIndex || lengths[spawnIndex][firstExit] == null) continue;
      for (let secondExit = firstExit + 1; secondExit < count; secondExit += 1) {
        if (secondExit === spawnIndex || lengths[spawnIndex][secondExit] == null) continue;
        const a = points[firstExit];
        const b = points[secondExit];
        const spawn = points[spawnIndex];
        const vx = b.x - a.x;
        const vz = b.z - a.z;
        const exitDistance = Math.hypot(vx, vz);
        if (exitDistance < 20) continue;
        const projection = ((spawn.x - a.x) * vx + (spawn.z - a.z) * vz) / (exitDistance * exitDistance);
        if (projection < 0.15 || projection > 0.85) continue;

        const firstLength = lengths[spawnIndex][firstExit];
        const secondLength = lengths[spawnIndex][secondExit];
        if (firstLength < 10 || secondLength < 10) continue;
        const score = -Math.max(firstLength, secondLength) - Math.abs(firstLength - secondLength) * 3;
        if (best.length < 30 || score > best[best.length - 1].score) {
          best.push({ score, spawn, exits: [a, b], routeLengths: [firstLength, secondLength] });
          best.sort((left, right) => right.score - left.score);
          if (best.length > 30) best.pop();
        }
      }
    }
  }
  return best;
}

async function main() {
  for (const file of [visualPath, navPath, inspectionPath]) {
    await fs.access(file).catch(() => fail(`Required generated file is missing: ${file}`));
  }

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    const inspection = await fs.readFile(inspectionPath, 'utf8');
    const get = (pattern, label) => {
      const value = inspection.match(pattern)?.[1];
      return value ?? fail(`Could not read ${label} from the generated inspection report.`);
    };
    manifest = {
      sourceFile: null,
      sourceSha256: get(/SHA-256: `([^`]+)`/, 'source hash'),
      sourceSize: Number(get(/Size: ([\d,]+) bytes/, 'source size').replaceAll(',', '')),
      sourceUnit: get(/FBX source unit: `([^`]+)`/, 'source unit'),
      scaleToMetres: Number(get(/Blender-imported coordinate scale to metres: `?([\d.eE+-]+)`?/, 'metre scale')),
    };
  }
  if (agentCount > 100) {
    const baselinePath = path.join(output, 'validation-100.json');
    const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8').catch(() => fail('Run and pass the 100-agent validation before larger benchmarks.')));
    if (baseline.status !== 'PASS' || baseline.source?.sha256 !== manifest.sourceSha256) {
      fail('The 100-agent validation must pass for this source file before larger benchmarks.');
    }
  }
  const [visualStat, navStat] = await Promise.all([
    fs.stat(visualPath),
    fs.stat(navPath),
  ]);
  const vite = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    root,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  let simulation;
  try {
    const [{ loadGlbFile }, { buildNavigation }, THREE, { EvacuationSimulation }] = await Promise.all([
      vite.ssrLoadModule('/src/importers/gltf.ts'),
      vite.ssrLoadModule('/src/navigation.ts'),
      import('three'),
      vite.ssrLoadModule('/src/simulation.ts'),
    ]);

    console.log('UAT_PROGRESS=loading visual and navigation GLB');
    let visualGroup = await loadGlbFile(await readModelFile(visualPath));
    let visualMeshes = 0;
    let visualTriangles = 0;
    visualGroup.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      visualMeshes += 1;
      const position = object.geometry.getAttribute('position');
      visualTriangles += Math.floor((object.geometry.getIndex()?.count ?? position?.count ?? 0) / 3);
    });
    visualGroup.traverse((object) => {
      object.geometry?.dispose?.();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose?.();
    });
    visualGroup.clear();
    visualGroup = null;
    globalThis.gc?.();
    const navGroup = await loadGlbFile(await readModelFile(navPath));

    console.log('UAT_PROGRESS=building NavMesh with application code');
    const navigation = await buildNavigation(navGroup);
    const walkableCandidates = meshCandidates(navGroup, navigation.query, THREE);
    const scenarioPoints = spreadCandidates(walkableCandidates, 160);
    if (scenarioPoints.length < 3) fail(`Only ${scenarioPoints.length} walkable NavMesh locations could be sampled.`);
    console.log(`UAT_PROGRESS=checking routes across ${scenarioPoints.length} NavMesh samples`);
    const scenarios = connectedScenario(scenarioPoints, navigation.query);
    if (!scenarios.length) fail('Could not find one spawn location with connected routes to two distinct exits.');

    const { Vector3 } = THREE;
    const createSimulation = (scenario) => {
      const [firstExit, secondExit] = scenario.exits;
      const dx = secondExit.x - firstExit.x;
      const dz = secondExit.z - firstExit.z;
      const length = Math.hypot(dx, dz) || 1;
      const alongX = dx / length;
      const alongZ = dz / length;
      const acrossX = -alongZ;
      const acrossZ = alongX;
      const spreadScale = Math.sqrt(agentCount / 100);
      const halfLength = Math.min(6 * spreadScale, length * 0.2);
      const halfWidth = 5 * spreadScale;
      const points = [
        [-halfLength, -halfWidth], [halfLength, -halfWidth],
        [halfLength, halfWidth], [-halfLength, halfWidth],
      ].map(([along, across]) => ({
        x: scenario.spawn.x + alongX * along + acrossX * across,
        z: scenario.spawn.z + alongZ * along + acrossZ * across,
      }));

      return new EvacuationSimulation(
      navigation.navMesh,
      navigation.query,
      null,
      scenario.exits.map((point, index) => ({
        id: index + 1,
        name: `Model validation exit ${index + 1}`,
        width: 3,
        position: new Vector3(point.x, point.y, point.z),
      })),
      {
        occupants: agentCount,
        walkingSpeed: 1.2,
        spawnRadius: 6,
        profilePreset: 'mixed',
        preMovementMax: 0,
        seed: 20261005,
        limitExitFlow: false,
        specificFlow: 1.3,
        boundaryLayer: 0.3,
        defaultExitWidth: 3,
        spawnAreas: [{
          id: 'validation-spawn',
          name: 'Model validation spawn area',
          points,
          elevation: scenario.spawn.y,
          occupants: agentCount,
        }],
      },
    );
    };

    let scenario = null;
    let bestAssignment = null;
    for (const candidate of scenarios) {
      const trial = createSimulation(candidate);
      const counts = [0, 0];
      for (const agent of trial.agents) counts[agent.exit.id - 1] += 1;
      if (!bestAssignment || Math.min(...counts) > Math.min(...bestAssignment.counts)) {
        bestAssignment = { candidate, counts };
      }
      if (counts[0] > 0 && counts[1] > 0) {
        scenario = candidate;
        simulation = trial;
        break;
      }
      trial.dispose();
    }
    if (!simulation) {
      fail(`Spawn candidates did not assign agents to both exits; best assignment was ${JSON.stringify(bestAssignment?.counts || [])}.`);
    }
    if (simulation.agents.length !== agentCount) fail(`Spawn Area placed ${simulation.agents.length} of ${agentCount} agents.`);

    console.log(`UAT_PROGRESS=running ${agentCount}-agent evacuation`);
    simulation.start();
    const maxSteps = 30 * 1800;
    for (let step = 0; step < maxSteps; step += 1) {
      simulation.update(1 / 30);
      if (step % 30 === 0 && simulation.snapshot().evacuated === agentCount) break;
    }
    const snapshot = simulation.snapshot();
    const exitCounts = Object.fromEntries(snapshot.exitCounts);
    if (snapshot.evacuated !== agentCount) {
      const pending = simulation.agents
        .filter((agent) => agent.evacuatedAt === null)
        .map((agent) => {
          const position = agent.agent.position();
          return {
            id: agent.id,
            exitId: agent.exit.id,
            distanceToExit: Math.hypot(position.x - agent.exit.position.x, position.y - agent.exit.position.y, position.z - agent.exit.position.z),
            travelDistance: agent.travelDistance,
            position: { x: position.x, y: position.y, z: position.z },
          };
        });
      await fs.writeFile(csvPath, simulation.toCsv(), 'utf8');
      const debug = {
        evacuated: snapshot.evacuated,
        exitCounts,
        simulatedSeconds: snapshot.time,
        pending,
        routeValidation: scenario,
      };
      await fs.writeFile(path.join(output, 'validation-debug.json'), `${JSON.stringify(debug, null, 2)}\n`, 'utf8');
      const csvRows = simulation.toCsv().trimEnd().split(/\r?\n/);
      const partialReport = {
        generatedAt: new Date().toISOString(),
        source: {
          path: manifest.sourceFile,
          sha256: manifest.sourceSha256,
          sizeBytes: manifest.sourceSize,
          unit: manifest.sourceUnit,
          unitLabel: manifest.sourceUnitLabel || null,
          fbxUnitScaleFactorCm: manifest.fbxUnitScaleFactorCm ?? null,
          scaleToMetres: manifest.scaleToMetres,
        },
        derivatives: {
          visual: { bytes: visualStat.size, meshCount: visualMeshes, triangleCount: visualTriangles },
          navigation: { bytes: navStat.size },
        },
        navigation: navigation.metrics,
        routeValidation: {
          sampledLocations: scenarioPoints.length,
          spawn: scenario.spawn,
          exits: scenario.exits,
          routeLengthsMetres: scenario.routeLengths,
        },
        simulation: {
          requestedAgents: agentCount,
          placedAgents: simulation.agents.length,
          evacuatedAgents: snapshot.evacuated,
          activeAgents: agentCount - snapshot.evacuated,
          simulatedSeconds: snapshot.time,
          exitCounts,
          averageEvacuationSeconds: snapshot.averageEvacuationTime,
          p95EvacuationSeconds: snapshot.p95EvacuationTime,
          csvPath,
          csvRows: csvRows.length - 1,
          pending,
        },
        status: 'PARTIAL',
      };
      partialReport.scaleValidation = manifest.scaleValidation || null;
      await fs.writeFile(reportPath, `${JSON.stringify(partialReport, null, 2)}\n`, 'utf8');
      fail(`Only ${snapshot.evacuated} of ${agentCount} agents evacuated in ${snapshot.time.toFixed(1)} simulated seconds; exits=${JSON.stringify(exitCounts)}, pending=${JSON.stringify(pending.slice(0, 8))}.`);
    }
    if (Object.values(exitCounts).filter((count) => count > 0).length !== 2) fail(`Agents did not use both exits: ${JSON.stringify(exitCounts)}`);

    const csv = simulation.toCsv();
    const csvRows = csv.trimEnd().split(/\r?\n/);
    if (csvRows.length !== agentCount + 1 || !csvRows[0].startsWith('agent_id,profile,')) {
      fail(`Expected a header and ${agentCount} CSV rows, got ${csvRows.length} lines.`);
    }
    await fs.writeFile(csvPath, csv, 'utf8');

    const report = {
      generatedAt: new Date().toISOString(),
      source: {
        path: manifest.sourceFile,
        sha256: manifest.sourceSha256,
        sizeBytes: manifest.sourceSize,
        unit: manifest.sourceUnit,
        unitLabel: manifest.sourceUnitLabel || null,
        fbxUnitScaleFactorCm: manifest.fbxUnitScaleFactorCm ?? null,
        scaleToMetres: manifest.scaleToMetres,
      },
      derivatives: {
        visual: { bytes: visualStat.size, meshCount: visualMeshes, triangleCount: visualTriangles },
        navigation: { bytes: navStat.size },
      },
      navigation: navigation.metrics,
      scaleValidation: manifest.scaleValidation || null,
      routeValidation: {
        sampledLocations: scenarioPoints.length,
        spawn: scenario.spawn,
        exits: scenario.exits,
        routeLengthsMetres: scenario.routeLengths,
      },
      simulation: {
        requestedAgents: agentCount,
        placedAgents: simulation.agents.length,
        evacuatedAgents: snapshot.evacuated,
        simulatedSeconds: snapshot.time,
        exitCounts,
        averageEvacuationSeconds: snapshot.averageEvacuationTime,
        p95EvacuationSeconds: snapshot.p95EvacuationTime,
        csvPath,
        csvRows: csvRows.length - 1,
      },
      status: 'PASS',
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    simulation?.dispose();
    await vite.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

export { meshCandidates, spreadCandidates, routeLength, connectedScenario };

import './styles.css';
import * as THREE from 'three';
import { createDemoBuilding } from './demo';
import { BuildEditor, type BuildTool } from './build/editor';
import { loadFbxFile } from './importers/fbx';
import { loadGlbFile } from './importers/gltf';
import {
  loadIfcFile,
  type IfcSemantics,
} from './importers/ifc';
import { selectModelFiles } from './importers/model-files';
import { buildNavigation, type NavigationState } from './navigation';
import {
  createEvacSimModel,
  MODEL_STORAGE_KEY,
  parseEvacSimModelFile,
  type EvacSimModel,
  type SavedSimulationSettings,
  type ScenarioSource,
} from './model-store';
import { type ProfilePreset } from './profiles';
import { ScenarioStore } from './scenarios';
import {
  EvacuationSimulation,
  type ExitTarget,
  type SpawnAreaTarget,
} from './simulation';
import { EvacViewer } from './viewer';

function element<T extends HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing UI element: ' + id);
  return node as T;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return entities[character] || character;
  });
}

const viewer = new EvacViewer(element<HTMLDivElement>('viewport'));
const statusEl = element<HTMLDivElement>('engineStatus');
const toast = element<HTMLDivElement>('placementToast');
const modelScale = element<HTMLInputElement>('modelScale');
const fileInput = element<HTMLInputElement>('fileInput');
const dropzone = element<HTMLLabelElement>('dropzone');
const showNav = element<HTMLInputElement>('showNav');
const showHeatmap = element<HTMLInputElement>('showHeatmap');
const showAgentLocations = element<HTMLInputElement>('showAgentLocations');
const playbackSpeedInput = element<HTMLInputElement>('playbackSpeed');
const bridgeIfcStairs = element<HTMLInputElement>('bridgeIfcStairs');
const profilePreset = element<HTMLSelectElement>('profilePreset');
const speedInput = element<HTMLInputElement>('speed');
const scenarioStore = new ScenarioStore();

type WorkspaceMode = 'view' | 'build' | 'simulate';
let workspaceMode: WorkspaceMode = 'simulate';
let buildEditor = new BuildEditor();
viewer.scene.add(buildEditor.preview);
viewer.modelStage.add(buildEditor.root);

let navigation: NavigationState | null = null;
let importedNavigationRoot: THREE.Group | null = null;
let simulation: EvacuationSimulation | null = null;
let spawn: THREE.Vector3 | null = null;
let exits: ExitTarget[] = [];
let resultExits: ExitTarget[] = [];
let previewSpawnAreas: SpawnAreaTarget[] | null = null;
let ifcSemantics: IfcSemantics | null = null;
let placementMode: 'spawn' | 'exit' | null = null;
let scenarioSource: ScenarioSource = 'manual';
let modelDirty = true;
let spawnCreationArmed = false;
let lastUiUpdate = 0;
let previewCameraFollow = false;
let lastPreviewCameraFollow = 0;

function disposeDetachedNavigationRoot() {
  if (!importedNavigationRoot) return;
  if (importedNavigationRoot !== viewer.modelRoot) {
    importedNavigationRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
  }
  importedNavigationRoot = null;
}

function resetBuildEditor() {
  spawnCreationArmed = false;
  buildEditor.dispose();
  buildEditor = new BuildEditor();
  viewer.scene.add(buildEditor.preview);
  viewer.modelStage.add(buildEditor.root);
  updateSelectedBuildElement();
}

function syncBuildSettings() {
  buildEditor.setSettings({
    elevation: Number(element<HTMLInputElement>('buildElevation').value) || 0,
    grid: Number(element<HTMLInputElement>('buildGrid').value) || 0.25,
    wallHeight: Number(element<HTMLInputElement>('wallHeight').value) || 3,
    wallThickness:
      Number(element<HTMLInputElement>('wallThickness').value) || 0.2,
    doorWidth: Number(element<HTMLInputElement>('doorWidth').value) || 1,
    doorIsExit: element<HTMLInputElement>('doorIsExit').checked,
    spawnOccupants:
      Number(element<HTMLInputElement>('spawnOccupants').value) || 50,
    exitWidth:
      Number(element<HTMLInputElement>('buildExitWidth').value) || 1.2,
    obstacleHeight:
      Number(element<HTMLInputElement>('obstacleHeight').value) || 1,
    stairRise: Number(element<HTMLInputElement>('stairRise').value) || 3,
    stairWidth: Number(element<HTMLInputElement>('stairWidth').value) || 1.2,
  });
}

function renderSpawnAreaManager() {
  const container = element<HTMLDivElement>('spawnAreaManager');
  const areas = buildEditor.getSpawnAreas();
  container.replaceChildren();

  if (!areas.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No Spawn Areas yet.';
    container.appendChild(empty);
    return;
  }

  areas.forEach((area, index) => {
    const row = document.createElement('div');
    row.className = 'spawn-area-row';

    const head = document.createElement('div');
    head.className = 'spawn-area-row-head';

    const title = document.createElement('span');
    title.textContent = 'Spawn Area ' + (index + 1);

    const elevation = document.createElement('small');
    elevation.textContent = 'elev. ' + area.elevation.toFixed(2) + ' m';

    head.append(title, elevation);

    const edit = document.createElement('div');
    edit.className = 'spawn-area-edit';

    const label = document.createElement('label');
    label.textContent = 'People';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '5000';
    input.step = '1';
    input.value = String(area.occupants);
    input.dataset.spawnId = area.id;
    label.appendChild(input);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = 'Save';

    const status = document.createElement('div');
    status.className = 'spawn-area-status';
    status.textContent = 'Saved · ' + area.occupants + ' people';

    const saveValue = () => {
      const result = buildEditor.updateSpawnOccupants(
        area.id,
        Number(input.value),
      );

      if (!result.completed) {
        status.className = 'spawn-area-status error';
        status.textContent = result.message;
        return;
      }

      input.value = String(
        buildEditor
          .getSpawnAreas()
          .find((item) => item.id === area.id)?.occupants ?? input.value,
      );
      status.className = 'spawn-area-status saved';
      status.textContent = result.message;
      resetSimulation();
      markModelDirty('Spawn population changed · unsaved');

      const stats = buildEditor.stats();
      element('buildSpawnOccupants').textContent =
        String(stats.spawnOccupants);
      updateScenarioSummary();

      setStatus(
        'Spawn Area ' +
          (index + 1) +
          ' saved · ' +
          input.value +
          ' people',
      );
    };

    input.addEventListener('input', () => {
      status.className = 'spawn-area-status unsaved';
      status.textContent =
        'Unsaved · press Save or Enter';
    });

    input.addEventListener('change', saveValue);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      saveValue();
    });
    save.addEventListener('click', saveValue);

    edit.append(label, save);
    row.append(head, edit, status);
    container.appendChild(row);
  });
}

function updateBuildStats() {
  const stats = buildEditor.stats();
  element('buildFloors').textContent = String(stats.floors);
  element('buildSpawnAreas').textContent = String(stats.spawnAreas);
  element('buildSpawnOccupants').textContent = String(stats.spawnOccupants);
  element('buildWalls').textContent = String(stats.walls);
  element('buildDoors').textContent = String(stats.doors);
  element('buildExitDoors').textContent = String(stats.exitDoors);
  element('buildDirectExits').textContent = String(stats.directExits);
  element('buildObstacles').textContent = String(stats.obstacles);
  element('buildStairs').textContent = String(stats.stairs);
  renderSpawnAreaManager();
  updateScenarioSummary();
}

function setBuildHint(message: string) {
  element('buildHint').textContent = message;
}

function updateSelectedBuildElement() {
  const selected = buildEditor.getSelected();
  const label = element<HTMLDivElement>('selectedBuildElement');

  if (!selected) {
    label.textContent = 'Nothing selected';
    label.classList.remove('active');
    return;
  }

  label.classList.add('active');
  label.textContent =
    selected.type === 'spawn'
      ? 'SPAWN AREA · ' +
        selected.occupants +
        ' people · ' +
        selected.id.slice(0, 8)
      : selected.type.toUpperCase() + ' · ' + selected.id.slice(0, 8);
}

function updateBuildToolSettings(tool: BuildTool) {
  const settingGroups: Array<[string, BuildTool]> = [
    ['wallToolSettings', 'wall'],
    ['doorToolSettings', 'door'],
    ['spawnToolSettings', 'spawn'],
    ['exitToolSettings', 'exit'],
    ['obstacleToolSettings', 'obstacle'],
    ['stairToolSettings', 'stair'],
  ];

  for (const [id, activeTool] of settingGroups) {
    element(id).classList.toggle('hidden', tool !== activeTool);
  }

  const newSpawnEditor = element('newSpawnAreaEditor');
  newSpawnEditor.classList.toggle(
    'hidden',
    tool !== 'spawn' || !spawnCreationArmed,
  );

  const startSpawnButton =
    element<HTMLButtonElement>('startNewSpawnAreaBtn');
  startSpawnButton.disabled =
    tool === 'spawn' && spawnCreationArmed;
  startSpawnButton.textContent =
    tool === 'spawn' && spawnCreationArmed
      ? 'Drawing new Spawn Area…'
      : '+ Add Spawn Area';

  const finishButton = element<HTMLButtonElement>('finishFloorBtn');
  const cancelButton = element<HTMLButtonElement>('cancelBuildBtn');
  const polygonTool =
    tool === 'floor' ||
    (tool === 'spawn' && spawnCreationArmed);
  const multiPointTool =
    polygonTool ||
    tool === 'wall' ||
    tool === 'obstacle' ||
    tool === 'stair';

  finishButton.classList.toggle('hidden', !polygonTool);
  cancelButton.classList.toggle('hidden', !multiPointTool);
  element('buildDrawActions').classList.toggle(
    'hidden',
    !polygonTool && !multiPointTool,
  );
}

function setBuildTool(tool: BuildTool) {
  spawnCreationArmed = false;
  buildEditor.setTool(tool);
  updateBuildToolSettings(tool);
  const mapping: Array<[string, BuildTool]> = [
    ['toolSelect', 'select'],
    ['toolFloor', 'floor'],
    ['toolSpawn', 'spawn'],
    ['toolWall', 'wall'],
    ['toolDoor', 'door'],
    ['toolExit', 'exit'],
    ['toolObstacle', 'obstacle'],
    ['toolStair', 'stair'],
  ];

  for (const [id, value] of mapping) {
    element<HTMLButtonElement>(id).classList.toggle('active', value === tool);
  }

  const instructions: Record<BuildTool, string> = {
    none: 'Choose a drawing tool.',
    select: 'Click a drawn element to select it for move/delete.',
    floor:
      'Click floor / corridor polygon points on the current elevation, then press Finish polygon.',
    spawn:
      'Edit existing Spawn Areas below, or click + Add Spawn Area to draw another one.',
    wall: 'Click the wall start and end points.',
    door:
      'Click near a wall. The wall will be split to create a real opening using Door width.',
    exit:
      'Click once on the plan to add an Exit using the configured Exit width.',
    obstacle: 'Click two opposite corners of the obstacle footprint.',
    stair:
      'Click the stair start and end plan positions. End elevation = current elevation + stair rise.',
  };

  setBuildHint(instructions[tool]);
}

function updateSimulationWorkspaceLock() {
  const locked = Boolean(simulation);
  const buildButton = element<HTMLButtonElement>('modeBuildBtn');
  buildButton.disabled = locked;
  buildButton.title = locked
    ? 'Reset the simulation before editing the model'
    : '';
}

function setWorkspaceMode(mode: WorkspaceMode) {
  if (mode === 'build' && simulation) {
    setStatus(
      'Reset the current simulation before editing the model',
      'error',
    );
    updateSimulationWorkspaceLock();
    return;
  }

  workspaceMode = mode;
  document.body.classList.toggle('build-mode', mode === 'build');

  element('buildSection').classList.toggle('hidden', mode !== 'build');
  document.querySelectorAll<HTMLElement>('.simulate-section').forEach((section) => {
    section.classList.toggle('hidden', mode !== 'simulate');
  });

  const buttons: Array<[string, WorkspaceMode]> = [
    ['modeViewBtn', 'view'],
    ['modeBuildBtn', 'build'],
    ['modeSimulateBtn', 'simulate'],
  ];

  for (const [id, value] of buttons) {
    element<HTMLButtonElement>(id).classList.toggle('active', value === mode);
  }

  viewer.setBuildInteraction(mode === 'build');

  if (mode !== 'build') {
    buildEditor.cancelActive();
  }
}

function invalidateNavigation(message = 'Geometry changed · rebuild NavMesh') {
  clearNavigation();
  updateBuildStats();
  setStatus(message, 'busy');
}

function setStatus(message: string, kind: 'ok' | 'busy' | 'error' = 'ok') {
  statusEl.className = 'status-pill ' + kind;
  statusEl.innerHTML = '<span></span> ' + message;
}

function currentScale() {
  return Number(modelScale.value) || 1;
}

function updateScenarioSummary() {
  const spawnAreas = buildEditor.getSpawnAreas();
  const builtExits = buildEditor.getExitCandidates();
  const builtOccupants = spawnAreas.reduce(
    (sum, area) => sum + area.occupants,
    0,
  );

  if (scenarioSource === 'built' && spawnAreas.length === 0) {
    scenarioSource = 'manual';
  }

  const builtRadio = element<HTMLInputElement>('scenarioSourceBuilt');
  const manualRadio = element<HTMLInputElement>('scenarioSourceManual');
  builtRadio.disabled = spawnAreas.length === 0;
  builtRadio.checked = scenarioSource === 'built';
  manualRadio.checked = scenarioSource === 'manual';

  element('builtScenarioPanel').classList.toggle(
    'hidden',
    scenarioSource !== 'built',
  );
  element('manualScenarioPanel').classList.toggle(
    'hidden',
    scenarioSource !== 'manual',
  );

  element('builtPopulationTotal').textContent =
    builtOccupants + ' people';
  element('builtSpawnState').textContent = String(spawnAreas.length);
  element('builtExitState').textContent = String(builtExits.length);
  element('spawnState').textContent = spawn ? 'set' : 'not set';
  element('exitState').textContent = String(exits.length);

  const breakdown = element<HTMLDivElement>('builtPopulationBreakdown');
  breakdown.innerHTML = spawnAreas.length
    ? spawnAreas
        .map(
          (area, index) =>
            '<div class="population-row"><span>' +
            escapeHtml(area.name || 'Spawn Area ' + (index + 1)) +
            '</span><b>' +
            area.occupants +
            '</b></div>',
        )
        .join('')
    : '<div class="empty">Create a Spawn Area in Build Mode.</div>';

  viewer.setMarkers(
    scenarioSource === 'manual' ? spawn : null,
    scenarioSource === 'manual' ? exits : [],
  );
}

function setModelSaveStatus(
  message: string,
  state: 'unsaved' | 'saved' | 'error',
) {
  const node = element<HTMLDivElement>('modelSaveStatus');
  node.className = 'model-save-status ' + state;
  node.textContent = message;
}

function markModelDirty(message = 'Unsaved changes') {
  modelDirty = true;
  setModelSaveStatus(message, 'unsaved');
}

function refreshSavedModelButton() {
  element<HTMLButtonElement>('loadSavedModelBtn').disabled =
    !localStorage.getItem(MODEL_STORAGE_KEY);
}

function currentSimulationSettings(): SavedSimulationSettings {
  return {
    scenarioSource,
    profilePreset: profilePreset.value,
    walkingSpeed: Number(speedInput.value),
    preMovementMax:
      Number(element<HTMLInputElement>('preMovement').value),
    seed: Number(element<HTMLInputElement>('simSeed').value) || 1,
    limitExitFlow:
      element<HTMLInputElement>('limitExitFlow').checked,
    specificFlow:
      Number(element<HTMLInputElement>('specificFlow').value) || 1.316,
    boundaryLayer:
      Number(element<HTMLInputElement>('boundaryLayer').value) || 0,
    defaultExitWidth:
      Number(element<HTMLInputElement>('defaultExitWidth').value) || 1,
    manualOccupants:
      Number(element<HTMLInputElement>('occupants').value) || 1,
    manualSpawnRadius:
      Number(element<HTMLInputElement>('spawnRadius').value) || 3,
  };
}

function currentModel(): EvacSimModel {
  const plan = JSON.parse(buildEditor.exportPlan());
  const manualScenario = {
    spawn: spawn
      ? { x: spawn.x, y: spawn.y, z: spawn.z }
      : null,
    exits: exits.map((exit) => ({
      name: exit.name,
      width: exit.width,
      position: {
        x: exit.position.x,
        y: exit.position.y,
        z: exit.position.z,
      },
    })),
  };

  return createEvacSimModel(
    element<HTMLInputElement>('modelName').value,
    plan,
    currentSimulationSettings(),
    manualScenario,
  );
}

function applySimulationSettings(settings: SavedSimulationSettings) {
  scenarioSource = settings.scenarioSource || 'manual';
  profilePreset.value = settings.profilePreset || 'adult';
  speedInput.value = String(settings.walkingSpeed || 1.25);
  element<HTMLInputElement>('preMovement').value = String(
    settings.preMovementMax ?? 15,
  );
  element<HTMLInputElement>('simSeed').value = String(settings.seed || 1);
  element<HTMLInputElement>('limitExitFlow').checked =
    settings.limitExitFlow !== false;
  element<HTMLInputElement>('specificFlow').value = String(
    settings.specificFlow || 1.316,
  );
  element<HTMLInputElement>('boundaryLayer').value = String(
    settings.boundaryLayer ?? 0.15,
  );
  element<HTMLInputElement>('defaultExitWidth').value = String(
    settings.defaultExitWidth || 1,
  );
  element<HTMLInputElement>('occupants').value = String(
    settings.manualOccupants || 120,
  );
  element<HTMLInputElement>('spawnRadius').value = String(
    settings.manualSpawnRadius || 3,
  );

  for (const id of [
    'occupants',
    'speed',
    'preMovement',
    'spawnRadius',
  ]) {
    element<HTMLInputElement>(id).dispatchEvent(new Event('input'));
  }

  updateProfileControls();
}

async function loadModelData(
  model: EvacSimModel,
  savedLocally: boolean,
) {
  clearNavigation();
  clearScenario();
  ifcSemantics = null;
  updateIfcSummary();

  resetBuildEditor();
  const root = new THREE.Group();
  root.name = model.name || 'EvacSim model';
  modelScale.value = '1';
  disposeDetachedNavigationRoot();
  viewer.setModel(root, 1);

  buildEditor.importPlan(JSON.stringify(model.plan));
  if (buildEditor.root.parent !== viewer.modelStage) {
    viewer.modelStage.add(buildEditor.root);
  }

  spawn = model.manualScenario.spawn
    ? new THREE.Vector3(
        model.manualScenario.spawn.x,
        model.manualScenario.spawn.y,
        model.manualScenario.spawn.z,
      )
    : null;

  exits = model.manualScenario.exits.map((exit, index) => ({
    id: index + 1,
    name: exit.name || 'Manual Exit ' + (index + 1),
    width: exit.width,
    position: new THREE.Vector3(
      exit.position.x,
      exit.position.y,
      exit.position.z,
    ),
  }));

  element<HTMLInputElement>('modelName').value =
    model.name || 'Untitled model';
  applySimulationSettings(model.simulation);
  viewer.fit(viewer.modelStage);
  updateBuildStats();
  updateSelectedBuildElement();
  updateScenarioSummary();

  modelDirty = !savedLocally;
  setModelSaveStatus(
    savedLocally
      ? 'Saved model loaded · ' +
          new Date(model.savedAt).toLocaleString()
      : 'Imported model · save to keep it in this browser',
    savedLocally ? 'saved' : 'unsaved',
  );

  if (buildEditor.stats().floors > 0) {
    await rebuildNavigation(false);
  }
}

function saveModelToBrowser() {
  try {
    const model = currentModel();
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(model));
    modelDirty = false;
    setModelSaveStatus(
      'Saved · ' + new Date(model.savedAt).toLocaleTimeString(),
      'saved',
    );
    refreshSavedModelButton();
    setStatus('Model saved');
  } catch (error) {
    console.error(error);
    setModelSaveStatus('Could not save model', 'error');
    setStatus('Could not save model', 'error');
  }
}

function downloadModel() {
  const model = currentModel();
  const blob = new Blob([JSON.stringify(model, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = model.name
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'evacsim-model';
  link.href = url;
  link.download = safeName + '.evacsim.json';
  link.click();
  URL.revokeObjectURL(url);
  setStatus('Model downloaded');
}

async function loadSavedModel() {
  const raw = localStorage.getItem(MODEL_STORAGE_KEY);
  if (!raw) {
    setModelSaveStatus('No saved model in this browser', 'error');
    return;
  }

  try {
    const model = parseEvacSimModelFile(
      raw,
      currentSimulationSettings(),
    );
    await loadModelData(model, true);
  } catch (error) {
    console.error(error);
    setModelSaveStatus('Saved model is invalid', 'error');
  }
}

async function importModelFile(file: File) {
  try {
    const model = parseEvacSimModelFile(
      await file.text(),
      currentSimulationSettings(),
    );
    await loadModelData(model, false);
  } catch (error) {
    console.error(error);
    setModelSaveStatus(
      error instanceof Error ? error.message : 'Model import failed',
      'error',
    );
  }
}

function setScenarioSource(
  source: ScenarioSource,
  markDirty = true,
) {
  const spawnAreas = buildEditor.getSpawnAreas();

  if (source === 'built' && spawnAreas.length === 0) {
    scenarioSource = 'manual';
    setStatus('Create a Spawn Area before using Built scenario', 'error');
  } else {
    scenarioSource = source;
    resetSimulation();
    if (markDirty) markModelDirty('Scenario source changed · unsaved');
  }

  updateScenarioSummary();
}

function updateIfcSummary() {
  const semantics = ifcSemantics;
  element('ifcStoreys').textContent = semantics ? String(semantics.storeys.length) : '—';
  element('ifcSpaces').textContent = semantics ? String(semantics.spaces.length) : '—';
  element('ifcDoors').textContent = semantics ? String(semantics.doors.length) : '—';
  element('ifcStairs').textContent = semantics ? String(semantics.stairs.length) : '—';
  element('ifcExitCandidates').textContent = semantics
    ? String(semantics.exitCandidates.length)
    : '—';

  const storeyNames = element('ifcStoreyNames');

  if (!semantics) {
    storeyNames.textContent = 'Import IFC to inspect semantics.';
  } else if (!semantics.storeys.length) {
    storeyNames.textContent = 'No IfcBuildingStorey entities detected.';
  } else {
    storeyNames.textContent = semantics.storeys
      .map((storey) => {
        const elevation = storey.elevation == null
          ? ''
          : ' · ' + storey.elevation.toFixed(2);
        return storey.name + elevation;
      })
      .join(' / ');
  }

  element<HTMLButtonElement>('useIfcExits').disabled =
    !navigation || !semantics || semantics.exitCandidates.length === 0;
}

function resetSimulation() {
  if (simulation) {
    simulation.dispose();
    simulation = null;
  }

  viewer.clearHeatmap();
  viewer.clearAgentLocations();
  resultExits = [];
  element<HTMLButtonElement>('exportBtn').disabled = true;
  element<HTMLButtonElement>('saveScenario').disabled = true;
  element<HTMLButtonElement>('pauseBtn').textContent = 'Pause';
  updateSimulationWorkspaceLock();
  updateResults();
}

function clearNavigation() {
  resetSimulation();

  if (!navigation) {
    updateIfcSummary();
    return;
  }

  navigation.helper.removeFromParent();
  navigation.helper.dispose();
  navigation.query.destroy();
  navigation.navMesh.destroy();
  navigation = null;
  updateIfcSummary();
}

function clearScenario() {
  resetSimulation();
  spawn = null;
  exits = [];
  updateScenarioSummary();
}

function buildIfcStairLinks() {
  if (!bridgeIfcStairs.checked || !ifcSemantics) return [];

  const scale = currentScale();

  return ifcSemantics.stairs
    .filter((stair) => stair.lowerPoint && stair.upperPoint)
    .map((stair) => {
      const start = stair.lowerPoint!.clone().multiplyScalar(scale);
      const end = stair.upperPoint!.clone().multiplyScalar(scale);

      return {
        startPosition: { x: start.x, y: start.y, z: start.z },
        endPosition: { x: end.x, y: end.y, z: end.z },
        radius: 0.65,
        bidirectional: true,
        area: 0,
        flags: 1,
        userId: stair.expressID,
      };
    });
}

async function rebuildNavigation(useDemoScenario: boolean) {
  if (!viewer.modelRoot) return;

  clearNavigation();
  setStatus('Building NavMesh...', 'busy');

  try {
    const stairLinks = [
      ...buildIfcStairLinks(),
      ...buildEditor.getNavigationLinks(),
    ];
    const navigationInputs = importedNavigationRoot
      ? [importedNavigationRoot, buildEditor.root]
      : [viewer.modelStage];
    navigation = await buildNavigation(navigationInputs, stairLinks);
    if (import.meta.env.DEV) {
      console.info('[navigation] built', navigation.metrics);
    }
    navigation.helper.visible = showNav.checked;
    viewer.scene.add(navigation.helper);

    if (useDemoScenario) {
      const start = navigation.query.findClosestPoint({ x: -8, y: 0, z: 0 });
      const exitA = navigation.query.findClosestPoint({ x: 11.4, y: 0, z: -3.5 });
      const exitB = navigation.query.findClosestPoint({ x: 11.4, y: 0, z: 3.5 });

      if (start.success) {
        spawn = new THREE.Vector3(start.point.x, start.point.y, start.point.z);
      }

      exits = [];

      if (exitA.success) {
        exits.push({
          id: 1,
          name: 'Demo Exit A',
          position: new THREE.Vector3(exitA.point.x, exitA.point.y, exitA.point.z),
        });
      }

      if (exitB.success) {
        exits.push({
          id: exits.length + 1,
          name: 'Demo Exit B',
          position: new THREE.Vector3(exitB.point.x, exitB.point.y, exitB.point.z),
        });
      }

      updateScenarioSummary();
    }

    updateIfcSummary();
    updateBuildStats();
    setStatus(
      stairLinks.length
        ? 'NavMesh ready · ' + stairLinks.length + ' stair link(s)'
        : 'NavMesh ready',
    );
  } catch (error) {
    console.error(error);
    updateIfcSummary();
    setStatus(error instanceof Error ? error.message : 'NavMesh failed', 'error');
  }
}

async function loadDemo() {
  setStatus('Loading demo...', 'busy');
  clearNavigation();
  clearScenario();
  ifcSemantics = null;
  updateIfcSummary();
  modelScale.value = '1';
  resetBuildEditor();
  const root = createDemoBuilding();
  disposeDetachedNavigationRoot();
  viewer.setModel(root, 1);
  scenarioSource = 'manual';
  markModelDirty('Demo loaded · unsaved');
  updateBuildStats();
  await rebuildNavigation(true);
}

async function importFiles(files: readonly File[]) {
  const importStartedAt = performance.now();
  let pendingNavigationRoot: THREE.Group | null = null;
  let loadNavigationOnly = false;
  try {
    const selection = selectModelFiles(files);
    const name = selection.kind === 'derivatives'
      ? `${selection.visualFile.name} + ${selection.navigationFile.name}`
      : selection.kind === 'glb'
        ? selection.visualFile.name
        : selection.file.name;
    if (selection.kind === 'derivatives' && selection.visualFile.size > 300 * 1024 * 1024) {
      loadNavigationOnly = !window.confirm(
        `The detailed zoo model is ${(selection.visualFile.size / 1e6).toFixed(0)} MB. Loading it can use several GB of memory.\n\nChoose OK to load the detailed model. Choose Cancel to load only the lightweight 3D walkable surfaces (${(selection.navigationFile.size / 1e6).toFixed(0)} MB).`,
      );
    } else if (selection.kind === 'glb' && selection.visualFile.size > 300 * 1024 * 1024) {
      if (!window.confirm(
        `This GLB is ${(selection.visualFile.size / 1e6).toFixed(0)} MB and may use several GB of memory. Load the detailed model?`,
      )) {
        setStatus('Import cancelled');
        return;
      }
    }
    if (selection.kind === 'derivatives') {
      // The preprocessing manifest and both GLBs are already expressed in metres.
      modelScale.value = '1';
    }
    const extension = selection.kind === 'ifc' || selection.kind === 'fbx'
      ? selection.kind
      : 'glb';
    setStatus(
      loadNavigationOnly
        ? 'Loading lightweight 3D walkable surfaces...'
        : 'Importing ' + (selection.kind === 'derivatives' ? 'GLB derivatives' : extension.toUpperCase()) + '...',
      'busy',
    );
    let root: THREE.Group;

    if (selection.kind === 'ifc') {
      const imported = await loadIfcFile(selection.file);
      root = imported.group;
      ifcSemantics = imported.semantics;
    } else if (selection.kind === 'fbx') {
      root = await loadFbxFile(selection.file);
      ifcSemantics = null;
    } else if (selection.kind === 'derivatives') {
      if (loadNavigationOnly) {
        root = await loadGlbFile(selection.navigationFile);
      } else {
        root = await loadGlbFile(selection.visualFile);
        pendingNavigationRoot = await loadGlbFile(selection.navigationFile);
      }
      ifcSemantics = null;
    } else {
      root = await loadGlbFile(selection.visualFile);
      ifcSemantics = null;
    }

    const scenePreparationStartedAt = performance.now();
    clearNavigation();
    clearScenario();
    updateIfcSummary();
    resetBuildEditor();
    disposeDetachedNavigationRoot();
    viewer.setModel(root, currentScale());
    if (pendingNavigationRoot && pendingNavigationRoot !== root) {
      importedNavigationRoot = pendingNavigationRoot;
      importedNavigationRoot.scale.setScalar(currentScale());
    }
    pendingNavigationRoot = null;
    scenarioSource = 'manual';
    markModelDirty('Imported source loaded · unsaved');
    updateBuildStats();
    if (import.meta.env.DEV) {
      console.info('[model] imported', {
        kind: selection.kind,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
        loadAndParseMs: scenePreparationStartedAt - importStartedAt,
        scenePreparationMs: performance.now() - scenePreparationStartedAt,
      });
    }
    setStatus(loadNavigationOnly ? `${selection.kind === 'derivatives' ? selection.navigationFile.name : name} · walkable surfaces only` : name + ' loaded');
    await rebuildNavigation(false);
    scheduleAnimate();
  } catch (error) {
    if (pendingNavigationRoot) {
      pendingNavigationRoot.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
    }
    console.error(error);
    ifcSemantics = null;
    updateIfcSummary();
    setStatus(error instanceof Error ? error.message : 'Import failed', 'error');
  }
}

async function loadZooWalkwaysPreview() {
  try {
    const response = await fetch('/generated/models/zoo/walkways.glb');
    if (!response.ok) {
      throw new Error('Generated zoo walkway model is unavailable.');
    }

    const file = new File(
      [await response.blob()],
      'walkways.glb',
      { type: 'model/gltf-binary' },
    );
    await importFiles([file]);

    if (!navigation || statusEl.textContent?.includes('failed')) return;
    const root = viewer.modelRoot;
    if (!root) throw new Error('Walkway model did not load.');

    // Pick two real NavMesh points from the imported walkway triangles. These are
    // temporary preview endpoints, not source-model exit locations.
    root.updateMatrixWorld(true);
    const pointByCell = new Map<string, THREE.Vector3>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const position = object.geometry.getAttribute('position');
      if (!position) return;
      const index = object.geometry.getIndex();
      const triangleCount = Math.floor((index?.count ?? position.count) / 3);
      const sampleCount = Math.min(4, triangleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const triangle = Math.floor(((sample + 0.5) * triangleCount) / sampleCount);
        const vertex = (corner: number) => {
          const offset = triangle * 3 + corner;
          const vertexIndex = index ? index.getX(offset) : offset;
          return new THREE.Vector3()
            .fromBufferAttribute(position, vertexIndex)
            .applyMatrix4(object.matrixWorld);
        };
        const center = vertex(0).add(vertex(1)).add(vertex(2)).multiplyScalar(1 / 3);
        const snapped = navigation!.query.findClosestPoint(center);
        if (!snapped.success) continue;
        const point = new THREE.Vector3(
          snapped.point.x,
          snapped.point.y,
          snapped.point.z,
        );
        const key = Math.round(point.x / 8) + ':' + Math.round(point.z / 8);
        if (!pointByCell.has(key)) pointByCell.set(key, point);
      }
    });

    const candidates = [...pointByCell.values()];
    if (candidates.length < 2) {
      throw new Error('Could not find two walkable points for a sample route.');
    }
    const selected: THREE.Vector3[] = [candidates[0]];
    const remaining = new Set(candidates.slice(1));
    while (selected.length < 48 && remaining.size) {
      let farthest: THREE.Vector3 | null = null;
      let farthestDistance = -1;
      for (const candidate of remaining) {
        const nearestDistance = Math.min(
          ...selected.map((point) => Math.hypot(candidate.x - point.x, candidate.z - point.z)),
        );
        if (nearestDistance > farthestDistance) {
          farthest = candidate;
          farthestDistance = nearestDistance;
        }
      }
      if (!farthest) break;
      selected.push(farthest);
      remaining.delete(farthest);
    }

    let previewRoute: {
      spawn: THREE.Vector3;
      exit: THREE.Vector3;
      length: number;
      path: THREE.Vector3[];
    } | null = null;
    let routeScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < selected.length; i += 1) {
      for (let j = i + 1; j < selected.length; j += 1) {
        const result = navigation.query.computePath(selected[i], selected[j]);
        if (!result.success || result.path.length < 2) continue;
        const last = result.path[result.path.length - 1];
        if (Math.hypot(
          last.x - selected[j].x,
          last.y - selected[j].y,
          last.z - selected[j].z,
        ) > 2) continue;
        let length = 0;
        for (let point = 1; point < result.path.length; point += 1) {
          const a = result.path[point - 1];
          const b = result.path[point];
          length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        }
        if (length < 15) continue;
        const score = Math.abs(length - 42);
        if (score < routeScore) {
          routeScore = score;
          previewRoute = {
            spawn: selected[i],
            exit: selected[j],
            length,
            path: result.path.map((point) =>
              new THREE.Vector3(point.x, point.y, point.z),
            ),
          };
        }
      }
    }
    if (!previewRoute) {
      throw new Error('No connected walkway route long enough for a sample evacuation was found.');
    }

    element<HTMLInputElement>('modelName').value = 'Zoo walkways only';
    element<HTMLInputElement>('occupants').value = '20';
    element<HTMLInputElement>('occupants').dispatchEvent(new Event('input'));
    profilePreset.value = 'mixed';
    profilePreset.dispatchEvent(new Event('change'));
    element<HTMLInputElement>('preMovement').value = '8';
    element<HTMLInputElement>('preMovement').dispatchEvent(new Event('input'));
    playbackSpeedInput.value = '1';
    playbackSpeedInput.dispatchEvent(new Event('input'));
    showHeatmap.checked = true;
    showAgentLocations.checked = true;
    showNav.checked = false;
    navigation.helper.visible = false;
    spawn = previewRoute.spawn.clone();
    exits = [{
      id: 1,
      name: 'Preview endpoint',
      width: 3,
      position: previewRoute.exit.clone(),
    }];
    const pathLengths = [0];
    for (let i = 1; i < previewRoute.path.length; i += 1) {
      const previous = previewRoute.path[i - 1];
      const current = previewRoute.path[i];
      pathLengths.push(
        pathLengths[i - 1] + previous.distanceTo(current),
      );
    }
    const routeLength = pathLengths[pathLengths.length - 1];
    previewSpawnAreas = Array.from({ length: 5 }, (_, groupIndex) => {
      const targetDistance = routeLength * ((groupIndex + 0.5) / 5);
      let segment = 1;
      while (
        segment < pathLengths.length - 1 &&
        pathLengths[segment] < targetDistance
      ) {
        segment += 1;
      }
      const start = previewRoute!.path[segment - 1];
      const end = previewRoute!.path[segment];
      const segmentLength = pathLengths[segment] - pathLengths[segment - 1];
      const point = start.clone().lerp(
        end,
        segmentLength > 0
          ? (targetDistance - pathLengths[segment - 1]) / segmentLength
          : 0,
      );
      const direction = new THREE.Vector2(end.x - start.x, end.z - start.z)
        .normalize();
      const side = new THREE.Vector2(-direction.y, direction.x);
      const along = direction.clone().multiplyScalar(1.2);
      const across = side.multiplyScalar(0.48);
      const corner = (alongSign: number, acrossSign: number) => ({
        x: point.x + along.x * alongSign + across.x * acrossSign,
        z: point.z + along.y * alongSign + across.y * acrossSign,
      });
      return {
        id: 'preview-group-' + (groupIndex + 1),
        name: 'Walkway visitor group ' + (groupIndex + 1),
        points: [
          corner(-1, -1),
          corner(1, -1),
          corner(1, 1),
          corner(-1, 1),
        ],
        elevation: point.y,
        occupants: 4,
      };
    });
    scenarioSource = 'manual';
    updateScenarioSummary();
    const cameraTarget = previewRoute.spawn.clone();
    const cameraOffset = new THREE.Vector3(0.7, 1, 0.7)
      .normalize()
      .multiplyScalar(36);
    viewer.controls.target.copy(cameraTarget);
    viewer.camera.position.copy(cameraTarget).add(cameraOffset);
    viewer.camera.near = 0.05;
    viewer.camera.far = 2000;
    viewer.camera.updateProjectionMatrix();
    viewer.controls.update();
    previewCameraFollow = true;
    markModelDirty('Zoo walkway preview loaded · unsaved');
    runSimulation();
    if (simulation?.agents.length !== 20) {
      throw new Error('The 20-person sample simulation did not initialize.');
    }
    setStatus(
      'Walkway sample running · 20 mixed visitors in 5 groups · temporary endpoints · ' +
        Math.round(previewRoute.length) + ' m test route',
    );
    scheduleAnimate();
  } catch (error) {
    console.error(error);
    setStatus(
      error instanceof Error ? error.message : 'Zoo walkway preview failed',
      'error',
    );
  }
}

function beginPlacement(mode: 'spawn' | 'exit') {
  if (!navigation || !viewer.modelRoot) {
    setStatus('Build a NavMesh first', 'error');
    return;
  }

  placementMode = mode;
  toast.textContent = mode === 'spawn'
    ? 'Click a walkable surface to set the spawn'
    : 'Click a walkable surface to add an exit';
  toast.classList.remove('hidden');
  viewer.renderer.domElement.style.cursor = 'crosshair';
}

viewer.renderer.domElement.addEventListener('pointerdown', (event) => {
  if (workspaceMode === 'build' && buildEditor.getTool() !== 'none') {
    syncBuildSettings();

    if (buildEditor.getTool() === 'select') {
      const picked = viewer.pickObject(event, buildEditor.root);
      setBuildHint(buildEditor.selectObject(picked));
      updateSelectedBuildElement();
      return;
    }

    if (
      buildEditor.getTool() === 'spawn' &&
      !spawnCreationArmed
    ) {
      const picked = viewer.pickObject(event, buildEditor.root);
      if (picked) {
        setBuildHint(buildEditor.selectObject(picked));
        updateSelectedBuildElement();
      } else {
        setBuildHint(
          'Edit an existing Spawn Area above or click + Add Spawn Area.',
        );
      }
      return;
    }

    const point = viewer.pickHorizontalPlane(
      event,
      buildEditor.getSettings().elevation,
    );

    if (!point) return;

    const activeTool = buildEditor.getTool();
    const result = buildEditor.handlePoint(point);
    setBuildHint(result.message);

    if (result.changed) {
      markModelDirty();
      if (activeTool === 'spawn' || activeTool === 'exit') {
        resetSimulation();
        updateBuildStats();
        setStatus('Build scenario updated');
      } else {
        invalidateNavigation();
      }
    }

    updateBuildStats();
    updateSelectedBuildElement();
    return;
  }

  if (!placementMode || !navigation) return;

  const hit = viewer.pickModel(event);
  if (!hit) return;

  const snapped = navigation.query.findClosestPoint(hit);

  if (!snapped.success) {
    setStatus('No NavMesh near that point', 'error');
    return;
  }

  const position = new THREE.Vector3(
    snapped.point.x,
    snapped.point.y,
    snapped.point.z,
  );

  resetSimulation();

  if (placementMode === 'spawn') {
    spawn = position;
  } else {
    exits.push({
      id: exits.length + 1,
      name: 'Manual Exit ' + (exits.length + 1),
      position,
    });
  }

  placementMode = null;
  toast.classList.add('hidden');
  viewer.renderer.domElement.style.cursor = '';
  markModelDirty('Manual scenario changed · unsaved');
  updateScenarioSummary();
  setStatus('Scenario point updated');
});

function newBlankPlan() {
  clearNavigation();
  clearScenario();
  ifcSemantics = null;
  updateIfcSummary();

  resetBuildEditor();
  const root = new THREE.Group();
  root.name = 'EvacSim blank plan';

  modelScale.value = '1';
  disposeDetachedNavigationRoot();
  viewer.setModel(root, 1);
  updateBuildStats();
  setWorkspaceMode('build');
  setBuildTool('floor');
  viewer.setTopView(Number(element<HTMLInputElement>('buildElevation').value) || 0);
  scenarioSource = 'manual';
  element<HTMLInputElement>('modelName').value = 'Untitled model';
  markModelDirty('New model · unsaved');
  setStatus('Blank plan ready');
}

function resolveBuiltExits() {
  if (!navigation) return [];

  const nextExits: ExitTarget[] = [];

  for (const candidate of buildEditor.getExitCandidates()) {
    const snapped = navigation.query.findClosestPoint(candidate.position);
    if (!snapped.success) continue;

    nextExits.push({
      id: nextExits.length + 1,
      name: candidate.name,
      width: candidate.width,
      position: new THREE.Vector3(
        snapped.point.x,
        snapped.point.y,
        snapped.point.z,
      ),
    });
  }

  return nextExits;
}

function useIfcExitCandidates() {
  if (!navigation || !ifcSemantics) {
    setStatus('Build a NavMesh and import IFC first', 'error');
    return;
  }

  const scale = currentScale();
  const nextExits: ExitTarget[] = [];

  for (const candidate of ifcSemantics.exitCandidates) {
    if (!candidate.position) continue;

    const source = candidate.position.clone().multiplyScalar(scale);
    const snapped = navigation.query.findClosestPoint(source);

    if (!snapped.success) continue;

    nextExits.push({
      id: nextExits.length + 1,
      name: candidate.name,
      width: candidate.width == null ? undefined : candidate.width * scale,
      position: new THREE.Vector3(
        snapped.point.x,
        snapped.point.y,
        snapped.point.z,
      ),
    });
  }

  if (!nextExits.length) {
    setStatus('No IFC exit candidates could be snapped to the NavMesh', 'error');
    return;
  }

  resetSimulation();
  exits = nextExits;
  scenarioSource = 'manual';
  markModelDirty('Manual IFC exits changed · unsaved');
  updateScenarioSummary();
  setStatus('Loaded ' + exits.length + ' IFC exit candidate(s)');
}

function runSimulation() {
  if (!navigation) {
    setStatus('Build a NavMesh first', 'error');
    return;
  }

  const spawnAreas = buildEditor.getSpawnAreas();
  const builtExits = resolveBuiltExits();

  let runtimeSpawn: THREE.Vector3 | null = null;
  let runtimeExits: ExitTarget[] = [];
  let runtimeSpawnAreas = spawnAreas;
  let runtimeOccupants = 0;

  if (scenarioSource === 'built') {
    if (!spawnAreas.length) {
      setStatus('Built scenario needs at least one Spawn Area', 'error');
      return;
    }

    if (!builtExits.length) {
      setStatus('Built scenario needs at least one Build Mode Exit', 'error');
      return;
    }

    runtimeExits = builtExits;
    runtimeOccupants = spawnAreas.reduce(
      (sum, area) => sum + area.occupants,
      0,
    );
  } else {
    if (!spawn) {
      setStatus('Manual quick test needs a manual spawn', 'error');
      return;
    }

    if (!exits.length) {
      setStatus('Manual quick test needs at least one manual exit', 'error');
      return;
    }

    runtimeSpawn = spawn;
    runtimeExits = exits;
    runtimeSpawnAreas = previewSpawnAreas || [];
    runtimeOccupants = runtimeSpawnAreas.length
      ? runtimeSpawnAreas.reduce(
          (sum, area) => sum + Math.max(1, Math.round(area.occupants)),
          0,
        )
      : Number(element<HTMLInputElement>('occupants').value) || 1;
  }

  resetSimulation();
  resultExits = runtimeExits.map((exit) => ({
    ...exit,
    position: exit.position.clone(),
  }));

  try {
    const simulationStartedAt = performance.now();
    simulation = new EvacuationSimulation(
      navigation.navMesh,
      navigation.query,
      runtimeSpawn,
      runtimeExits,
      {
        occupants: runtimeOccupants,
        walkingSpeed: Number(speedInput.value),
        spawnRadius:
          Number(element<HTMLInputElement>('spawnRadius').value) || 3,
        profilePreset: profilePreset.value as ProfilePreset,
        preMovementMax:
          Number(element<HTMLInputElement>('preMovement').value),
        seed: Number(element<HTMLInputElement>('simSeed').value) || 1,
        limitExitFlow:
          element<HTMLInputElement>('limitExitFlow').checked,
        specificFlow:
          Number(element<HTMLInputElement>('specificFlow').value) || 1.316,
        boundaryLayer:
          Number(element<HTMLInputElement>('boundaryLayer').value) || 0,
        defaultExitWidth:
          Number(element<HTMLInputElement>('defaultExitWidth').value) || 1,
        spawnAreas: runtimeSpawnAreas,
      },
    );

    viewer.scene.add(simulation.helper);
    simulation.start();
    if (import.meta.env.DEV) {
      console.info('[simulation] initialized', {
        requestedOccupants: runtimeOccupants,
        createdAgents: simulation.agents.length,
        durationMs: performance.now() - simulationStartedAt,
      });
    }
    setWorkspaceMode('simulate');
    updateSimulationWorkspaceLock();
    element<HTMLButtonElement>('exportBtn').disabled = false;
    setStatus(
      'Simulation running · ' +
        runtimeOccupants +
        ' occupants · ' +
        (scenarioSource === 'built' ? 'Built scenario' : 'Manual quick test'),
      'busy',
    );
  } catch (error) {
    console.error(error);
    setStatus(
      error instanceof Error ? error.message : 'Could not start simulation',
      'error',
    );
  }
}

function updateResults() {
  const snapshot = simulation?.snapshot();

  element('timeMetric').textContent = (snapshot?.time || 0).toFixed(1) + ' s';
  element('evacuatedMetric').textContent = snapshot
    ? snapshot.evacuated + ' / ' + snapshot.total
    : '0 / 0';
  element('remainingMetric').textContent = String(snapshot?.active || 0);
  element('waitingMetric').textContent = String(snapshot?.waiting || 0);
  element('densityMetric').textContent = String(snapshot?.peakDensity || 0) + ' p/m²';
  element('avgMetric').textContent = snapshot?.averageEvacuationTime == null
    ? '—'
    : snapshot.averageEvacuationTime.toFixed(1) + ' s';
  element('p95Metric').textContent = snapshot?.p95EvacuationTime == null
    ? '—'
    : snapshot.p95EvacuationTime.toFixed(1) + ' s';
  element('queueMetric').textContent = String(snapshot?.maxQueue || 0);
  element('queueWaitMetric').textContent = snapshot?.averageQueueWait == null
    ? '—'
    : snapshot.averageQueueWait.toFixed(1) + ' s';

  element<HTMLButtonElement>('saveScenario').disabled =
    !snapshot || snapshot.total === 0 || snapshot.active !== 0;

  const exitResults = element<HTMLDivElement>('exitResults');

  if (!resultExits.length) {
    exitResults.innerHTML = '<div class="empty">Run a scenario to see exit results.</div>';
    return;
  }

  exitResults.innerHTML = resultExits.map((exit) => {
    const count = snapshot?.exitCounts.get(exit.id) || 0;
    const total = snapshot?.total || 0;
    const percent = total ? count / total * 100 : 0;
    const label = escapeHtml(exit.name || 'Exit ' + exit.id);
    const flow = snapshot?.exitFlowMetrics.get(exit.id);
    const configured = flow && Number.isFinite(flow.configuredRate)
      ? flow.configuredRate.toFixed(2) + ' p/s'
      : 'free';
    const measured = flow?.measuredRate == null
      ? '—'
      : flow.measuredRate.toFixed(2) + ' p/s';
    const width = flow?.width ?? exit.width;

    return '<div class="exit-row">' +
      '<div><span>' + label + '</span><b>' + count + '</b></div>' +
      '<small>' +
      'width ' + (width == null ? '—' : width.toFixed(2) + ' m') +
      ' · cap ' + configured +
      ' · measured ' + measured +
      ' · queue ' + (flow?.currentQueue || 0) +
      ' / peak ' + (flow?.peakQueue || 0) +
      '</small>' +
      '<div class="bar"><i style="width:' + percent + '%"></i></div>' +
      '</div>';
  }).join('');
}

function updateHeatmap() {
  if (!simulation) {
    viewer.clearHeatmap();
    viewer.clearAgentLocations();
    return;
  }

  const snapshot = simulation.snapshot();
  viewer.setAgentLocations(
    simulation.agentLocations(),
    showAgentLocations.checked,
  );
  viewer.setHeatmap(snapshot.currentDensity, showHeatmap.checked);
}

function downloadCsv() {
  if (!simulation) return;

  const blob = new Blob([simulation.toCsv()], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'evacsim-results-' +
    new Date().toISOString().replace(/[:.]/g, '-') +
    '.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function saveScenarioResult() {
  if (!simulation) return;

  const snapshot = simulation.snapshot();
  if (snapshot.active !== 0) return;

  const nameInput = element<HTMLInputElement>('scenarioName');
  const name = nameInput.value.trim() || 'Scenario ' + (scenarioStore.list().length + 1);

  scenarioStore.add({
    name,
    occupants: snapshot.total,
    exits: resultExits.length,
    profile: profilePreset.options[profilePreset.selectedIndex]?.text || profilePreset.value,
    evacuationTime: snapshot.time,
    averageEvacuationTime: snapshot.averageEvacuationTime,
    p95EvacuationTime: snapshot.p95EvacuationTime,
    peakDensity: snapshot.peakDensity,
    maxQueue: snapshot.maxQueue,
    averageQueueWait: snapshot.averageQueueWait,
  });

  nameInput.value = 'Scenario ' + (scenarioStore.list().length + 1);
  renderScenarioResults();
  setStatus('Scenario result saved');
}

function renderScenarioResults() {
  const container = element<HTMLDivElement>('scenarioResults');
  const items = scenarioStore.list();

  if (!items.length) {
    container.innerHTML = '<div class="empty">Completed scenarios can be saved here.</div>';
    return;
  }

  container.innerHTML = items.map((item) => {
    const avg = item.averageEvacuationTime == null
      ? '—'
      : item.averageEvacuationTime.toFixed(1) + ' s';
    const p95 = item.p95EvacuationTime == null
      ? '—'
      : item.p95EvacuationTime.toFixed(1) + ' s';
    const queueWait = item.averageQueueWait == null
      ? '—'
      : item.averageQueueWait.toFixed(1) + ' s';

    return '<div class="scenario-item">' +
      '<div class="scenario-head"><span>' + escapeHtml(item.name) + '</span><b>' +
      item.evacuationTime.toFixed(1) + ' s</b></div>' +
      '<div class="scenario-meta">' +
      '<span>Occupants <strong>' + item.occupants + '</strong></span>' +
      '<span>Exits <strong>' + item.exits + '</strong></span>' +
      '<span>Average <strong>' + avg + '</strong></span>' +
      '<span>P95 <strong>' + p95 + '</strong></span>' +
      '<span>Peak density <strong>' + item.peakDensity + '</strong></span>' +
      '<span>Max queue <strong>' + (item.maxQueue ?? 0) + '</strong></span>' +
      '<span>Queue wait <strong>' + queueWait + '</strong></span>' +
      '<span>Profile <strong>' + escapeHtml(item.profile) + '</strong></span>' +
      '</div></div>';
  }).join('');
}

function bindRange(
  inputId: string,
  outputId: string,
  format: (value: number) => string,
) {
  const input = element<HTMLInputElement>(inputId);
  const output = element<HTMLOutputElement>(outputId);

  const update = () => {
    output.value = format(Number(input.value));
  };

  input.addEventListener('input', update);
  update();
}

function updateProfileControls() {
  speedInput.disabled = profilePreset.value !== 'custom';
}

bindRange('occupants', 'occupantsOut', (value) => String(value));
bindRange('speed', 'speedOut', (value) => value.toFixed(2) + ' m/s');
bindRange('preMovement', 'preMovementOut', (value) => value.toFixed(0) + ' s');
bindRange('spawnRadius', 'radiusOut', (value) => value.toFixed(1) + ' m');

for (const id of [
  'occupants',
  'speed',
  'preMovement',
  'spawnRadius',
  'simSeed',
  'limitExitFlow',
  'specificFlow',
  'boundaryLayer',
  'defaultExitWidth',
]) {
  element<HTMLInputElement>(id).addEventListener('change', () => {
    markModelDirty('Simulation settings changed · unsaved');
  });
}

profilePreset.addEventListener('change', () => {
  updateProfileControls();
  markModelDirty('Simulation settings changed · unsaved');
});
updateProfileControls();

element<HTMLInputElement>('scenarioSourceBuilt').addEventListener(
  'change',
  (event) => {
    if ((event.currentTarget as HTMLInputElement).checked) {
      setScenarioSource('built');
    }
  },
);

element<HTMLInputElement>('scenarioSourceManual').addEventListener(
  'change',
  (event) => {
    if ((event.currentTarget as HTMLInputElement).checked) {
      setScenarioSource('manual');
    }
  },
);

element('saveModelBtn').addEventListener('click', saveModelToBrowser);
element('loadSavedModelBtn').addEventListener('click', () => {
  void loadSavedModel();
});
element('downloadModelBtn').addEventListener('click', downloadModel);
element<HTMLInputElement>('modelFileInput').addEventListener(
  'change',
  (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importModelFile(file);
    input.value = '';
  },
);

element<HTMLInputElement>('modelName').addEventListener('input', () => {
  markModelDirty('Model name changed · unsaved');
});

element('modeViewBtn').addEventListener('click', () => setWorkspaceMode('view'));
element('modeBuildBtn').addEventListener('click', () => setWorkspaceMode('build'));
element('modeSimulateBtn').addEventListener('click', () =>
  setWorkspaceMode('simulate'),
);

element('blankPlanBtn').addEventListener('click', newBlankPlan);
element('topViewBtn').addEventListener('click', () => {
  syncBuildSettings();
  viewer.setTopView(buildEditor.getSettings().elevation);
});

element('toolSelect').addEventListener('click', () => setBuildTool('select'));
element('toolFloor').addEventListener('click', () => setBuildTool('floor'));
element('toolSpawn').addEventListener('click', () => setBuildTool('spawn'));
element('toolWall').addEventListener('click', () => setBuildTool('wall'));
element('toolDoor').addEventListener('click', () => setBuildTool('door'));
element('toolExit').addEventListener('click', () => setBuildTool('exit'));
element('toolObstacle').addEventListener('click', () => setBuildTool('obstacle'));
element('toolStair').addEventListener('click', () => setBuildTool('stair'));

element('startNewSpawnAreaBtn').addEventListener('click', () => {
  if (buildEditor.getTool() !== 'spawn') {
    setBuildTool('spawn');
  }

  spawnCreationArmed = true;
  buildEditor.cancelActive();
  syncBuildSettings();
  updateBuildToolSettings('spawn');
  setBuildHint(
    'Click 3+ points for the new Spawn Area, then press Finish polygon.',
  );
});

element('finishFloorBtn').addEventListener('click', () => {
  const activeTool = buildEditor.getTool();
  const result = buildEditor.finishPolygon();
  setBuildHint(result.message);

  if (result.changed) {
    markModelDirty();
    if (activeTool === 'spawn') {
      spawnCreationArmed = false;
      updateBuildToolSettings('spawn');
      scenarioSource = 'built';
      resetSimulation();
      updateBuildStats();
      updateSelectedBuildElement();
      setStatus('Spawn Area added · Built scenario selected');
    } else {
      invalidateNavigation();
    }
  }

  updateBuildStats();
  updateSelectedBuildElement();
});

element('cancelBuildBtn').addEventListener('click', () => {
  buildEditor.cancelActive();

  if (buildEditor.getTool() === 'spawn') {
    spawnCreationArmed = false;
    updateBuildToolSettings('spawn');
    setBuildHint('New Spawn Area drawing cancelled.');
    return;
  }

  setBuildHint('Current drawing points cleared.');
});

element('undoBuildBtn').addEventListener('click', () => {
  const message = buildEditor.undo();
  markModelDirty();
  updateBuildStats();
  updateSelectedBuildElement();
  clearNavigation();
  setBuildHint(message);
});

element('applyMoveBuildBtn').addEventListener('click', () => {
  const dx = Number(element<HTMLInputElement>('moveBuildX').value) || 0;
  const dz = Number(element<HTMLInputElement>('moveBuildZ').value) || 0;
  const dy = Number(element<HTMLInputElement>('moveBuildY').value) || 0;

  const message = buildEditor.moveSelected(dx, dz, dy);
  if (buildEditor.getSelected()) markModelDirty();
  setBuildHint(message);

  if (buildEditor.getSelected()) {
    invalidateNavigation('Selected geometry moved · rebuild NavMesh');
  }

  element<HTMLInputElement>('moveBuildX').value = '0';
  element<HTMLInputElement>('moveBuildZ').value = '0';
  element<HTMLInputElement>('moveBuildY').value = '0';
  updateSelectedBuildElement();
});

element('deleteBuildBtn').addEventListener('click', () => {
  const hadSelection = Boolean(buildEditor.getSelected());
  const message = buildEditor.deleteSelected();
  if (hadSelection) markModelDirty();
  setBuildHint(message);

  if (hadSelection) {
    invalidateNavigation('Selected geometry deleted · rebuild NavMesh');
  }

  updateBuildStats();
  updateSelectedBuildElement();
});

element('clearBuildBtn').addEventListener('click', () => {
  buildEditor.clear();
  markModelDirty();
  invalidateNavigation('Drawn geometry cleared');
  updateSelectedBuildElement();
  setBuildHint('All in-app build geometry was cleared.');
});

for (const id of [
  'buildElevation',
  'buildGrid',
  'wallHeight',
  'wallThickness',
  'doorWidth',
  'doorIsExit',
  'spawnOccupants',
  'buildExitWidth',
  'obstacleHeight',
  'stairRise',
  'stairWidth',
]) {
  element<HTMLInputElement>(id).addEventListener('change', syncBuildSettings);
}

window.addEventListener('keydown', (event) => {
  if (workspaceMode !== 'build') return;

  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }

  if (
    event.key === 'Enter' &&
    (buildEditor.getTool() === 'floor' ||
      (buildEditor.getTool() === 'spawn' && spawnCreationArmed))
  ) {
    event.preventDefault();
    const activeTool = buildEditor.getTool();
    const result = buildEditor.finishPolygon();
    setBuildHint(result.message);

    if (result.changed) {
      markModelDirty();
      if (activeTool === 'spawn') {
        spawnCreationArmed = false;
        updateBuildToolSettings('spawn');
        scenarioSource = 'built';
        resetSimulation();
        setStatus('Spawn Area added · Built scenario selected');
      } else {
        invalidateNavigation();
      }
    }

    updateBuildStats();
    updateSelectedBuildElement();
  }

  if (event.key === 'Escape') {
    buildEditor.cancelActive();

    if (buildEditor.getTool() === 'spawn') {
      spawnCreationArmed = false;
      updateBuildToolSettings('spawn');
      setBuildHint('New Spawn Area drawing cancelled.');
    } else {
      setBuildHint('Current drawing points cleared.');
    }
  }
});

element('demoBtn').addEventListener('click', () => {
  void loadDemo();
});

element('buildNav').addEventListener('click', () => {
  void rebuildNavigation(false);
});

element('applyScale').addEventListener('click', () => {
  if (!viewer.modelRoot) return;
  viewer.applyScale(currentScale());
  importedNavigationRoot?.scale.setScalar(currentScale());
  void rebuildNavigation(false);
});

element('spawnBtn').addEventListener('click', () => beginPlacement('spawn'));
element('exitBtn').addEventListener('click', () => beginPlacement('exit'));
element('useIfcExits').addEventListener('click', useIfcExitCandidates);

element('clearExits').addEventListener('click', () => {
  resetSimulation();
  exits = [];
  markModelDirty('Manual exits cleared · unsaved');
  updateScenarioSummary();
});

element('runBtn').addEventListener('click', runSimulation);

element('pauseBtn').addEventListener('click', () => {
  if (!simulation) return;

  const button = element<HTMLButtonElement>('pauseBtn');

  if (simulation.running) {
    simulation.pause();
    button.textContent = 'Resume';
    setStatus('Simulation paused');
  } else {
    simulation.start();
    button.textContent = 'Pause';
    setStatus('Simulation running', 'busy');
  }
});

element('resetBtn').addEventListener('click', () => {
  resetSimulation();
  setStatus('Simulation reset');
});

element('exportBtn').addEventListener('click', downloadCsv);
element('saveScenario').addEventListener('click', saveScenarioResult);

element('clearScenarios').addEventListener('click', () => {
  scenarioStore.clear();
  renderScenarioResults();
});

showNav.addEventListener('change', () => {
  if (navigation) navigation.helper.visible = showNav.checked;
});

bridgeIfcStairs.addEventListener('change', () => {
  if (viewer.modelRoot) void rebuildNavigation(false);
});

showHeatmap.addEventListener('change', updateHeatmap);
showAgentLocations.addEventListener('change', updateHeatmap);

playbackSpeedInput.addEventListener('input', () => {
  element<HTMLOutputElement>('playbackSpeedOut').textContent =
    Number(playbackSpeedInput.value).toFixed(2).replace(/0$/, '') + '×';
});

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  if (files.length) void importFiles(files);
  fileInput.value = '';
});

for (const name of ['dragenter', 'dragover']) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}

for (const name of ['dragleave', 'drop']) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
}

dropzone.addEventListener('drop', (event) => {
  const files = Array.from((event as DragEvent).dataTransfer?.files || []);
  if (files.length) void importFiles(files);
});

window.addEventListener('beforeunload', (event) => {
  if (!modelDirty) return;
  event.preventDefault();
});

const clock = new THREE.Clock();
let perfSampleStartedAt = performance.now();
let perfSampleFrameCount = 0;
let animationFrameId: number | null = null;
let lastSimulationRunning = false;

function scheduleAnimate() {
  if (animationFrameId !== null) return;
  animationFrameId = requestAnimationFrame(animate);
}

function animate(now: number) {
  animationFrameId = null;
  simulation?.update(
    clock.getDelta(),
    viewer.camera.position,
    Number(playbackSpeedInput.value),
  );

  if (previewCameraFollow && simulation?.running && now - lastPreviewCameraFollow > 250) {
    const locations = simulation.agentLocations();
    if (locations.length) {
      const center = locations.reduce(
        (sum, location) => sum.add(new THREE.Vector3(
          location.position.x,
          location.position.y,
          location.position.z,
        )),
        new THREE.Vector3(),
      ).multiplyScalar(1 / locations.length);
      const delta = center.sub(viewer.controls.target).multiplyScalar(0.35);
      viewer.controls.target.add(delta);
      viewer.camera.position.add(delta);
      viewer.controls.update();
    }
    lastPreviewCameraFollow = now;
  }

  if (import.meta.env.DEV) {
    perfSampleFrameCount += 1;
    if (now - perfSampleStartedAt >= 5000) {
      console.info('[runtime] performance sample', {
        fps: Math.round(perfSampleFrameCount * 1000 / (now - perfSampleStartedAt)),
        activeAgents: simulation?.snapshot().active ?? 0,
        totalAgents: simulation?.agents.length ?? 0,
      });
      perfSampleStartedAt = now;
      perfSampleFrameCount = 0;
    }
  }

  const simulationRunning = Boolean(simulation?.running);
  const simulationStateChanged = simulationRunning !== lastSimulationRunning;
  if (simulationStateChanged || (simulationRunning && now - lastUiUpdate > 250)) {
    updateResults();
    updateHeatmap();

    if (simulation && !simulationRunning && simulation.snapshot().active === 0) {
      setStatus('Evacuation complete');
    }
    lastSimulationRunning = simulationRunning;
    lastUiUpdate = now;
  }

  const cameraMoving = viewer.render();
  if (simulation?.running || cameraMoving) {
    scheduleAnimate();
  } else {
    clock.getDelta();
  }
}

viewer.controls.addEventListener('start', () => {
  previewCameraFollow = false;
  scheduleAnimate();
});
for (const eventName of ['click', 'change', 'input', 'keydown', 'drop']) {
  document.addEventListener(eventName, scheduleAnimate);
}
window.addEventListener('resize', scheduleAnimate);

syncBuildSettings();
refreshSavedModelButton();
updateBuildStats();
updateSelectedBuildElement();
updateBuildToolSettings(buildEditor.getTool());
setWorkspaceMode('simulate');
updateSimulationWorkspaceLock();
updateIfcSummary();
renderScenarioResults();
setModelSaveStatus('Unsaved changes', 'unsaved');
scheduleAnimate();
if (new URLSearchParams(window.location.search).get('preview') === 'zoo-walkways') {
  void loadZooWalkwaysPreview();
} else {
  void loadDemo();
}

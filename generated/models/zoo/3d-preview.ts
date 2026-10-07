import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Crowd } from 'recast-navigation';
import { HumanCrowdHelper } from '../../../src/avatars/human-crowd';

type AgentPosition = [number, number, number, number] | null;
type Frame = { t: number; evacuated: number; agents: AgentPosition[] };
type PlaybackData = {
  simulation: { agents: number; durationSeconds: number; zoneCount: number };
  zones: Array<{ spawn: { x: number; y: number; z: number }; exits: Array<{ x: number; y: number; z: number }> }>;
  frames: Frame[];
};
type RenderAgent = {
  agentIndex: number;
  radius: number;
  height: number;
  current: THREE.Vector3;
  speed: THREE.Vector3;
  position: () => THREE.Vector3;
  velocity: () => THREE.Vector3;
};

const root = document.querySelector<HTMLElement>('#scene')!;
const status = document.querySelector<HTMLElement>('#status')!;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingLabel = document.querySelector<HTMLElement>('#loading-label')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const scrubber = document.querySelector<HTMLInputElement>('#scrubber')!;
const playButton = document.querySelector<HTMLButtonElement>('#play')!;
const timeLabel = document.querySelector<HTMLElement>('#time')!;
const evacuatedLabel = document.querySelector<HTMLElement>('#evacuated')!;
const data = await fetch('/generated/models/zoo/animation-data.json').then((response) => {
  if (!response.ok) throw new Error(`Could not load simulation data (${response.status}).`);
  return response.json() as Promise<PlaybackData>;
});
document.querySelector('#zone-count')!.textContent = `${data.simulation.zoneCount} areas`;
document.querySelector('#people-count')!.textContent = `${data.simulation.agents} people`;
document.querySelector('#duration')!.textContent = `${data.simulation.durationSeconds.toFixed(1)} s`;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9eef2);
scene.add(new THREE.HemisphereLight(0xffffff, 0x607060, 2.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.3);
sun.position.set(500, 900, 280);
scene.add(sun);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
root.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 15000;
controls.maxPolarAngle = Math.PI * 0.495;

const people: RenderAgent[] = Array.from({ length: data.simulation.agents }, (_, agentIndex) => {
  const current = new THREE.Vector3();
  const speed = new THREE.Vector3();
  return {
    agentIndex,
    radius: 0.24,
    height: 1.7,
    current,
    speed,
    position: () => current,
    velocity: () => speed,
  };
});
let liveAgents: RenderAgent[] = [];
const crowd = { getAgents: () => liveAgents } as unknown as Crowd;
const avatar = new HumanCrowdHelper(crowd, {
  capacity: data.simulation.agents,
  lod: { detailDistance: 360, mediumDistance: 900, maxDetailed: 72 },
});
scene.add(avatar);

const floorMarkers = new THREE.Group();
const markerGeometry = new THREE.CylinderGeometry(0.8, 0.8, 0.08, 20);
const markerMaterials = [0x3284e6, 0x24a56a].map((color) => new THREE.MeshStandardMaterial({
  color,
  roughness: 0.55,
  emissive: color,
  emissiveIntensity: 0.12,
}));
for (const zone of data.zones) {
  [zone.spawn, ...zone.exits].forEach((point, index) => {
    const marker = new THREE.Mesh(markerGeometry, markerMaterials[index ? 1 : 0]);
    marker.position.set(point.x, point.y + 0.06, point.z);
    floorMarkers.add(marker);
  });
}
scene.add(floorMarkers);

let navRoot: THREE.Group | null = null;
let visualRoot: THREE.Group | null = null;
let framePosition = 0;
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let playbackStartedAt = 0;
const playbackMs = Math.max(45000, data.simulation.durationSeconds * 1500);
scrubber.max = String(data.frames.length - 1);
document.querySelector('#count')!.textContent = `${data.simulation.zoneCount} generated test zones · exit locations are test points on connected walkable areas`;

let renderFrameId: number | null = null;
let lastRenderAt = 0;
let lastPeopleUpdateAt = 0;
const renderIntervalMs = 1000 / 45;
const peopleUpdateIntervalMs = 1000 / 30;

function scheduleRender() {
  if (renderFrameId !== null) return;
  renderFrameId = requestAnimationFrame(animate);
}

function fit(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 3);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(radius * 1.28, radius * 0.92, radius * 1.25));
  camera.near = Math.max(0.05, radius / 1000);
  camera.far = Math.max(1000, radius * 18);
  camera.updateProjectionMatrix();
  controls.maxDistance = radius * 12;
  controls.update();
  scheduleRender();
}

function updatePeople(positionInFrames: number) {
  framePosition = Math.max(0, Math.min(data.frames.length - 1, positionInFrames));
  const lowerIndex = Math.floor(framePosition);
  const upperIndex = Math.min(data.frames.length - 1, lowerIndex + 1);
  const blend = framePosition - lowerIndex;
  const first = data.frames[lowerIndex];
  const second = data.frames[upperIndex];
  const dt = Math.max(1e-3, second.t - first.t);
  liveAgents = [];

  for (let agentIndex = 0; agentIndex < people.length; agentIndex += 1) {
    const before = first.agents[agentIndex];
    const after = second.agents[agentIndex];
    if (!before && !after) continue;
    const position = people[agentIndex];
    const a = before || after!;
    const b = after || before!;
    position.current.set(
      before && after ? a[0] + (b[0] - a[0]) * blend : a[0],
      before && after ? a[1] + (b[1] - a[1]) * blend : a[1],
      before && after ? a[2] + (b[2] - a[2]) * blend : a[2],
    );
    position.speed.set(
      before && after ? (b[0] - a[0]) / dt : 0,
      before && after ? (b[1] - a[1]) / dt : 0,
      before && after ? (b[2] - a[2]) / dt : 0,
    );
    liveAgents.push(position);
  }

  const time = first.t + (second.t - first.t) * blend;
  const evacuated = blend < 0.5 ? first.evacuated : second.evacuated;
  timeLabel.textContent = `${time.toFixed(1)} s`;
  evacuatedLabel.textContent = `${evacuated} / ${data.simulation.agents} evacuated`;
  scrubber.value = String(Math.round(framePosition));
  avatar.update(time, camera.position);
}

function focusWalkers() {
  if (!liveAgents.length) return;
  // Whole-site agents are spread across the map. Focus on the densest local
  // group so 3D bodies remain visible at a useful scale.
  let anchor = liveAgents[0];
  let bestNeighbors = -1;
  for (const candidate of liveAgents) {
    let neighbors = 0;
    for (const other of liveAgents) {
      if (candidate.current.distanceToSquared(other.current) <= 60 * 60) neighbors += 1;
    }
    if (neighbors > bestNeighbors) {
      anchor = candidate;
      bestNeighbors = neighbors;
    }
  }
  const cluster = liveAgents.filter((agent) => agent.current.distanceToSquared(anchor.current) <= 70 * 70);
  const target = cluster.reduce((sum, agent) => sum.add(agent.current), new THREE.Vector3()).multiplyScalar(1 / cluster.length);
  controls.target.copy(target);
  camera.position.copy(target).add(new THREE.Vector3(40, 34, 44));
  camera.near = 0.05;
  camera.far = 2000;
  camera.updateProjectionMatrix();
  controls.update();
  scheduleRender();
}

function onResize() {
  const bounds = root.getBoundingClientRect();
  renderer.setSize(bounds.width, bounds.height, false);
  camera.aspect = bounds.width / Math.max(1, bounds.height);
  camera.updateProjectionMatrix();
  scheduleRender();
}
new ResizeObserver(onResize).observe(root);
onResize();

async function loadNavigation() {
  loadingLabel.textContent = 'Loading 3D walkable geometry…';
  const gltf = await new GLTFLoader().loadAsync('/generated/models/zoo/nav.glb', (event) => {
    if (event.total) progress.value = event.loaded / event.total * 100;
  });
  navRoot = gltf.scene;
  navRoot.name = '3D navigation surfaces';
  navRoot.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = false;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.side = THREE.DoubleSide;
      if (material instanceof THREE.MeshStandardMaterial) {
        material.color.set(0x82958b);
        material.roughness = 0.95;
      }
    }
  });
  scene.add(navRoot);
  fit(navRoot);
  updatePeople(0);
  focusWalkers();
  loading.hidden = true;
  status.textContent = '3D walkable geometry loaded · drag to orbit';
  scheduleRender();
}

async function loadFullVisualModel() {
  const button = document.querySelector<HTMLButtonElement>('#load-full')!;
  if (visualRoot) {
    visualRoot.visible = !visualRoot.visible;
    if (navRoot) navRoot.visible = !visualRoot.visible;
    button.querySelector('span')!.textContent = visualRoot.visible ? 'Hide detail' : 'Show detail';
    fit(visualRoot.visible ? visualRoot : navRoot!);
    return;
  }

  if (!window.confirm('The detailed model is 835 MB with about 53.8 million triangles. Loading it can use several GB of memory and make the browser slow. Load it anyway?')) return;

  button.disabled = true;
  progress.value = 0;
  loading.hidden = false;
  loadingLabel.textContent = 'Loading full zoo model (835 MB)…';
  status.textContent = 'Loading full-resolution model…';
  try {
    const gltf = await new GLTFLoader().loadAsync('/generated/models/zoo/visual.glb', (event) => {
      if (event.total) {
        progress.value = event.loaded / event.total * 100;
        loadingLabel.textContent = `Loading full zoo model · ${Math.round(progress.value)}%`;
      } else {
        loadingLabel.textContent = `Loading full zoo model · ${(event.loaded / 1e6).toFixed(0)} MB`;
      }
    });
    visualRoot = gltf.scene;
    visualRoot.name = 'Full zoo visual model';
    visualRoot.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    scene.add(visualRoot);
    if (navRoot) navRoot.visible = false;
    floorMarkers.visible = true;
    fit(visualRoot);
    button.querySelector('span')!.textContent = 'Hide detail';
    status.textContent = 'Full zoo model loaded · drag to orbit';
    scheduleRender();
  } catch (error) {
    console.error(error);
    status.textContent = error instanceof Error ? error.message : 'Could not load full zoo model.';
    button.disabled = false;
  } finally {
    loading.hidden = true;
    button.disabled = false;
  }
}

document.querySelector('#fit')!.addEventListener('click', () => fit(visualRoot?.visible ? visualRoot : navRoot!));
document.querySelector('#focus')!.addEventListener('click', () => {
  focusWalkers();
});
document.querySelector('#load-full')!.addEventListener('click', () => void loadFullVisualModel());
function updatePlayButton() {
  const label = playing ? 'Pause simulation' : framePosition >= data.frames.length - 1 ? 'Replay simulation' : 'Play simulation';
  playButton.setAttribute('aria-label', label);
  playButton.title = label;
  playButton.innerHTML = playing
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zm5 0h3v10H9z"/></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.7v10.6L13 8z"/></svg>';
}
updatePlayButton();
playButton.addEventListener('click', () => {
  if (!playing && framePosition >= data.frames.length - 1) updatePeople(0);
  playing = !playing;
  playbackStartedAt = playing
    ? performance.now() - (framePosition / Math.max(1, data.frames.length - 1)) * playbackMs
    : 0;
  lastPeopleUpdateAt = 0;
  updatePlayButton();
  if (playing) scheduleRender();
});
scrubber.addEventListener('input', () => {
  playing = false;
  playbackStartedAt = 0;
  updatePeople(Number(scrubber.value));
  updatePlayButton();
  scheduleRender();
});

function animate(now: number) {
  renderFrameId = null;
  if (playing && now - lastPeopleUpdateAt >= peopleUpdateIntervalMs) {
    if (!playbackStartedAt) playbackStartedAt = now;
    const progressRatio = Math.min(1, (now - playbackStartedAt) / playbackMs);
    updatePeople(progressRatio * (data.frames.length - 1));
    lastPeopleUpdateAt = now;
    if (progressRatio >= 1) {
      playing = false;
      playbackStartedAt = 0;
      updatePlayButton();
    }
  }
  const cameraMoving = controls.update();
  if (now - lastRenderAt >= renderIntervalMs) {
    renderer.render(scene, camera);
    lastRenderAt = now;
  }
  if (playing || cameraMoving) scheduleRender();
}

controls.addEventListener('start', scheduleRender);
await loadNavigation();
scheduleRender();

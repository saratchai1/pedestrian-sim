import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AgentLocation } from './simulation';

export class EvacViewer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
  readonly renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
  });
  readonly controls: OrbitControls;
  readonly modelStage = new THREE.Group();
  readonly overlayStage = new THREE.Group();
  readonly heatmapStage = new THREE.Group();
  modelRoot: THREE.Group | null = null;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private lastRenderAt = 0;
  private heatmap: THREE.InstancedMesh | null = null;
  private heatmapCapacity = 0;
  private readonly heatmapTransform = new THREE.Object3D();
  private readonly heatmapColor = new THREE.Color();
  private agentMarkers: THREE.InstancedMesh | null = null;
  private agentMarkerCapacity = 0;
  private agentMarkerIds: number[] = [];
  private agentDetails: AgentLocation[] = [];
  private readonly agentTooltip: HTMLDivElement;

  constructor(private container: HTMLElement) {
    this.scene.background = new THREE.Color(0x0a0f19);
    this.scene.fog = new THREE.Fog(0x0a0f19, 45, 110);

    this.camera.position.set(21, 20, 25);
    // Cap the backing buffer on high-DPI screens: large imported sites are
    // fill-rate bound, while 1.5× remains sharp in the normal viewport.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.agentTooltip = document.createElement('div');
    this.agentTooltip.className = 'agent-tooltip hidden';
    container.appendChild(this.agentTooltip);
    this.renderer.domElement.addEventListener('pointermove', (event) => {
      this.updateAgentTooltip(event);
    });
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.agentTooltip.classList.add('hidden');
    });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x111827, 2.2));

    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(18, 28, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(100, 100, 0x263344, 0x17202d);
    grid.position.y = -0.21;
    this.scene.add(grid, this.modelStage, this.overlayStage, this.heatmapStage);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((item) => item.dispose());
    });
  }

  setModel(root: THREE.Group, scale: number) {
    if (this.modelRoot) {
      this.modelStage.remove(this.modelRoot);
      this.disposeObject(this.modelRoot);
    }
    this.modelRoot = root;
    root.scale.setScalar(scale);
    this.modelStage.add(root);
    this.fit(root);
  }

  applyScale(scale: number) {
    if (!this.modelRoot) return;
    this.modelRoot.scale.setScalar(scale);
    this.fit(this.modelRoot);
  }

  fit(object: THREE.Object3D) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 3);
    // The fixed demo fog hides the center of large site models entirely.
    this.scene.fog = radius > 100
      ? null
      : new THREE.Fog(0x0a0f19, 45, 110);
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).add(
      new THREE.Vector3(radius * 1.25, radius, radius * 1.35),
    );
    this.camera.near = Math.max(0.02, radius / 500);
    this.camera.far = Math.max(500, radius * 20);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private updatePointer(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  pickModel(event: PointerEvent) {
    if (!this.modelRoot) return null;
    this.updatePointer(event);
    const hit = this.raycaster
      .intersectObject(this.modelStage, true)
      .find((item) => item.object instanceof THREE.Mesh);
    return hit ? hit.point.clone() : null;
  }

  pickObject(event: PointerEvent, root: THREE.Object3D) {
    this.updatePointer(event);
    const hit = this.raycaster
      .intersectObject(root, true)
      .find(
        (item) =>
          item.object instanceof THREE.Mesh ||
          item.object instanceof THREE.Line,
      );
    return hit?.object || null;
  }

  pickHorizontalPlane(event: PointerEvent, elevation: number) {
    this.updatePointer(event);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation);
    const target = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(plane, target);
    return hit ? target.clone() : null;
  }

  setBuildInteraction(active: boolean) {
    this.controls.enableRotate = !active;
  }

  setTopView(elevation = 0) {
    const target = this.controls.target.clone();
    target.y = elevation;
    this.controls.target.copy(target);

    const distance = Math.max(
      12,
      this.camera.position.distanceTo(this.controls.target),
    );

    this.camera.position.set(
      target.x + 0.01,
      target.y + distance,
      target.z + 0.01,
    );
    this.camera.lookAt(target);
    this.controls.update();
  }

  setMarkers(spawn: THREE.Vector3 | null, exits: Array<{ position: THREE.Vector3 }>) {
    this.clearGroup(this.overlayStage);
    if (spawn) this.addMarker(spawn, 0x60a5fa, 1.3);
    exits.forEach((exit) => this.addMarker(exit.position, 0x22c55e, 1.7));
  }

  private addMarker(position: THREE.Vector3, color: number, height: number) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.38, 0.52, 32),
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;

    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, height, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    beacon.position.y = height / 2;
    group.add(ring, beacon);
    group.position.copy(position);
    this.overlayStage.add(group);
  }

  setHeatmap(density: Map<string, number>, visible: boolean) {
    if (!visible || !density.size) {
      this.clearHeatmap();
      return;
    }

    if (!this.heatmap || density.size > this.heatmapCapacity) {
      this.clearHeatmap();
      this.heatmapCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(density.size)));
      const geometry = new THREE.PlaneGeometry(0.96, 0.96);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.52,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.heatmap = new THREE.InstancedMesh(geometry, material, this.heatmapCapacity);
      this.heatmap.name = 'Instanced density heatmap';
      this.heatmap.count = 0;
      this.heatmap.frustumCulled = false;
      this.heatmap.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.heatmapStage.add(this.heatmap);
    }

    const heatmapMaterial = Array.isArray(this.heatmap.material)
      ? this.heatmap.material[0]
      : this.heatmap.material;
    if (heatmapMaterial instanceof THREE.MeshBasicMaterial) {
      // InstancedMesh uses instanceColor directly; vertexColors would require
      // a per-vertex color attribute on the plane and can hide the color ramp.
      heatmapMaterial.vertexColors = false;
      heatmapMaterial.color.set(0xffffff);
    }
    heatmapMaterial.depthTest = false;
    heatmapMaterial.needsUpdate = true;
    this.heatmap.renderOrder = 5;

    let max = 1;
    for (const count of density.values()) max = Math.max(max, count);

    // Older in-memory simulations keyed cells by X/Z only. Infer their floor
    // elevation from the already available occupant positions while they run.
    const floorByCell = new Map<string, number>();
    for (const location of this.agentDetails) {
      const key =
        Math.floor(location.position.x) + ',' + Math.floor(location.position.z);
      if (!floorByCell.has(key)) {
        floorByCell.set(key, Math.round(location.position.y * 2) / 2);
      }
    }

    let slot = 0;
    for (const [key, count] of density) {
      const parts = key.split(',').map(Number);
      const [cellX, cellY, cellZ] = parts.length === 3
        ? parts
        : [parts[0], floorByCell.get(parts[0] + ',' + parts[1]) ?? 0, parts[1]];
      this.heatmapTransform.position.set(cellX + 0.5, cellY + 0.06, cellZ + 0.5);
      this.heatmapTransform.rotation.set(0, 0, 0);
      this.heatmapTransform.scale.set(1, 1, 1);
      this.heatmapTransform.updateMatrix();
      this.heatmap.setMatrixAt(slot, this.heatmapTransform.matrix);
      const ratio = count / max;
      this.heatmapColor.setHSL(0.13 * (1 - ratio), 0.9, 0.5);
      this.heatmap.setColorAt(slot, this.heatmapColor);
      slot += 1;
    }
    this.heatmap.count = slot;
    this.heatmap.instanceMatrix.needsUpdate = true;
    if (this.heatmap.instanceColor) this.heatmap.instanceColor.needsUpdate = true;
  }

  setAgentLocations(locations: AgentLocation[], visible: boolean) {
    if (!visible || !locations.length) {
      this.clearAgentLocations();
      return;
    }

    if (!this.agentMarkers || locations.length > this.agentMarkerCapacity) {
      this.clearAgentLocations();
      this.agentMarkerCapacity = Math.max(
        64,
        2 ** Math.ceil(Math.log2(locations.length)),
      );
      this.agentMarkers = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.14, 8, 6),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 0.95,
        }),
        this.agentMarkerCapacity,
      );
      this.agentMarkers.name = 'Individual occupant locations';
      this.agentMarkers.count = 0;
      this.agentMarkers.frustumCulled = false;
      this.agentMarkers.renderOrder = 10;
      this.agentMarkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.overlayStage.add(this.agentMarkers);
    }

    const colors = {
      waiting: new THREE.Color(0x60a5fa),
      moving: new THREE.Color(0x2dd4bf),
      queued: new THREE.Color(0xf59e0b),
    };
    this.agentMarkerIds = [];
    this.agentDetails = locations;
    locations.forEach((location, index) => {
      this.heatmapTransform.position.set(
        location.position.x,
        location.position.y + 1.45,
        location.position.z,
      );
      this.heatmapTransform.rotation.set(0, 0, 0);
      this.heatmapTransform.scale.set(1, 1, 1);
      this.heatmapTransform.updateMatrix();
      this.agentMarkers!.setMatrixAt(index, this.heatmapTransform.matrix);
      this.agentMarkers!.setColorAt(index, colors[location.status]);
      this.agentMarkerIds.push(location.id);
    });
    this.agentMarkers.count = locations.length;
    this.agentMarkers.instanceMatrix.needsUpdate = true;
    if (this.agentMarkers.instanceColor) {
      this.agentMarkers.instanceColor.needsUpdate = true;
    }
  }

  private updateAgentTooltip(event: PointerEvent) {
    if (!this.agentMarkers?.count) {
      this.agentTooltip.classList.add('hidden');
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.agentMarkers, false)[0];
    const location = hit?.instanceId == null
      ? null
      : this.agentDetails[hit.instanceId];

    if (!location) {
      this.agentTooltip.classList.add('hidden');
      return;
    }

    const status = location.status === 'queued'
      ? 'Queued'
      : location.status === 'waiting'
        ? 'Waiting to move'
        : 'Moving';
    this.agentTooltip.textContent =
      'Occupant ' + this.agentMarkerIds[hit.instanceId!] +
      ' · ' + status + ' · ' + location.profile +
      ' · X ' + location.position.x.toFixed(1) + ' m' +
      ' · Y ' + location.position.y.toFixed(1) + ' m' +
      ' · Z ' + location.position.z.toFixed(1) + ' m';
    this.agentTooltip.style.left = Math.min(
      event.clientX - rect.left + 12,
      Math.max(8, rect.width - 260),
    ) + 'px';
    this.agentTooltip.style.top = Math.max(8, event.clientY - rect.top - 34) + 'px';
    this.agentTooltip.classList.remove('hidden');
  }

  clearAgentLocations() {
    if (this.agentMarkers) {
      this.overlayStage.remove(this.agentMarkers);
      this.disposeObject(this.agentMarkers);
      this.agentMarkers = null;
      this.agentMarkerCapacity = 0;
    }
    this.agentMarkerIds = [];
    this.agentDetails = [];
    this.agentTooltip.classList.add('hidden');
  }

  clearHeatmap() {
    if (this.heatmap) {
      this.heatmapStage.remove(this.heatmap);
      this.disposeObject(this.heatmap);
      this.heatmap = null;
      this.heatmapCapacity = 0;
    }
  }

  private clearGroup(group: THREE.Group) {
    const children = [...group.children];
    children.forEach((child) => {
      group.remove(child);
      this.disposeObject(child);
    });
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / Math.max(rect.height, 1);
    this.camera.updateProjectionMatrix();
  }

  render() {
    const cameraMoving = this.controls.update();
    const now = performance.now();
    if (now - this.lastRenderAt < 1000 / 45) return true;
    this.renderer.render(this.scene, this.camera);
    this.lastRenderAt = now;
    return cameraMoving;
  }
}

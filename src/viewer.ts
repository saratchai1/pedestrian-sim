import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class EvacViewer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
  readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  readonly controls: OrbitControls;
  readonly modelStage = new THREE.Group();
  readonly overlayStage = new THREE.Group();
  readonly heatmapStage = new THREE.Group();
  modelRoot: THREE.Group | null = null;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(private container: HTMLElement) {
    this.scene.background = new THREE.Color(0x0a0f19);
    this.scene.fog = new THREE.Fog(0x0a0f19, 45, 110);

    this.camera.position.set(21, 20, 25);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

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
    this.clearGroup(this.heatmapStage);
    if (!visible || !density.size) return;

    const max = Math.max(...density.values(), 1);

    for (const [key, count] of density) {
      const parts = key.split(',').map(Number);
      const x = parts[0];
      const z = parts[1];
      const ratio = count / max;
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.13 * (1 - ratio), 0.9, 0.5),
        transparent: true,
        opacity: 0.18 + ratio * 0.48,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), material);
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(x + 0.5, 0.06, z + 0.5);
      this.heatmapStage.add(tile);
    }
  }

  clearHeatmap() {
    this.clearGroup(this.heatmapStage);
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

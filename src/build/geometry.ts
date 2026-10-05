import * as THREE from 'three';

export type PlanPoint = {
  x: number;
  z: number;
};

export type FloorElement = {
  id: string;
  type: 'floor';
  points: PlanPoint[];
  elevation: number;
};

export type SpawnAreaElement = {
  id: string;
  type: 'spawn';
  points: PlanPoint[];
  elevation: number;
  occupants: number;
};

export type WallElement = {
  id: string;
  type: 'wall';
  start: PlanPoint;
  end: PlanPoint;
  elevation: number;
  height: number;
  thickness: number;
};

export type ObstacleElement = {
  id: string;
  type: 'obstacle';
  start: PlanPoint;
  end: PlanPoint;
  elevation: number;
  height: number;
};

export type StairElement = {
  id: string;
  type: 'stair';
  start: PlanPoint;
  end: PlanPoint;
  startElevation: number;
  endElevation: number;
  width: number;
};

export type DoorElement = {
  id: string;
  type: 'door';
  start: PlanPoint;
  end: PlanPoint;
  elevation: number;
  isExit?: boolean;
};

export type ExitElement = {
  id: string;
  type: 'exit';
  position: PlanPoint;
  elevation: number;
  width: number;
};

export type BuildElement =
  | FloorElement
  | SpawnAreaElement
  | WallElement
  | ObstacleElement
  | StairElement
  | DoorElement
  | ExitElement;

export type BuildPlan = {
  version: 1;
  elements: BuildElement[];
};

export function snapValue(value: number, grid: number) {
  const step = Math.max(0.001, Math.abs(grid));
  return Math.round(value / step) * step;
}

export function snapPlanPoint(
  point: { x: number; z: number },
  grid: number,
): PlanPoint {
  return {
    x: snapValue(point.x, grid),
    z: snapValue(point.z, grid),
  };
}

export function polygonArea(points: PlanPoint[]) {
  if (points.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }

  return Math.abs(area) / 2;
}

function polygonLine(
  points: PlanPoint[],
  elevation: number,
  color: number,
) {
  const vertices = points.map(
    (point) => new THREE.Vector3(point.x, elevation, point.z),
  );
  const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
  const material = new THREE.LineBasicMaterial({ color });
  return new THREE.LineLoop(geometry, material);
}

export function createFloorMesh(element: FloorElement) {
  const shape = new THREE.Shape();
  const first = element.points[0];
  shape.moveTo(first.x, first.z);

  for (let i = 1; i < element.points.length; i += 1) {
    shape.lineTo(element.points[i].x, element.points[i].z);
  }

  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color: 0x28445d,
    roughness: 0.86,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = element.elevation;
  mesh.receiveShadow = true;
  mesh.name = 'Build Floor';
  return mesh;
}

export function createSpawnAreaMarker(element: SpawnAreaElement) {
  const group = new THREE.Group();
  group.name = 'Build Spawn Area';

  const outline = polygonLine(
    element.points,
    element.elevation + 0.07,
    0x38bdf8,
  );
  group.add(outline);

  const centroid = element.points
    .reduce<THREE.Vector3>(
      (sum, point) => sum.add(new THREE.Vector3(point.x, 0, point.z)),
      new THREE.Vector3(),
    )
    .multiplyScalar(1 / Math.max(1, element.points.length));

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.34, 24),
    new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.set(
    centroid.x,
    element.elevation + 0.075,
    centroid.z,
  );
  marker.userData.excludeFromNavMesh = true;
  group.add(marker);

  group.userData.excludeFromNavMesh = true;
  return group;
}

export function createWallMesh(element: WallElement) {
  const dx = element.end.x - element.start.x;
  const dz = element.end.z - element.start.z;
  const length = Math.hypot(dx, dz);

  const geometry = new THREE.BoxGeometry(
    Math.max(length, 0.02),
    Math.max(element.height, 0.05),
    Math.max(element.thickness, 0.02),
  );

  const material = new THREE.MeshStandardMaterial({
    color: 0x708198,
    roughness: 0.82,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    (element.start.x + element.end.x) / 2,
    element.elevation + element.height / 2,
    (element.start.z + element.end.z) / 2,
  );
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'Build Wall';
  return mesh;
}

export function createObstacleMesh(element: ObstacleElement) {
  const width = Math.max(Math.abs(element.end.x - element.start.x), 0.05);
  const depth = Math.max(Math.abs(element.end.z - element.start.z), 0.05);

  const geometry = new THREE.BoxGeometry(
    width,
    Math.max(element.height, 0.05),
    depth,
  );

  const material = new THREE.MeshStandardMaterial({
    color: 0x475569,
    roughness: 0.9,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    (element.start.x + element.end.x) / 2,
    element.elevation + element.height / 2,
    (element.start.z + element.end.z) / 2,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'Build Obstacle';
  return mesh;
}

export function createStairMesh(element: StairElement) {
  const start = new THREE.Vector3(
    element.start.x,
    element.startElevation,
    element.start.z,
  );
  const end = new THREE.Vector3(
    element.end.x,
    element.endElevation,
    element.end.z,
  );

  const direction = end.clone().sub(start);
  const length = Math.max(direction.length(), 0.05);

  const geometry = new THREE.BoxGeometry(
    length,
    0.16,
    Math.max(element.width, 0.2),
  );

  const material = new THREE.MeshStandardMaterial({
    color: 0x8b7fd6,
    roughness: 0.78,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    direction.clone().normalize(),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'Build Stair Link';
  return mesh;
}

export function createDoorMarker(element: DoorElement) {
  const points = [
    new THREE.Vector3(element.start.x, element.elevation + 0.06, element.start.z),
    new THREE.Vector3(element.end.x, element.elevation + 0.06, element.end.z),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: element.isExit ? 0xf97316 : 0x22c55e,
  });
  const line = new THREE.Line(geometry, material);
  line.name = 'Build Door Opening';
  return line;
}

export function createExitMarker(element: ExitElement) {
  const group = new THREE.Group();
  group.name = 'Build Exit';

  const segments = 32;
  const radius = 0.42;
  const ringPoints: THREE.Vector3[] = [];

  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    ringPoints.push(
      new THREE.Vector3(
        element.position.x + Math.cos(angle) * radius,
        element.elevation + 0.08,
        element.position.z + Math.sin(angle) * radius,
      ),
    );
  }

  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPoints),
    new THREE.LineBasicMaterial({ color: 0xf97316 }),
  );
  group.add(ring);

  const crossPoints = [
    new THREE.Vector3(
      element.position.x - 0.28,
      element.elevation + 0.085,
      element.position.z,
    ),
    new THREE.Vector3(
      element.position.x + 0.28,
      element.elevation + 0.085,
      element.position.z,
    ),
    new THREE.Vector3(
      element.position.x,
      element.elevation + 0.085,
      element.position.z - 0.28,
    ),
    new THREE.Vector3(
      element.position.x,
      element.elevation + 0.085,
      element.position.z + 0.28,
    ),
  ];

  const cross = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(crossPoints),
    new THREE.LineBasicMaterial({ color: 0xf97316 }),
  );

  group.add(cross);
  group.userData.excludeFromNavMesh = true;
  return group;
}

export function buildObjectForElement(element: BuildElement) {
  let object: THREE.Object3D;

  switch (element.type) {
    case 'floor':
      object = createFloorMesh(element);
      break;
    case 'spawn':
      object = createSpawnAreaMarker(element);
      break;
    case 'wall':
      object = createWallMesh(element);
      break;
    case 'obstacle':
      object = createObstacleMesh(element);
      break;
    case 'stair':
      object = createStairMesh(element);
      break;
    case 'door':
      object = createDoorMarker(element);
      break;
    case 'exit':
      object = createExitMarker(element);
      break;
  }

  object.userData.buildElementId = element.id;
  object.userData.buildElementType = element.type;
  return object;
}

export function isBuildPlan(value: unknown): value is BuildPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<BuildPlan>;
  return plan.version === 1 && Array.isArray(plan.elements);
}

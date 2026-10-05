import * as THREE from 'three';
import { init, NavMeshQuery } from 'recast-navigation';
import { NavMeshHelper, threeToSoloNavMesh } from '@recast-navigation/three';

let initialized = false;

async function ensureRecast() {
  if (initialized) return;
  await init();
  initialized = true;
}

export type NavigationState = {
  navMesh: any;
  query: NavMeshQuery;
  helper: NavMeshHelper;
};

export type NavigationLink = {
  startPosition: { x: number; y: number; z: number };
  endPosition: { x: number; y: number; z: number };
  radius: number;
  bidirectional: boolean;
  area: number;
  flags: number;
  userId?: number;
};

export async function buildNavigation(
  root: THREE.Object3D,
  offMeshConnections: NavigationLink[] = [],
): Promise<NavigationState> {
  await ensureRecast();
  root.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh &&
      object.visible &&
      !object.userData.excludeFromNavMesh &&
      object.geometry &&
      object.geometry.getAttribute('position')
    ) {
      meshes.push(object);
    }
  });

  if (!meshes.length) {
    throw new Error('No triangle meshes were found in this model.');
  }

  const result = threeToSoloNavMesh(meshes, {
    cs: 0.16,
    ch: 0.10,
    walkableSlopeAngle: 45,
    walkableHeight: 2,
    walkableClimb: 0.5,
    walkableRadius: 0.28,
    maxEdgeLen: 12,
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
    offMeshConnections,
  });

  if (!result.success || !result.navMesh) {
    throw new Error('NavMesh generation failed. Check model scale and walkable floor geometry.');
  }

  const query = new NavMeshQuery(result.navMesh);
  const helper = new NavMeshHelper(result.navMesh, {
    navMeshMaterial: new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
  });

  helper.name = 'NavMesh preview';
  helper.position.y += 0.015;
  return { navMesh: result.navMesh, query, helper };
}

export function pathLength(path: Array<{ x: number; y: number; z: number }>) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

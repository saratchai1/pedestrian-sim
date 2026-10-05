import * as THREE from 'three';
import { init, NavMeshQuery } from 'recast-navigation';
import { NavMeshHelper, threeToSoloNavMesh, threeToTiledNavMesh } from '@recast-navigation/three';

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
  metrics: {
    recastInitializationMs: number;
    inputMeshCount: number;
    inputTriangleCount: number;
    inputGeometryBytes: number;
    navMeshTileCount: number;
    navMeshPolygonCount: number;
    navMeshTileDataBytesEstimate: number;
    navMeshGenerator: 'solo' | 'tiled';
    buildTimeMs: number;
  };
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
  root: THREE.Object3D | THREE.Object3D[],
  offMeshConnections: NavigationLink[] = [],
): Promise<NavigationState> {
  const totalStart = performance.now();
  await ensureRecast();
  const recastInitializationMs = performance.now() - totalStart;
  const buildStart = performance.now();
  const roots = Array.isArray(root) ? root : [root];
  roots.forEach((item) => item.updateMatrixWorld(true));

  const meshes: THREE.Mesh[] = [];
  const seen = new Set<THREE.Mesh>();
  roots.forEach((item) => item.traverse((object) => {
    if (
      object instanceof THREE.Mesh &&
      object.visible &&
      !object.userData.excludeFromNavMesh &&
      object.geometry &&
      object.geometry.getAttribute('position') &&
      !seen.has(object)
    ) {
      seen.add(object);
      meshes.push(object);
    }
  }));

  if (!meshes.length) {
    throw new Error('No triangle meshes were found in this model.');
  }

  const seenGeometries = new Set<THREE.BufferGeometry>();
  const seenArrays = new Set<ArrayBufferLike>();
  let inputTriangleCount = 0;
  let inputGeometryBytes = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    inputTriangleCount += Math.floor((index?.count ?? position.count) / 3);
    if (seenGeometries.has(geometry)) continue;
    seenGeometries.add(geometry);
    for (const attribute of Object.values(geometry.attributes)) {
      const attributeArray = 'array' in attribute
        ? attribute.array
        : (attribute as THREE.InterleavedBufferAttribute).data.array;
      const array = attributeArray as unknown as ArrayBufferView;
      if (!seenArrays.has(array.buffer)) {
        seenArrays.add(array.buffer);
        inputGeometryBytes += array.buffer.byteLength;
      }
    }
    const indexArray = index?.array as unknown as ArrayBufferView | undefined;
    if (indexArray && !seenArrays.has(indexArray.buffer)) {
      seenArrays.add(indexArray.buffer);
      inputGeometryBytes += indexArray.buffer.byteLength;
    }
  }

  const navBounds = new THREE.Box3();
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) navBounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  }
  const navSize = navBounds.getSize(new THREE.Vector3());
  const useTiledGenerator = Math.max(navSize.x, navSize.z) > 256 || navSize.x * navSize.z > 10_000;
  const generatorOptions = {
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
  };
  const tileSizeCells = Math.max(1, Math.round(32 / generatorOptions.cs));
  const result = useTiledGenerator
    ? threeToTiledNavMesh(meshes, { ...generatorOptions, tileSize: tileSizeCells })
    : threeToSoloNavMesh(meshes, generatorOptions);

  if (!result.success || !result.navMesh) {
    throw new Error('NavMesh generation failed. Check model scale and walkable floor geometry.');
  }

  let navMeshTileCount = 0;
  let navMeshPolygonCount = 0;
  let navMeshTileDataBytesEstimate = 0;
  for (let i = 0; i < result.navMesh.getMaxTiles(); i += 1) {
    const tile = result.navMesh.getTile(i);
    const header = tile.header();
    if (!header) continue;
    navMeshTileCount += 1;
    navMeshPolygonCount += header.polyCount();
    navMeshTileDataBytesEstimate += tile.dataSize();
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
  return {
    navMesh: result.navMesh,
    query,
    helper,
    metrics: {
      recastInitializationMs,
      inputMeshCount: meshes.length,
      inputTriangleCount,
      inputGeometryBytes,
      navMeshTileCount,
      navMeshPolygonCount,
      navMeshTileDataBytesEstimate,
      navMeshGenerator: useTiledGenerator ? 'tiled' : 'solo',
      buildTimeMs: performance.now() - buildStart,
    },
  };
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

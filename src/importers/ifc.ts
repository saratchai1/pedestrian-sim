import * as THREE from 'three';
import { IfcAPI } from 'web-ifc';

export type IfcSemanticItem = {
  expressID: number;
  type: string;
  name: string;
  longName?: string;
  objectType?: string;
  elevation?: number;
  width?: number;
  position?: THREE.Vector3;
  lowerPoint?: THREE.Vector3;
  upperPoint?: THREE.Vector3;
};

export type IfcSemantics = {
  storeys: IfcSemanticItem[];
  spaces: IfcSemanticItem[];
  doors: IfcSemanticItem[];
  stairs: IfcSemanticItem[];
  exitCandidates: IfcSemanticItem[];
};

export type IfcImportResult = {
  group: THREE.Group;
  semantics: IfcSemantics;
};

function unwrap(value: any): string | number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object' && 'value' in value) return value.value;
  return undefined;
}

function textValue(value: any) {
  const raw = unwrap(value);
  return raw == null ? '' : String(raw);
}

function numberValue(value: any) {
  const raw = unwrap(value);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function isExitLike(item: IfcSemanticItem) {
  const haystack = [
    item.name,
    item.longName || '',
    item.objectType || '',
  ].join(' ').toLowerCase();

  return /\b(exit|egress|emergency|fire\s*exit|escape)\b|ทางออก|หนีไฟ/.test(haystack);
}

function collectCenters(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const boxes = new Map<number, THREE.Box3>();

  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const expressID = Number(object.userData.expressID);
    if (!Number.isFinite(expressID)) return;

    const box = new THREE.Box3().setFromObject(object);
    const aggregate = boxes.get(expressID);

    if (aggregate) aggregate.union(box);
    else boxes.set(expressID, box);
  });

  const centers = new Map<number, THREE.Vector3>();

  for (const [id, box] of boxes) {
    centers.set(id, box.getCenter(new THREE.Vector3()));
  }

  return centers;
}


function estimateStairEndpoints(group: THREE.Group, expressID: number) {
  const samples: THREE.Vector3[] = [];
  group.updateMatrixWorld(true);

  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Number(object.userData.expressID) !== expressID) return;

    const attribute = object.geometry.getAttribute('position');
    if (!attribute) return;

    const stride = Math.max(1, Math.floor(attribute.count / 1500));
    for (let i = 0; i < attribute.count; i += stride) {
      const point = new THREE.Vector3()
        .fromBufferAttribute(attribute, i)
        .applyMatrix4(object.matrixWorld);
      samples.push(point);
    }
  });

  if (samples.length < 2) return null;

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of samples) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const rise = maxY - minY;
  if (!Number.isFinite(rise) || rise < 0.6) return null;

  const band = Math.max(0.18, rise * 0.18);
  const lower = samples.filter((point) => point.y <= minY + band);
  const upper = samples.filter((point) => point.y >= maxY - band);

  if (!lower.length || !upper.length) return null;

  const average = (points: THREE.Vector3[]) => {
    const total = points.reduce(
      (sum, point) => sum.add(point),
      new THREE.Vector3(),
    );
    return total.multiplyScalar(1 / points.length);
  };

  return {
    lowerPoint: average(lower),
    upperPoint: average(upper),
  };
}

function readSemanticItems(
  api: IfcAPI,
  modelID: number,
  typeName: string,
  typeID: number | undefined,
  centers: Map<number, THREE.Vector3>,
) {
  const items: IfcSemanticItem[] = [];
  if (typeID == null) return items;

  const ids = api.GetLineIDsWithType(modelID, typeID, true);

  for (let i = 0; i < ids.size(); i += 1) {
    const expressID = ids.get(i);
    const line = api.GetLine(modelID, expressID, false, false);

    if (!line) continue;

    items.push({
      expressID,
      type: typeName,
      name:
        textValue(line.Name) ||
        textValue(line.LongName) ||
        textValue(line.ObjectType) ||
        typeName + ' #' + expressID,
      longName: textValue(line.LongName) || undefined,
      objectType: textValue(line.ObjectType) || textValue(line.PredefinedType) || undefined,
      elevation: numberValue(line.Elevation),
      width: numberValue(line.OverallWidth),
      position: centers.get(expressID)?.clone(),
    });
  }

  return items;
}

export async function loadIfcFile(file: File): Promise<IfcImportResult> {
  const api = new IfcAPI();
  api.SetWasmPath('/', true);
  await api.Init();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });

  if (modelID < 0) {
    throw new Error('web-ifc could not open this IFC model.');
  }

  const group = new THREE.Group();
  group.name = file.name;

  // IFC geometry is Z-up. Three.js/Recast in this app use Y-up.
  group.rotation.x = -Math.PI / 2;

  const flatMeshes = api.LoadAllGeometry(modelID);

  for (let i = 0; i < flatMeshes.size(); i += 1) {
    const flatMesh = flatMeshes.get(i);

    for (let g = 0; g < flatMesh.geometries.size(); g += 1) {
      const placed = flatMesh.geometries.get(g);
      const source = api.GetGeometry(modelID, placed.geometryExpressID);
      const vertexData = api.GetVertexArray(source.GetVertexData(), source.GetVertexDataSize());
      const indexData = api.GetIndexArray(source.GetIndexData(), source.GetIndexDataSize());

      const vertexCount = vertexData.length / 6;
      const positions = new Float32Array(vertexCount * 3);
      const normals = new Float32Array(vertexCount * 3);

      for (let v = 0, p = 0; v < vertexData.length; v += 6, p += 3) {
        positions[p] = vertexData[v];
        positions[p + 1] = vertexData[v + 1];
        positions[p + 2] = vertexData[v + 2];
        normals[p] = vertexData[v + 3];
        normals[p + 1] = vertexData[v + 4];
        normals[p + 2] = vertexData[v + 5];
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indexData), 1));

      const c = placed.color;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(c.x, c.y, c.z),
        transparent: c.w < 0.999,
        opacity: c.w,
        roughness: 0.82,
        metalness: 0,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.name = 'IFC ' + flatMesh.expressID;
      mesh.userData.expressID = flatMesh.expressID;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(placed.flatTransformation);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      source.delete();
    }

    flatMesh.delete();
  }

  const centers = collectCenters(group);
  const modelTypes = api.GetAllTypesOfModel(modelID);
  const typeMap = new Map(modelTypes.map((item) => [item.typeName.toUpperCase(), item.typeID]));

  const storeys = readSemanticItems(
    api,
    modelID,
    'IfcBuildingStorey',
    typeMap.get('IFCBUILDINGSTOREY'),
    centers,
  );
  const spaces = readSemanticItems(
    api,
    modelID,
    'IfcSpace',
    typeMap.get('IFCSPACE'),
    centers,
  );
  const doors = readSemanticItems(
    api,
    modelID,
    'IfcDoor',
    typeMap.get('IFCDOOR'),
    centers,
  );
  const stairs = readSemanticItems(
    api,
    modelID,
    'IfcStair',
    typeMap.get('IFCSTAIR'),
    centers,
  );

  for (const stair of stairs) {
    const endpoints = estimateStairEndpoints(group, stair.expressID);
    if (endpoints) {
      stair.lowerPoint = endpoints.lowerPoint;
      stair.upperPoint = endpoints.upperPoint;
    }
  }

  const semantics: IfcSemantics = {
    storeys,
    spaces,
    doors,
    stairs,
    exitCandidates: doors.filter((door) => door.position && isExitLike(door)),
  };

  api.CloseModel(modelID);

  return { group, semantics };
}

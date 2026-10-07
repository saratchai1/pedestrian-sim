import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadGlbFile(file: File): Promise<THREE.Group> {
  const data = await file.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data, '');
  const group = gltf.scene || gltf.scenes[0];
  if (!group) throw new Error(`No scene was found in ${file.name}.`);
  group.name = file.name;

  // Shadow rendering adds a second scene pass. Keep it for ordinary models,
  // but avoid turning tens of thousands of imported meshes into shadow casters.
  let meshCount = 0;
  let triangleCount = 0;
  const shadowCandidates: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    meshCount += 1;
    triangleCount += Math.floor(
      (object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3,
    );
    if (meshCount <= 2500) shadowCandidates.push(object);
  });
  const enableImportedShadows = meshCount <= 2500 && triangleCount <= 500_000;
  if (enableImportedShadows) {
    shadowCandidates.forEach((mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  } else {
    console.info(
      `[GLTF] ${file.name}: disabled imported shadows for ${meshCount.toLocaleString()} meshes / ${triangleCount.toLocaleString()} triangles.`,
    );
  }
  return group;
}

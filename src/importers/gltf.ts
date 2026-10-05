import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadGlbFile(file: File): Promise<THREE.Group> {
  const data = await file.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data, '');
  const group = gltf.scene || gltf.scenes[0];
  if (!group) throw new Error(`No scene was found in ${file.name}.`);
  group.name = file.name;
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return group;
}

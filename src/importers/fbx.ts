import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export async function loadFbxFile(file: File): Promise<THREE.Group> {
  const data = await file.arrayBuffer();
  const loader = new FBXLoader();
  const group = loader.parse(data, '');
  group.name = file.name;

  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  return group;
}

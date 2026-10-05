import * as THREE from 'three';

function material(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.84, metalness: 0 });
}

function box(
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  mat: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createDemoBuilding() {
  const root = new THREE.Group();
  root.name = 'Demo office floor';

  const floor = material(0x1d2736);
  const wall = material(0x718096);
  const obstacle = material(0x374151);

  root.add(box('Floor', [24, 0.2, 16], [0, -0.1, 0], floor));

  const h = 3;
  const t = 0.25;

  root.add(box('North wall', [24, h, t], [0, h / 2, -8], wall));
  root.add(box('South wall', [24, h, t], [0, h / 2, 8], wall));
  root.add(box('West wall', [t, h, 16], [-12, h / 2, 0], wall));

  // East facade with two 1.8 m openings.
  root.add(box('East wall center', [t, h, 5.2], [12, h / 2, 0], wall));
  root.add(box('East wall north', [t, h, 3.6], [12, h / 2, -6.2], wall));
  root.add(box('East wall south', [t, h, 3.6], [12, h / 2, 6.2], wall));

  // Partitions create routing choices and bottlenecks.
  root.add(box('Partition A north', [t, h, 5.8], [-2, h / 2, -5.1], wall));
  root.add(box('Partition A south', [t, h, 6.2], [-2, h / 2, 4.9], wall));
  root.add(box('Partition B left', [5, h, t], [2.5, h / 2, 1.8], wall));
  root.add(box('Partition B right', [5, h, t], [9.5, h / 2, 1.8], wall));

  root.add(box('Core 1', [2.2, 2.4, 2.2], [3.2, 1.2, -3.2], obstacle));
  root.add(box('Core 2', [2, 2.4, 2], [7, 1.2, 5], obstacle));
  root.add(box('Desk bank', [3.5, 0.9, 1.8], [-7, 0.45, 4], obstacle));

  return root;
}

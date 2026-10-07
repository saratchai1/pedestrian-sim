import * as THREE from 'three';
import type { Crowd, CrowdAgent } from 'recast-navigation';
import {
  DEFAULT_AVATAR_LOD,
  selectAvatarLods,
  smoothAngle,
  type AvatarLodOptions,
} from './lod';
import { humanWalkPose, type HumanWalkPose } from './pose';

export type HumanCrowdHelperOptions = {
  capacity: number;
  profileByAgentIndex?: Map<number, string>;
  lod?: Partial<AvatarLodOptions>;
};

type Appearance = {
  shirt: THREE.Color;
  pants: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
  shoes: THREE.Color;
  heightScale: number;
  widthScale: number;
};

type DetailPart =
  | 'torso'
  | 'pelvis'
  | 'neck'
  | 'head'
  | 'hair'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftThigh'
  | 'leftCalf'
  | 'rightThigh'
  | 'rightCalf'
  | 'leftShoe'
  | 'rightShoe';

type MidPart =
  | 'torso'
  | 'head'
  | 'leftArm'
  | 'rightArm'
  | 'leftLeg'
  | 'rightLeg';

type FarPart = 'body' | 'lowerBody' | 'head';

const CLOTHING = [
  0x2563eb,
  0x0f766e,
  0x9333ea,
  0xc2410c,
  0x3f6212,
  0xbe123c,
  0x475569,
  0x0369a1,
];

const STAFF_CLOTHING = [0x1d4ed8, 0x0f4c81, 0x1e40af];
const SLOW_CLOTHING = [0x64748b, 0x7c6f64, 0x4b5563, 0x5b6473];
const PANTS = [0x111827, 0x1f2937, 0x334155, 0x292524];
const SKIN = [0xf0c8a0, 0xd8a176, 0xb97850, 0x8a563c, 0x6c402d];
const HAIR = [0x18181b, 0x292524, 0x3f2d20, 0x5c4033, 0x6b4f3f];
const SHOES = [0x111827, 0x27272a, 0x3f3f46, 0x44403c];
const AVATAR_GEOMETRY_HEIGHT_METRES = {
  detail: 1.925, // Hair crown: 1.755 + 0.17 m.
  medium: 1.82, // Head top: 1.66 + 0.16 m.
  far: 1.805, // Head top: 1.66 + 0.145 m.
} as const;
const HUMAN_HEIGHT_VARIATION = { min: 0.95, max: 1.043 } as const;

function hashedNumber(agentIndex: number, salt: number) {
  let value =
    Math.imul(agentIndex + 1, 2654435761) ^
    Math.imul(salt + 17, 1597334677);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

function hashedChoice<T>(items: T[], agentIndex: number, salt: number) {
  return items[
    Math.min(
      items.length - 1,
      Math.floor(hashedNumber(agentIndex, salt) * items.length),
    )
  ];
}

function torsoColor(profile: string, agentIndex: number) {
  const normalized = profile.toLowerCase();

  if (normalized.includes('staff')) {
    return hashedChoice(STAFF_CLOTHING, agentIndex, 1);
  }

  if (normalized.includes('slow') || normalized.includes('cautious')) {
    return hashedChoice(SLOW_CLOTHING, agentIndex, 2);
  }

  return hashedChoice(CLOTHING, agentIndex, 3);
}

function createMaterial() {
  return new THREE.MeshStandardMaterial({
    roughness: 0.72,
    metalness: 0,
  });
}

function unitCylinder(segments = 8) {
  return new THREE.CylinderGeometry(1, 1, 1, segments);
}

export class HumanCrowdHelper extends THREE.Group {
  private readonly detailParts: Record<DetailPart, THREE.InstancedMesh>;
  private readonly midParts: Record<MidPart, THREE.InstancedMesh>;
  private readonly farParts: Record<FarPart, THREE.InstancedMesh>;

  private readonly lastYaw = new Map<number, number>();
  private readonly appearance = new Map<number, Appearance>();

  private readonly root = new THREE.Object3D();
  private readonly local = new THREE.Object3D();
  private readonly resultMatrix = new THREE.Matrix4();

  private readonly lodOptions: AvatarLodOptions;
  private readonly detailCapacity: number;

  constructor(
    private crowd: Crowd,
    private options: HumanCrowdHelperOptions,
  ) {
    super();
    this.name = 'Hybrid LOD human crowd avatars';

    const capacity = Math.max(1, Math.ceil(options.capacity));
    this.lodOptions = {
      ...DEFAULT_AVATAR_LOD,
      ...options.lod,
    };
    this.detailCapacity = Math.max(
      1,
      Math.min(capacity, this.lodOptions.maxDetailed),
    );

    const detail = this.detailCapacity;
    this.detailParts = {
      torso: this.createPart(
        new THREE.CylinderGeometry(0.215, 0.165, 0.54, 10),
        detail,
      ),
      pelvis: this.createPart(
        new THREE.BoxGeometry(0.34, 0.2, 0.23),
        detail,
      ),
      neck: this.createPart(
        new THREE.CylinderGeometry(0.068, 0.075, 0.12, 8),
        detail,
      ),
      head: this.createPart(
        new THREE.SphereGeometry(0.165, 12, 9),
        detail,
      ),
      hair: this.createPart(
        new THREE.SphereGeometry(
          0.17,
          10,
          6,
          0,
          Math.PI * 2,
          0,
          Math.PI * 0.52,
        ),
        detail,
      ),
      leftUpperArm: this.createPart(unitCylinder(), detail),
      leftLowerArm: this.createPart(unitCylinder(), detail),
      rightUpperArm: this.createPart(unitCylinder(), detail),
      rightLowerArm: this.createPart(unitCylinder(), detail),
      leftHand: this.createPart(
        new THREE.SphereGeometry(0.062, 8, 6),
        detail,
      ),
      rightHand: this.createPart(
        new THREE.SphereGeometry(0.062, 8, 6),
        detail,
      ),
      leftThigh: this.createPart(unitCylinder(9), detail),
      leftCalf: this.createPart(unitCylinder(9), detail),
      rightThigh: this.createPart(unitCylinder(9), detail),
      rightCalf: this.createPart(unitCylinder(9), detail),
      leftShoe: this.createPart(
        new THREE.BoxGeometry(1, 1, 1),
        detail,
      ),
      rightShoe: this.createPart(
        new THREE.BoxGeometry(1, 1, 1),
        detail,
      ),
    };

    this.midParts = {
      torso: this.createPart(
        new THREE.CylinderGeometry(0.2, 0.16, 0.62, 8),
        capacity,
      ),
      head: this.createPart(
        new THREE.SphereGeometry(0.16, 9, 7),
        capacity,
      ),
      leftArm: this.createPart(unitCylinder(6), capacity),
      rightArm: this.createPart(unitCylinder(6), capacity),
      leftLeg: this.createPart(unitCylinder(6), capacity),
      rightLeg: this.createPart(unitCylinder(6), capacity),
    };

    this.farParts = {
      body: this.createPart(
        new THREE.CylinderGeometry(0.18, 0.14, 0.68, 6),
        capacity,
        false,
      ),
      lowerBody: this.createPart(
        new THREE.CylinderGeometry(0.135, 0.11, 0.72, 6),
        capacity,
        false,
      ),
      head: this.createPart(
        new THREE.SphereGeometry(0.145, 7, 5),
        capacity,
        false,
      ),
    };

    Object.values(this.detailParts).forEach((part) => this.add(part));
    Object.values(this.midParts).forEach((part) => this.add(part));
    Object.values(this.farParts).forEach((part) => this.add(part));

    this.update(0);
  }

  private createPart(
    geometry: THREE.BufferGeometry,
    capacity: number,
    shadows = true,
  ) {
    const mesh = new THREE.InstancedMesh(
      geometry,
      createMaterial(),
      capacity,
    );

    mesh.count = 0;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  private appearanceFor(agentIndex: number, profile: string) {
    const cached = this.appearance.get(agentIndex);
    if (cached) return cached;

    const result: Appearance = {
      shirt: new THREE.Color(torsoColor(profile, agentIndex)),
      pants: new THREE.Color(hashedChoice(PANTS, agentIndex, 4)),
      skin: new THREE.Color(hashedChoice(SKIN, agentIndex, 5)),
      hair: new THREE.Color(hashedChoice(HAIR, agentIndex, 6)),
      shoes: new THREE.Color(hashedChoice(SHOES, agentIndex, 7)),
      heightScale:
        HUMAN_HEIGHT_VARIATION.min +
        hashedNumber(agentIndex, 8) *
          (HUMAN_HEIGHT_VARIATION.max - HUMAN_HEIGHT_VARIATION.min),
      widthScale: 0.92 + hashedNumber(agentIndex, 9) * 0.16,
    };

    this.appearance.set(agentIndex, result);
    return result;
  }

  private setPart(
    mesh: THREE.InstancedMesh,
    slot: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1,
  ) {
    this.local.position.set(x, y, z);
    this.local.rotation.set(rx, ry, rz);
    this.local.scale.set(sx, sy, sz);
    this.local.updateMatrix();

    this.resultMatrix.multiplyMatrices(this.root.matrix, this.local.matrix);
    mesh.setMatrixAt(slot, this.resultMatrix);
  }

  private setVerticalSegment(
    mesh: THREE.InstancedMesh,
    slot: number,
    startX: number,
    startY: number,
    startZ: number,
    length: number,
    angle: number,
    radius: number,
  ) {
    const half = length * 0.5;
    const centerY = startY - Math.cos(angle) * half;
    const centerZ = startZ - Math.sin(angle) * half;

    this.setPart(
      mesh,
      slot,
      startX,
      centerY,
      centerZ,
      angle,
      0,
      0,
      radius,
      length,
      radius,
    );

    return {
      x: startX,
      y: startY - Math.cos(angle) * length,
      z: startZ - Math.sin(angle) * length,
    };
  }

  private setRoot(
    agent: CrowdAgent,
    pose: HumanWalkPose,
    yaw: number,
    x: number,
    y: number,
    z: number,
    appearance: Appearance,
    geometryHeight: number = AVATAR_GEOMETRY_HEIGHT_METRES.detail,
  ) {
    // Normalize each LOD's measured crown height to the CrowdAgent's metres.
    const heightScale =
      Math.max(0.84, Math.min(1.16, agent.height / geometryHeight)) *
      appearance.heightScale;
    const widthScale =
      Math.max(0.84, Math.min(1.18, agent.radius / 0.24)) *
      appearance.widthScale;

    this.root.position.set(x, y + pose.bob, z);
    this.root.rotation.set(pose.lean, yaw, pose.sway);
    this.root.scale.set(widthScale, heightScale, widthScale);
    this.root.updateMatrix();
  }

  private setColor(
    mesh: THREE.InstancedMesh,
    slot: number,
    color: THREE.Color,
  ) {
    mesh.setColorAt(slot, color);
  }

  private updateDetailedAgent(
    agent: CrowdAgent,
    slot: number,
    pose: HumanWalkPose,
    yaw: number,
    x: number,
    y: number,
    z: number,
    appearance: Appearance,
  ) {
    this.setRoot(agent, pose, yaw, x, y, z, appearance);

    this.setPart(
      this.detailParts.torso,
      slot,
      0,
      1.22,
      0,
      0,
      0,
      0,
      1,
      1 + pose.breath,
      1,
    );
    this.setPart(this.detailParts.pelvis, slot, 0, 0.9, 0);
    this.setPart(this.detailParts.neck, slot, 0, 1.54, 0);
    this.setPart(this.detailParts.head, slot, 0, 1.7, 0);
    this.setPart(this.detailParts.hair, slot, 0, 1.755, 0);

    const leftArmAngle = pose.armSwing;
    const rightArmAngle = -pose.armSwing;
    const upperArmLength = 0.29;
    const lowerArmLength = 0.265;

    const leftElbow = this.setVerticalSegment(
      this.detailParts.leftUpperArm,
      slot,
      -0.255,
      1.43,
      0,
      upperArmLength,
      leftArmAngle,
      0.052,
    );
    const leftHand = this.setVerticalSegment(
      this.detailParts.leftLowerArm,
      slot,
      leftElbow.x,
      leftElbow.y,
      leftElbow.z,
      lowerArmLength,
      leftArmAngle + pose.leftElbowBend,
      0.045,
    );

    const rightElbow = this.setVerticalSegment(
      this.detailParts.rightUpperArm,
      slot,
      0.255,
      1.43,
      0,
      upperArmLength,
      rightArmAngle,
      0.052,
    );
    const rightHand = this.setVerticalSegment(
      this.detailParts.rightLowerArm,
      slot,
      rightElbow.x,
      rightElbow.y,
      rightElbow.z,
      lowerArmLength,
      rightArmAngle + pose.rightElbowBend,
      0.045,
    );

    this.setPart(
      this.detailParts.leftHand,
      slot,
      leftHand.x,
      leftHand.y,
      leftHand.z,
    );
    this.setPart(
      this.detailParts.rightHand,
      slot,
      rightHand.x,
      rightHand.y,
      rightHand.z,
    );

    const leftLegAngle = pose.legSwing;
    const rightLegAngle = -pose.legSwing;
    const thighLength = 0.41;
    const calfLength = 0.39;

    const leftKnee = this.setVerticalSegment(
      this.detailParts.leftThigh,
      slot,
      -0.11,
      0.86,
      0,
      thighLength,
      leftLegAngle,
      0.068,
    );
    const leftAnkle = this.setVerticalSegment(
      this.detailParts.leftCalf,
      slot,
      leftKnee.x,
      leftKnee.y,
      leftKnee.z,
      calfLength,
      leftLegAngle - pose.leftKneeBend,
      0.057,
    );

    const rightKnee = this.setVerticalSegment(
      this.detailParts.rightThigh,
      slot,
      0.11,
      0.86,
      0,
      thighLength,
      rightLegAngle,
      0.068,
    );
    const rightAnkle = this.setVerticalSegment(
      this.detailParts.rightCalf,
      slot,
      rightKnee.x,
      rightKnee.y,
      rightKnee.z,
      calfLength,
      rightLegAngle - pose.rightKneeBend,
      0.057,
    );

    this.setPart(
      this.detailParts.leftShoe,
      slot,
      leftAnkle.x,
      Math.max(0.065, leftAnkle.y - 0.01),
      leftAnkle.z - 0.035,
      leftLegAngle - pose.leftKneeBend,
      0,
      0,
      0.16,
      0.085,
      0.27,
    );
    this.setPart(
      this.detailParts.rightShoe,
      slot,
      rightAnkle.x,
      Math.max(0.065, rightAnkle.y - 0.01),
      rightAnkle.z - 0.035,
      rightLegAngle - pose.rightKneeBend,
      0,
      0,
      0.16,
      0.085,
      0.27,
    );

    this.setColor(this.detailParts.torso, slot, appearance.shirt);
    this.setColor(this.detailParts.pelvis, slot, appearance.pants);
    this.setColor(this.detailParts.neck, slot, appearance.skin);
    this.setColor(this.detailParts.head, slot, appearance.skin);
    this.setColor(this.detailParts.hair, slot, appearance.hair);

    this.setColor(this.detailParts.leftUpperArm, slot, appearance.shirt);
    this.setColor(this.detailParts.rightUpperArm, slot, appearance.shirt);
    this.setColor(this.detailParts.leftLowerArm, slot, appearance.skin);
    this.setColor(this.detailParts.rightLowerArm, slot, appearance.skin);
    this.setColor(this.detailParts.leftHand, slot, appearance.skin);
    this.setColor(this.detailParts.rightHand, slot, appearance.skin);

    this.setColor(this.detailParts.leftThigh, slot, appearance.pants);
    this.setColor(this.detailParts.rightThigh, slot, appearance.pants);
    this.setColor(this.detailParts.leftCalf, slot, appearance.pants);
    this.setColor(this.detailParts.rightCalf, slot, appearance.pants);
    this.setColor(this.detailParts.leftShoe, slot, appearance.shoes);
    this.setColor(this.detailParts.rightShoe, slot, appearance.shoes);
  }

  private updateMidAgent(
    agent: CrowdAgent,
    slot: number,
    pose: HumanWalkPose,
    yaw: number,
    x: number,
    y: number,
    z: number,
    appearance: Appearance,
  ) {
    this.setRoot(agent, pose, yaw, x, y, z, appearance, AVATAR_GEOMETRY_HEIGHT_METRES.medium);

    this.setPart(this.midParts.torso, slot, 0, 1.18, 0);
    this.setPart(this.midParts.head, slot, 0, 1.66, 0);
    this.setPart(
      this.midParts.leftArm,
      slot,
      -0.245,
      1.14,
      0,
      pose.armSwing,
      0,
      0.03,
      0.05,
      0.57,
      0.05,
    );
    this.setPart(
      this.midParts.rightArm,
      slot,
      0.245,
      1.14,
      0,
      -pose.armSwing,
      0,
      -0.03,
      0.05,
      0.57,
      0.05,
    );
    this.setPart(
      this.midParts.leftLeg,
      slot,
      -0.105,
      0.43,
      0,
      pose.legSwing,
      0,
      0,
      0.065,
      0.78,
      0.075,
    );
    this.setPart(
      this.midParts.rightLeg,
      slot,
      0.105,
      0.43,
      0,
      -pose.legSwing,
      0,
      0,
      0.065,
      0.78,
      0.075,
    );

    this.setColor(this.midParts.torso, slot, appearance.shirt);
    this.setColor(this.midParts.head, slot, appearance.skin);
    this.setColor(this.midParts.leftArm, slot, appearance.shirt);
    this.setColor(this.midParts.rightArm, slot, appearance.shirt);
    this.setColor(this.midParts.leftLeg, slot, appearance.pants);
    this.setColor(this.midParts.rightLeg, slot, appearance.pants);
  }

  private updateFarAgent(
    agent: CrowdAgent,
    slot: number,
    pose: HumanWalkPose,
    yaw: number,
    x: number,
    y: number,
    z: number,
    appearance: Appearance,
  ) {
    this.setRoot(agent, pose, yaw, x, y, z, appearance, AVATAR_GEOMETRY_HEIGHT_METRES.far);

    this.setPart(this.farParts.body, slot, 0, 1.17, 0);
    this.setPart(this.farParts.lowerBody, slot, 0, 0.5, 0);
    this.setPart(this.farParts.head, slot, 0, 1.66, 0);

    this.setColor(this.farParts.body, slot, appearance.shirt);
    this.setColor(this.farParts.lowerBody, slot, appearance.pants);
    this.setColor(this.farParts.head, slot, appearance.skin);
  }

  private updatePartSet(
    parts: Record<string, THREE.InstancedMesh>,
    count: number,
  ) {
    for (const mesh of Object.values(parts)) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  update(
    simulationTime: number,
    cameraPosition?: THREE.Vector3,
  ) {
    const agents = this.crowd
      .getAgents()
      .slice(0, this.options.capacity);

    const positions = agents.map((agent) => agent.position());
    const distances = positions.map((position) => {
      if (!cameraPosition) return Number.POSITIVE_INFINITY;

      const dx = position.x - cameraPosition.x;
      const dy = position.y - cameraPosition.y;
      const dz = position.z - cameraPosition.z;
      return Math.hypot(dx, dy, dz);
    });

    const lods = selectAvatarLods(distances, this.lodOptions);

    let detailSlot = 0;
    let midSlot = 0;
    let farSlot = 0;

    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      const position = positions[index];
      const velocity = agent.velocity();
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      const horizontalSpeed = Math.hypot(velocity.x, velocity.z);

      let yaw = this.lastYaw.get(agent.agentIndex) ?? 0;

      if (horizontalSpeed > 0.025) {
        // Avatar geometry faces local -Z, so orient that axis along velocity.
        const targetYaw = Math.atan2(-velocity.x, -velocity.z);
        yaw = smoothAngle(yaw, targetYaw, 0.28);
        this.lastYaw.set(agent.agentIndex, yaw);
      }

      const pose = humanWalkPose(
        speed,
        simulationTime,
        agent.agentIndex,
      );

      const profile =
        this.options.profileByAgentIndex?.get(agent.agentIndex) ||
        'Adult';
      const appearance = this.appearanceFor(
        agent.agentIndex,
        profile,
      );

      if (
        lods[index] === 'detail' &&
        detailSlot < this.detailCapacity
      ) {
        this.updateDetailedAgent(
          agent,
          detailSlot,
          pose,
          yaw,
          position.x,
          position.y,
          position.z,
          appearance,
        );
        detailSlot += 1;
      } else if (lods[index] === 'far') {
        this.updateFarAgent(
          agent,
          farSlot,
          pose,
          yaw,
          position.x,
          position.y,
          position.z,
          appearance,
        );
        farSlot += 1;
      } else {
        this.updateMidAgent(
          agent,
          midSlot,
          pose,
          yaw,
          position.x,
          position.y,
          position.z,
          appearance,
        );
        midSlot += 1;
      }
    }

    this.updatePartSet(this.detailParts, detailSlot);
    this.updatePartSet(this.midParts, midSlot);
    this.updatePartSet(this.farParts, farSlot);

    const live = new Set(
      agents.map((agent) => agent.agentIndex),
    );

    for (const agentIndex of this.lastYaw.keys()) {
      if (!live.has(agentIndex)) {
        this.lastYaw.delete(agentIndex);
        this.appearance.delete(agentIndex);
      }
    }
  }

  dispose() {
    this.removeFromParent();

    const allParts = [
      ...Object.values(this.detailParts),
      ...Object.values(this.midParts),
      ...Object.values(this.farParts),
    ];

    for (const mesh of allParts) {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];

      materials.forEach((material) => material.dispose());
      mesh.dispose();
    }

    this.lastYaw.clear();
    this.appearance.clear();
  }
}

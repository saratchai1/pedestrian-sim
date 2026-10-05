import * as THREE from 'three';
import {
  buildObjectForElement,
  isBuildPlan,
  polygonArea,
  snapPlanPoint,
  type BuildElement,
  type BuildPlan,
  type PlanPoint,
  type StairElement,
  type WallElement,
} from './geometry';
import type { NavigationLink } from '../navigation';

export type BuildTool =
  | 'none'
  | 'select'
  | 'floor'
  | 'spawn'
  | 'wall'
  | 'door'
  | 'exit'
  | 'obstacle'
  | 'stair';

export type BuildSettings = {
  elevation: number;
  grid: number;
  wallHeight: number;
  wallThickness: number;
  doorWidth: number;
  doorIsExit: boolean;
  spawnOccupants: number;
  exitWidth: number;
  obstacleHeight: number;
  stairRise: number;
  stairWidth: number;
};

export type BuildActionResult = {
  changed: boolean;
  completed: boolean;
  message: string;
};

const DEFAULT_SETTINGS: BuildSettings = {
  elevation: 0,
  grid: 0.25,
  wallHeight: 3,
  wallThickness: 0.2,
  doorWidth: 1,
  doorIsExit: false,
  spawnOccupants: 50,
  exitWidth: 1.2,
  obstacleHeight: 1,
  stairRise: 3,
  stairWidth: 1.2,
};

function uid() {
  return crypto.randomUUID();
}

function cloneElements(elements: BuildElement[]) {
  return elements.map((element) => structuredClone(element));
}

function distance(a: PlanPoint, b: PlanPoint) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export class BuildEditor {
  readonly root = new THREE.Group();
  readonly preview = new THREE.Group();

  private elements: BuildElement[] = [];
  private history: BuildElement[][] = [];
  private activePoints: PlanPoint[] = [];
  private tool: BuildTool = 'none';
  private settings: BuildSettings = { ...DEFAULT_SETTINGS };
  private selectedId: string | null = null;

  constructor() {
    this.root.name = 'EvacSim build geometry';
    this.preview.name = 'EvacSim build preview';
  }

  setTool(tool: BuildTool) {
    this.tool = tool;
    this.activePoints = [];
    this.refreshPreview();
  }

  getTool() {
    return this.tool;
  }

  setSettings(settings: Partial<BuildSettings>) {
    this.settings = {
      ...this.settings,
      ...settings,
    };
    this.refreshPreview();
  }

  getSettings() {
    return { ...this.settings };
  }

  getElements() {
    return cloneElements(this.elements);
  }

  getSelected() {
    const selected = this.elements.find((element) => element.id === this.selectedId);
    return selected ? structuredClone(selected) : null;
  }

  selectObject(object: THREE.Object3D | null) {
    let current: THREE.Object3D | null = object;
    let id: string | null = null;

    while (current && current !== this.root) {
      const candidate = current.userData.buildElementId;
      if (typeof candidate === 'string') {
        id = candidate;
        break;
      }
      current = current.parent;
    }

    this.selectedId = id;
    this.rebuild();

    const selected = this.getSelected();
    return selected
      ? 'Selected ' + selected.type + '.'
      : 'Selection cleared.';
  }

  handlePoint(point: THREE.Vector3): BuildActionResult {
    if (this.tool === 'none' || this.tool === 'select') {
      return {
        changed: false,
        completed: false,
        message:
          this.tool === 'select'
            ? 'Click a drawn element to select it.'
            : 'Choose a build tool first.',
      };
    }

    const snapped = snapPlanPoint(point, this.settings.grid);

    if (this.tool === 'door') {
      return this.insertDoor(snapped);
    }

    if (this.tool === 'exit') {
      this.pushHistory();
      this.elements.push({
        id: uid(),
        type: 'exit',
        position: snapped,
        elevation: this.settings.elevation,
        width: Math.max(0.3, this.settings.exitWidth),
      });
      this.selectedId = null;
      this.rebuild();

      return {
        changed: true,
        completed: true,
        message: 'Exit added (' + Math.max(0.3, this.settings.exitWidth).toFixed(2) + ' m).',
      };
    }

    if (this.tool === 'floor' || this.tool === 'spawn') {
      this.activePoints.push(snapped);
      this.refreshPreview();
      return {
        changed: false,
        completed: false,
        message:
          this.activePoints.length < 3
            ? 'Add at least ' +
              (3 - this.activePoints.length) +
              ' more polygon point(s).'
            : 'Add more points or press Finish polygon.',
      };
    }

    if (!this.activePoints.length) {
      this.activePoints.push(snapped);
      this.refreshPreview();
      return {
        changed: false,
        completed: false,
        message:
          this.tool === 'stair'
            ? 'Choose the stair end point.'
            : 'Choose the second point.',
      };
    }

    const start = this.activePoints[0];
    const end = snapped;

    if (distance(start, end) < this.settings.grid * 0.5) {
      return {
        changed: false,
        completed: false,
        message: 'The second point is too close to the first point.',
      };
    }

    this.pushHistory();

    if (this.tool === 'wall') {
      this.elements.push({
        id: uid(),
        type: 'wall',
        start,
        end,
        elevation: this.settings.elevation,
        height: Math.max(0.1, this.settings.wallHeight),
        thickness: Math.max(0.02, this.settings.wallThickness),
      });
    } else if (this.tool === 'obstacle') {
      this.elements.push({
        id: uid(),
        type: 'obstacle',
        start,
        end,
        elevation: this.settings.elevation,
        height: Math.max(0.05, this.settings.obstacleHeight),
      });
    } else if (this.tool === 'stair') {
      this.elements.push({
        id: uid(),
        type: 'stair',
        start,
        end,
        startElevation: this.settings.elevation,
        endElevation: this.settings.elevation + this.settings.stairRise,
        width: Math.max(0.2, this.settings.stairWidth),
      });
    }

    this.activePoints = [];
    this.selectedId = null;
    this.rebuild();

    return {
      changed: true,
      completed: true,
      message: 'Build element added.',
    };
  }

  finishPolygon(): BuildActionResult {
    if (this.tool !== 'floor' && this.tool !== 'spawn') {
      return {
        changed: false,
        completed: false,
        message: 'Floor or Spawn Area tool is not active.',
      };
    }

    if (this.activePoints.length < 3) {
      return {
        changed: false,
        completed: false,
        message: 'A polygon needs at least 3 points.',
      };
    }

    if (polygonArea(this.activePoints) < 0.05) {
      return {
        changed: false,
        completed: false,
        message: 'Polygon area is too small.',
      };
    }

    this.pushHistory();

    if (this.tool === 'floor') {
      this.elements.push({
        id: uid(),
        type: 'floor',
        points: this.activePoints.map((point) => ({ ...point })),
        elevation: this.settings.elevation,
      });
      this.selectedId = null;
    } else {
      const id = uid();
      this.elements.push({
        id,
        type: 'spawn',
        points: this.activePoints.map((point) => ({ ...point })),
        elevation: this.settings.elevation,
        occupants: Math.max(1, Math.round(this.settings.spawnOccupants)),
      });
      this.selectedId = id;
    }

    const createdType = this.tool;
    this.activePoints = [];
    this.rebuild();

    return {
      changed: true,
      completed: true,
      message:
        createdType === 'floor'
          ? 'Floor / corridor added.'
          : 'Spawn Area added.',
    };
  }

  finishFloor(): BuildActionResult {
    return this.finishPolygon();
  }

  cancelActive() {
    this.activePoints = [];
    this.refreshPreview();
  }

  updateSpawnOccupants(
    id: string,
    value: number,
  ): BuildActionResult {
    const element = this.elements.find((item) => item.id === id);

    if (!element || element.type !== 'spawn') {
      return {
        changed: false,
        completed: false,
        message: 'Spawn Area not found.',
      };
    }

    if (!Number.isFinite(value) || value < 1) {
      return {
        changed: false,
        completed: false,
        message: 'Occupants must be a number of at least 1.',
      };
    }

    const occupants = Math.max(1, Math.round(value));

    if (element.occupants === occupants) {
      return {
        changed: false,
        completed: true,
        message: 'Already saved · ' + occupants + ' people.',
      };
    }

    this.pushHistory();
    element.occupants = occupants;
    this.rebuild();

    return {
      changed: true,
      completed: true,
      message: 'Saved · ' + occupants + ' people.',
    };
  }

  updateSelectedSpawnOccupants(value: number): BuildActionResult {
    if (!this.selectedId) {
      return {
        changed: false,
        completed: false,
        message: 'Select a Spawn Area first.',
      };
    }

    return this.updateSpawnOccupants(this.selectedId, value);
  }

  deleteSelected() {
    if (!this.selectedId) return 'Select an element first.';

    const index = this.elements.findIndex((element) => element.id === this.selectedId);
    if (index < 0) return 'Selected element no longer exists.';

    this.pushHistory();
    const [removed] = this.elements.splice(index, 1);
    this.selectedId = null;
    this.rebuild();
    return 'Deleted ' + removed.type + '.';
  }

  moveSelected(dx: number, dz: number, dy = 0) {
    if (!this.selectedId) return 'Select an element first.';

    const element = this.elements.find((item) => item.id === this.selectedId);
    if (!element) return 'Selected element no longer exists.';

    this.pushHistory();

    const movePoint = (point: PlanPoint) => {
      point.x += dx;
      point.z += dz;
    };

    if (element.type === 'floor' || element.type === 'spawn') {
      element.points.forEach(movePoint);
      element.elevation += dy;
    } else if (element.type === 'wall' || element.type === 'obstacle') {
      movePoint(element.start);
      movePoint(element.end);
      element.elevation += dy;
    } else if (element.type === 'door') {
      movePoint(element.start);
      movePoint(element.end);
      element.elevation += dy;
    } else if (element.type === 'exit') {
      movePoint(element.position);
      element.elevation += dy;
    } else if (element.type === 'stair') {
      movePoint(element.start);
      movePoint(element.end);
      element.startElevation += dy;
      element.endElevation += dy;
    }

    this.rebuild();
    return 'Moved selected ' + element.type + '.';
  }

  undo() {
    if (this.activePoints.length) {
      this.activePoints.pop();
      this.refreshPreview();
      return 'Removed the last drawing point.';
    }

    const previous = this.history.pop();
    if (!previous) return 'Nothing to undo.';

    this.elements = cloneElements(previous);
    this.selectedId = null;
    this.rebuild();
    return 'Undid the last geometry change.';
  }

  clear() {
    if (this.elements.length) this.pushHistory();
    this.elements = [];
    this.activePoints = [];
    this.selectedId = null;
    this.rebuild();
  }

  stats() {
    const count = (type: BuildElement['type']) =>
      this.elements.filter((element) => element.type === type).length;

    return {
      total: this.elements.length,
      floors: count('floor'),
      spawnAreas: count('spawn'),
      spawnOccupants: this.elements
        .filter(
          (element): element is Extract<BuildElement, { type: 'spawn' }> =>
            element.type === 'spawn',
        )
        .reduce((sum, element) => sum + element.occupants, 0),
      walls: count('wall'),
      doors: count('door'),
      exitDoors: this.elements.filter(
        (element) => element.type === 'door' && element.isExit,
      ).length,
      directExits: count('exit'),
      obstacles: count('obstacle'),
      stairs: count('stair'),
    };
  }

  getSpawnAreas() {
    return this.elements
      .filter(
        (
          element,
        ): element is Extract<BuildElement, { type: 'spawn' }> =>
          element.type === 'spawn',
      )
      .map((spawn, index) => ({
        id: spawn.id,
        name: 'Spawn Area ' + (index + 1),
        points: spawn.points.map((point) => ({ ...point })),
        elevation: spawn.elevation,
        occupants: spawn.occupants,
      }));
  }

  getExitCandidates() {
    const doors = this.elements
      .filter(
        (
          element,
        ): element is Extract<BuildElement, { type: 'door' }> =>
          element.type === 'door' && Boolean(element.isExit),
      )
      .map((door, index) => ({
        id: door.id,
        name: 'Door Exit ' + (index + 1),
        width: distance(door.start, door.end),
        position: new THREE.Vector3(
          (door.start.x + door.end.x) / 2,
          door.elevation,
          (door.start.z + door.end.z) / 2,
        ),
      }));

    const direct = this.elements
      .filter(
        (
          element,
        ): element is Extract<BuildElement, { type: 'exit' }> =>
          element.type === 'exit',
      )
      .map((exit, index) => ({
        id: exit.id,
        name: 'Exit ' + (index + 1),
        width: exit.width,
        position: new THREE.Vector3(
          exit.position.x,
          exit.elevation,
          exit.position.z,
        ),
      }));

    return [...doors, ...direct];
  }

  getNavigationLinks(): NavigationLink[] {
    return this.elements
      .filter((element): element is StairElement => element.type === 'stair')
      .map((stair, index) => ({
        startPosition: {
          x: stair.start.x,
          y: stair.startElevation,
          z: stair.start.z,
        },
        endPosition: {
          x: stair.end.x,
          y: stair.endElevation,
          z: stair.end.z,
        },
        radius: Math.max(0.35, stair.width / 2),
        bidirectional: true,
        area: 0,
        flags: 1,
        userId: 100000 + index,
      }));
  }

  exportPlan() {
    const plan: BuildPlan = {
      version: 1,
      elements: cloneElements(this.elements),
    };

    return JSON.stringify(plan, null, 2);
  }

  importPlan(raw: string) {
    const parsed: unknown = JSON.parse(raw);
    if (!isBuildPlan(parsed)) {
      throw new Error('Unsupported EvacSim plan file.');
    }

    if (this.elements.length) this.pushHistory();
    this.elements = cloneElements(parsed.elements);
    this.activePoints = [];
    this.selectedId = null;
    this.rebuild();
  }

  dispose() {
    this.clearGroup(this.root);
    this.clearGroup(this.preview);
    this.root.removeFromParent();
    this.preview.removeFromParent();
  }

  private insertDoor(point: PlanPoint): BuildActionResult {
    const wallCandidates = this.elements
      .filter((element): element is WallElement => element.type === 'wall')
      .filter(
        (wall) =>
          Math.abs(wall.elevation - this.settings.elevation) <=
          Math.max(0.2, this.settings.grid),
      );

    let best:
      | {
          wall: WallElement;
          projected: PlanPoint;
          along: number;
          wallLength: number;
          perpendicular: number;
        }
      | null = null;

    for (const wall of wallCandidates) {
      const vx = wall.end.x - wall.start.x;
      const vz = wall.end.z - wall.start.z;
      const lengthSquared = vx * vx + vz * vz;
      if (lengthSquared <= 0.0001) continue;

      const t = Math.max(
        0,
        Math.min(
          1,
          ((point.x - wall.start.x) * vx + (point.z - wall.start.z) * vz) /
            lengthSquared,
        ),
      );
      const projected = {
        x: wall.start.x + vx * t,
        z: wall.start.z + vz * t,
      };
      const perpendicular = distance(point, projected);
      const wallLength = Math.sqrt(lengthSquared);
      const along = t * wallLength;

      if (!best || perpendicular < best.perpendicular) {
        best = { wall, projected, along, wallLength, perpendicular };
      }
    }

    if (!best) {
      return {
        changed: false,
        completed: false,
        message: 'No wall exists on this elevation.',
      };
    }

    const tolerance = Math.max(
      0.65,
      best.wall.thickness * 3,
      this.settings.grid * 2,
    );

    if (best.perpendicular > tolerance) {
      return {
        changed: false,
        completed: false,
        message: 'Click closer to a wall to insert a door.',
      };
    }

    const desiredWidth = Math.max(0.3, this.settings.doorWidth);
    const minimumSide = 0.08;
    const maximumWidth = best.wallLength - minimumSide * 2;

    if (maximumWidth < 0.3) {
      return {
        changed: false,
        completed: false,
        message: 'This wall is too short for a door opening.',
      };
    }

    const width = Math.min(desiredWidth, maximumWidth);
    const half = width / 2;
    const centerDistance = Math.max(
      half + minimumSide,
      Math.min(best.wallLength - half - minimumSide, best.along),
    );

    const ux = (best.wall.end.x - best.wall.start.x) / best.wallLength;
    const uz = (best.wall.end.z - best.wall.start.z) / best.wallLength;
    const openingStart = {
      x: best.wall.start.x + ux * (centerDistance - half),
      z: best.wall.start.z + uz * (centerDistance - half),
    };
    const openingEnd = {
      x: best.wall.start.x + ux * (centerDistance + half),
      z: best.wall.start.z + uz * (centerDistance + half),
    };

    this.pushHistory();
    this.elements = this.elements.filter((element) => element.id !== best.wall.id);

    if (distance(best.wall.start, openingStart) > minimumSide) {
      this.elements.push({
        ...structuredClone(best.wall),
        id: uid(),
        start: { ...best.wall.start },
        end: openingStart,
      });
    }

    if (distance(openingEnd, best.wall.end) > minimumSide) {
      this.elements.push({
        ...structuredClone(best.wall),
        id: uid(),
        start: openingEnd,
        end: { ...best.wall.end },
      });
    }

    this.elements.push({
      id: uid(),
      type: 'door',
      start: openingStart,
      end: openingEnd,
      elevation: best.wall.elevation,
      isExit: this.settings.doorIsExit,
    });

    this.activePoints = [];
    this.selectedId = null;
    this.rebuild();

    return {
      changed: true,
      completed: true,
      message: 'Door opening inserted (' + width.toFixed(2) + ' m).',
    };
  }

  private pushHistory() {
    this.history.push(cloneElements(this.elements));
    if (this.history.length > 50) this.history.shift();
  }

  private rebuild() {
    this.clearGroup(this.root);

    for (const element of this.elements) {
      const object = buildObjectForElement(element);
      if (element.id === this.selectedId) this.highlight(object);
      this.root.add(object);
    }

    this.refreshPreview();
  }

  private highlight(object: THREE.Object3D) {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Line)) {
        return;
      }

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      materials.forEach((material) => {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.emissive.set(0x0ea5e9);
          material.emissiveIntensity = 0.65;
        } else if (
          'color' in material &&
          material.color instanceof THREE.Color
        ) {
          material.color.set(0xf59e0b);
        }
      });
    });
  }

  private refreshPreview() {
    this.clearGroup(this.preview);
    if (!this.activePoints.length) return;

    const points = this.activePoints.map(
      (point) =>
        new THREE.Vector3(
          point.x,
          this.settings.elevation + 0.035,
          point.z,
        ),
    );

    if (
      (this.tool === 'floor' || this.tool === 'spawn') &&
      points.length > 1
    ) {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x38bdf8 }),
      );
      this.preview.add(line);
    }

    for (const point of points) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
      );
      marker.position.copy(point);
      this.preview.add(marker);
    }
  }

  private clearGroup(group: THREE.Group) {
    const children = [...group.children];

    children.forEach((child) => {
      group.remove(child);
      child.traverse((object) => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) {
          return;
        }

        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        materials.forEach((material) => material.dispose());
      });
    });
  }
}

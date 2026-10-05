import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BuildEditor } from '../src/build/editor';
import { polygonArea, snapPlanPoint, snapValue } from '../src/build/geometry';

describe('Build Mode geometry', () => {
  it('snaps plan coordinates to the configured metric grid', () => {
    expect(snapValue(2.13, 0.25)).toBeCloseTo(2.25, 10);
    expect(snapPlanPoint({ x: -1.12, z: 3.37 }, 0.25)).toEqual({
      x: -1,
      z: 3.25,
    });
  });

  it('calculates polygon floor area', () => {
    expect(
      polygonArea([
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 5 },
        { x: 0, z: 5 },
      ]),
    ).toBeCloseTo(50, 10);
  });

  it('creates a floor/corridor from clicked points and exports it', () => {
    const editor = new BuildEditor();
    editor.setTool('floor');
    editor.setSettings({ elevation: 1.5, grid: 0.25 });

    editor.handlePoint(new THREE.Vector3(0.02, 1.5, 0.01));
    editor.handlePoint(new THREE.Vector3(4.01, 1.5, 0.02));
    editor.handlePoint(new THREE.Vector3(4.03, 1.5, 2.02));
    editor.handlePoint(new THREE.Vector3(0.01, 1.5, 2.01));

    const result = editor.finishFloor();

    expect(result.changed).toBe(true);
    expect(editor.stats().floors).toBe(1);

    const plan = JSON.parse(editor.exportPlan());
    expect(plan.version).toBe(1);
    expect(plan.elements[0].type).toBe('floor');
    expect(plan.elements[0].elevation).toBe(1.5);
  });

  it('creates persistent Spawn Areas with their own occupant count', () => {
    const editor = new BuildEditor();
    editor.setTool('spawn');
    editor.setSettings({
      elevation: 0,
      grid: 0.25,
      spawnOccupants: 37,
    });

    editor.handlePoint(new THREE.Vector3(0, 0, 0));
    editor.handlePoint(new THREE.Vector3(4, 0, 0));
    editor.handlePoint(new THREE.Vector3(4, 0, 3));
    editor.handlePoint(new THREE.Vector3(0, 0, 3));

    const result = editor.finishPolygon();

    expect(result.changed).toBe(true);
    expect(editor.stats().spawnAreas).toBe(1);
    expect(editor.stats().spawnOccupants).toBe(37);

    const areas = editor.getSpawnAreas();
    expect(areas).toHaveLength(1);
    expect(areas[0].occupants).toBe(37);
    expect(areas[0].points).toHaveLength(4);
  });

  it('edits selected Spawn Area occupants and persists the saved value', () => {
    const editor = new BuildEditor();
    editor.setTool('spawn');
    editor.setSettings({
      elevation: 0,
      grid: 0.25,
      spawnOccupants: 37,
    });

    editor.handlePoint(new THREE.Vector3(0, 0, 0));
    editor.handlePoint(new THREE.Vector3(4, 0, 0));
    editor.handlePoint(new THREE.Vector3(4, 0, 3));
    editor.handlePoint(new THREE.Vector3(0, 0, 3));
    editor.finishPolygon();

    expect(editor.getSelected()?.type).toBe('spawn');

    const result = editor.updateSelectedSpawnOccupants(20);

    expect(result.changed).toBe(true);
    expect(result.message).toBe('Saved · 20 people.');
    expect(editor.stats().spawnOccupants).toBe(20);
    expect(editor.getSpawnAreas()[0].occupants).toBe(20);

    const savedPlan = JSON.parse(editor.exportPlan());
    const savedSpawn = savedPlan.elements.find(
      (element: { type: string }) => element.type === 'spawn',
    );
    expect(savedSpawn.occupants).toBe(20);

    editor.undo();
    expect(editor.stats().spawnOccupants).toBe(37);
  });

  it('edits a Spawn Area population directly by id without selection', () => {
    const editor = new BuildEditor();
    editor.setTool('spawn');
    editor.setSettings({
      elevation: 0,
      grid: 0.25,
      spawnOccupants: 50,
    });

    editor.handlePoint(new THREE.Vector3(0, 0, 0));
    editor.handlePoint(new THREE.Vector3(4, 0, 0));
    editor.handlePoint(new THREE.Vector3(4, 0, 3));
    editor.handlePoint(new THREE.Vector3(0, 0, 3));
    editor.finishPolygon();

    const area = editor.getSpawnAreas()[0];
    const result = editor.updateSpawnOccupants(area.id, 20);

    expect(result.changed).toBe(true);
    expect(result.message).toBe('Saved · 20 people.');
    expect(editor.stats().spawnOccupants).toBe(20);
    expect(editor.getSpawnAreas()[0].occupants).toBe(20);

    const savedPlan = JSON.parse(editor.exportPlan());
    const savedSpawn = savedPlan.elements.find(
      (element: { type: string }) => element.type === 'spawn',
    );
    expect(savedSpawn.occupants).toBe(20);
  });

  it('creates a direct Build Mode exit with configurable width', () => {
    const editor = new BuildEditor();
    editor.setTool('exit');
    editor.setSettings({
      elevation: 0,
      grid: 0.25,
      exitWidth: 1.4,
    });

    const result = editor.handlePoint(new THREE.Vector3(5.12, 0, 2.88));

    expect(result.changed).toBe(true);
    expect(editor.stats().directExits).toBe(1);

    const exits = editor.getExitCandidates();
    expect(exits).toHaveLength(1);
    expect(exits[0].width).toBeCloseTo(1.4, 10);
    expect(exits[0].position.x).toBeCloseTo(5, 10);
    expect(exits[0].position.z).toBeCloseTo(3, 10);
  });

  it('cuts a real door opening into an existing wall and restores it on undo', () => {
    const editor = new BuildEditor();
    editor.setSettings({
      elevation: 0,
      grid: 0.25,
      wallHeight: 3,
      wallThickness: 0.2,
      doorWidth: 1,
      doorIsExit: true,
    });

    editor.setTool('wall');
    editor.handlePoint(new THREE.Vector3(0, 0, 0));
    editor.handlePoint(new THREE.Vector3(5, 0, 0));

    expect(editor.stats().walls).toBe(1);

    editor.setTool('door');
    const door = editor.handlePoint(new THREE.Vector3(2.5, 0, 0.1));

    expect(door.changed).toBe(true);
    expect(editor.stats().walls).toBe(2);
    expect(editor.stats().doors).toBe(1);
    expect(editor.stats().exitDoors).toBe(1);

    const exits = editor.getExitCandidates();
    expect(exits).toHaveLength(1);
    expect(exits[0].width).toBeCloseTo(1, 10);
    expect(exits[0].position.x).toBeCloseTo(2.5, 10);

    const opening = editor
      .getElements()
      .find((element) => element.type === 'door');

    expect(opening?.type).toBe('door');
    if (opening?.type === 'door') {
      expect(
        Math.hypot(
          opening.end.x - opening.start.x,
          opening.end.z - opening.start.z,
        ),
      ).toBeCloseTo(1, 10);
    }

    editor.undo();
    expect(editor.stats().walls).toBe(1);
    expect(editor.stats().doors).toBe(0);
  });

  it('selects and moves a drawn obstacle', () => {
    const editor = new BuildEditor();
    editor.setTool('obstacle');
    editor.handlePoint(new THREE.Vector3(0, 0, 0));
    editor.handlePoint(new THREE.Vector3(2, 0, 2));

    const object = editor.root.children[0];
    expect(editor.selectObject(object)).toContain('Selected obstacle');

    const before = editor.getSelected();
    editor.moveSelected(1, -2, 0.5);
    const after = editor.getSelected();

    expect(before?.type).toBe('obstacle');
    expect(after?.type).toBe('obstacle');

    if (before?.type === 'obstacle' && after?.type === 'obstacle') {
      expect(after.start.x).toBeCloseTo(before.start.x + 1, 10);
      expect(after.start.z).toBeCloseTo(before.start.z - 2, 10);
      expect(after.elevation).toBeCloseTo(before.elevation + 0.5, 10);
    }
  });

  it('creates a stair off-mesh link between elevations', () => {
    const editor = new BuildEditor();
    editor.setTool('stair');
    editor.setSettings({
      elevation: 0,
      grid: 0.25,
      stairRise: 3,
      stairWidth: 1.2,
    });

    editor.handlePoint(new THREE.Vector3(0, 0, 0));
    const result = editor.handlePoint(new THREE.Vector3(4, 0, 0));

    expect(result.changed).toBe(true);

    const links = editor.getNavigationLinks();
    expect(links).toHaveLength(1);
    expect(links[0].startPosition.y).toBe(0);
    expect(links[0].endPosition.y).toBe(3);
    expect(links[0].radius).toBeCloseTo(0.6, 10);
  });
});

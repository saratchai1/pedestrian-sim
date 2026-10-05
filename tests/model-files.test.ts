import { describe, expect, it } from 'vitest';
import { MAX_DIRECT_FBX_BYTES, selectModelFiles } from '../src/importers/model-files';

const file = (name: string, size = 1024) => ({ name, size });

describe('large-model import selection', () => {
  it('keeps small FBX import supported and rejects browser buffering for large FBX', () => {
    expect(selectModelFiles([file('small.fbx')]).kind).toBe('fbx');
    expect(() => selectModelFiles([file('zoo.fbx', MAX_DIRECT_FBX_BYTES + 1)])).toThrow(
      /limited to 100 MiB.*visual\.glb.*nav\.glb/,
    );
  });

  it('recognizes the visual and navigation derivative pair independent of order', () => {
    const visual = file('visual.glb');
    const nav = file('nav.glb');
    const selected = selectModelFiles([nav, visual]);
    expect(selected.kind).toBe('derivatives');
    if (selected.kind === 'derivatives') {
      expect(selected.visualFile).toBe(visual);
      expect(selected.navigationFile).toBe(nav);
    }
  });

  it('requires both derivatives when the visual derivative is selected', () => {
    expect(() => selectModelFiles([file('zoo-visual.glb')])).toThrow(/both visual\.glb and nav\.glb/);
    expect(() => selectModelFiles([file('visual.glb'), file('other.glb')])).toThrow(/both visual\.glb and nav\.glb/);
  });

  it('accepts standalone GLB and IFC models', () => {
    expect(selectModelFiles([file('small.glb')]).kind).toBe('glb');
    expect(selectModelFiles([file('building.ifc')]).kind).toBe('ifc');
  });
});

export type ModelFileLike = {
  name: string;
  size: number;
};

export const MAX_DIRECT_FBX_BYTES = 100 * 1024 * 1024;

export type ModelImportSelection<T extends ModelFileLike = File> =
  | { kind: 'ifc'; file: T }
  | { kind: 'fbx'; file: T }
  | { kind: 'glb'; visualFile: T; navigationFile?: T }
  | { kind: 'derivatives'; visualFile: T; navigationFile: T };

function derivativeRole(name: string): 'visual' | 'nav' | null {
  const basename = name.replaceAll('\\', '/').split('/').pop() || name;
  if (/(?:^|[-_.])visual\.glb$/i.test(basename)) return 'visual';
  if (/(?:^|[-_.])(?:nav|navigation)\.glb$/i.test(basename)) return 'nav';
  return null;
}

export function selectModelFiles<T extends ModelFileLike>(
  files: readonly T[],
): ModelImportSelection<T> {
  if (files.length === 0) throw new Error('Select a model file first.');

  if (files.length === 2 && files.every((file) => file.name.toLowerCase().endsWith('.glb'))) {
    const visualFile = files.find((file) => derivativeRole(file.name) === 'visual');
    const navigationFile = files.find((file) => derivativeRole(file.name) === 'nav');
    if (!visualFile || !navigationFile || visualFile === navigationFile) {
      throw new Error('For a preprocessed zoo model, select both visual.glb and nav.glb together.');
    }
    return { kind: 'derivatives', visualFile, navigationFile };
  }

  if (files.length !== 1) {
    throw new Error('Import one IFC/FBX/GLB file, or select the visual.glb and nav.glb pair together.');
  }

  const file = files[0];
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'ifc') return { kind: 'ifc', file };
  if (extension === 'fbx') {
    if (file.size > MAX_DIRECT_FBX_BYTES) {
      const sizeMiB = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(
        `This FBX is ${sizeMiB} MiB. Direct browser FBX import is limited to 100 MiB because FBXLoader buffers and parses the whole file in memory. Run npm run model -- --input "${file.name}" and import visual.glb with nav.glb.`,
      );
    }
    return { kind: 'fbx', file };
  }
  if (extension === 'glb') {
    if (derivativeRole(file.name) === 'visual') {
      throw new Error('Select both visual.glb and nav.glb together for a preprocessed zoo model.');
    }
    return { kind: 'glb', visualFile: file };
  }

  throw new Error('Only IFC, small FBX, or binary glTF (.glb) files are supported.');
}

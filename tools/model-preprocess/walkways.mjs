import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolvePath(scriptDirectory, '../..');
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const input = resolvePath(repositoryRoot, option('--input', 'generated/models/zoo/nav.glb'));
const config = resolvePath(repositoryRoot, option('--config', 'config/zoo-model.local.json'));
const output = resolvePath(repositoryRoot, option('--output', 'generated/models/zoo/walkways.glb'));
const pythonScript = join(scriptDirectory, 'filter_walkways.py');

if (!existsSync(input)) throw new Error(`Navigation GLB does not exist: ${input}`);
if (!existsSync(config)) throw new Error(`Local model config does not exist: ${config}`);

function blenderExecutable() {
  const explicit = process.env.BLENDER_EXE || process.env.BLENDER_PATH;
  if (explicit) {
    const candidate = resolvePath(explicit);
    if (candidate.toLowerCase().endsWith('.exe') && existsSync(candidate)) return candidate;
    for (const relative of ['blender.exe', 'bin/blender.exe']) {
      const path = join(candidate, relative);
      if (existsSync(path)) return path;
    }
    throw new Error(`BLENDER_EXE/BLENDER_PATH does not point to blender.exe: ${explicit}`);
  }

  const candidates = [
    join(repositoryRoot, '.tools', 'blender', 'blender.exe'),
    join(repositoryRoot, '.tools', 'blender', 'bin', 'blender.exe'),
    join(repositoryRoot, 'tools', 'blender', 'blender.exe'),
    join(repositoryRoot, 'tools', 'blender', 'bin', 'blender.exe'),
  ];
  for (const toolsDirectory of [join(repositoryRoot, '.tools'), join(repositoryRoot, 'tools')]) {
    if (!existsSync(toolsDirectory)) continue;
    for (const entry of readdirSync(toolsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (toolsDirectory.endsWith('tools') && !entry.name.toLowerCase().startsWith('blender-')) continue;
      candidates.push(join(toolsDirectory, entry.name, 'blender.exe'));
      candidates.push(join(toolsDirectory, entry.name, 'bin', 'blender.exe'));
    }
  }
  return candidates.find(existsSync) || 'blender';
}

const executable = blenderExecutable();
process.stdout.write(`BLENDER_EXECUTABLE=${executable}\n`);
const result = spawnSync(executable, [
  '--background',
  '--factory-startup',
  '--python-exit-code',
  '1',
  '--python',
  pythonScript,
  '--',
  '--input', input,
  '--config', config,
  '--output', output,
], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(`Could not start Blender: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolvePath(scriptDirectory, '../..');
const args = process.argv.slice(2);
const localConfig = join(repositoryRoot, 'config', 'zoo-model.local.json');
const exampleConfig = join(repositoryRoot, 'config', 'zoo-model.example.json');

if (!existsSync(localConfig)) {
  copyFileSync(exampleConfig, localConfig);
  process.stdout.write(`Created ignored local config: ${localConfig}\n`);
  process.stdout.write('Review detected FBX units and imported dimensions in model-inspection.md before preprocessing.\n');
}

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
    if (existsSync(toolsDirectory)) {
      for (const entry of readdirSync(toolsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (toolsDirectory.endsWith('tools') && !entry.name.toLowerCase().startsWith('blender-')) continue;
        candidates.push(join(toolsDirectory, entry.name, 'blender.exe'));
        candidates.push(join(toolsDirectory, entry.name, 'bin', 'blender.exe'));
      }
    }
  }
  return candidates.find(existsSync) || 'blender';
}

const inspectOnly = args.includes('--inspect-only');
const pythonScript = join(scriptDirectory, inspectOnly ? 'inspect_model.py' : 'preprocess_zoo_model.py');
const executable = blenderExecutable();
const blenderArgs = [
  '--background',
  '--factory-startup',
  '--python-exit-code',
  '1',
  '--python',
  pythonScript,
  '--',
  ...args.filter((argument) => argument !== '--inspect-only'),
];

process.stdout.write(`BLENDER_EXECUTABLE=${executable}\n`);
process.stdout.write(`BLENDER_SCRIPT=${pythonScript}\n`);
const result = spawnSync(executable, blenderArgs, {
  cwd: repositoryRoot,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(
    `Could not start Blender. Install the Windows portable ZIP or set BLENDER_EXE to blender.exe. Details: ${result.error.message}\n`,
  );
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname } from 'node:path';

const limitBytes = 25 * 1024 * 1024;
const protectedModelExtensions = new Set(['.fbx', '.glb', '.blend', '.ifc']);

function listRepositoryFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return output.toString('utf8').split('\0').filter(Boolean);
}

const violations = [];
for (const path of listRepositoryFiles()) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    continue;
  }
  if (!stats.isFile()) continue;
  const extension = extname(path).toLowerCase();
  if (stats.size > limitBytes) {
    violations.push(`${path}: ${(stats.size / (1024 * 1024)).toFixed(1)} MiB exceeds the ${limitBytes / (1024 * 1024)} MiB repository artifact limit`);
  } else if (protectedModelExtensions.has(extension) && stats.size > 2 * 1024 * 1024) {
    violations.push(`${path}: ${(stats.size / (1024 * 1024)).toFixed(1)} MiB model asset; keep model assets local or use a documented small fixture`);
  }
}

if (violations.length) {
  process.stderr.write(`Large model artifact safety check failed:\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Large model artifact safety check passed.\n');
}

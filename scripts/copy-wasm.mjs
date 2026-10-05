import { copyFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const candidates = [
  'node_modules/web-ifc/web-ifc.wasm',
  'node_modules/web-ifc/wasm/web-ifc.wasm',
];

await mkdir('public', { recursive: true });

for (const candidate of candidates) {
  try {
    await access(candidate, constants.R_OK);
    await copyFile(candidate, 'public/web-ifc.wasm');
    process.exit(0);
  } catch {
    // Try the next package layout.
  }
}

throw new Error('Could not find web-ifc.wasm in the installed web-ifc package');

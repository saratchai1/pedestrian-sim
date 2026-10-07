import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const source = 'generated/models/zoo/walkways.glb';
const destination = 'public/generated/models/zoo/walkways.glb';

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
process.stdout.write(`Copied ${source} to ${destination}\n`);

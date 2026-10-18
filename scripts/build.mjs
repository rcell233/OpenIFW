import { cp, mkdir, readdir, rm } from 'node:fs/promises';

const source = new URL('../web/', import.meta.url);
const output = new URL('../dist/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true, dereference: false });

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countFiles(new URL(entry.name + '/', directory)) : 1;
  }
  return count;
}

console.log(`OpenIFW: ${await countFiles(output)} files built into dist/`);

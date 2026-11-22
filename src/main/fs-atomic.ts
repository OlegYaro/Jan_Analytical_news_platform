// Атомарная запись: временный файл в той же папке + rename.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let counter = 0;

export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${counter++}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

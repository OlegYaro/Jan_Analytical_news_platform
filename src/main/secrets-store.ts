// Хранилище секретов без electron: шифрование подаётся снаружи.
// Файл: JSON {имя: base64(шифртекст)}, запись атомарная, права 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SecretStoreOptions {
  file: string;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
}

export interface SecretStore {
  set(name: string, value: string): void;
  has(name: string): boolean;
  /** Только для main-процесса, в IPC не отдавать (NFR-12). */
  get(name: string): string | null;
  delete(name: string): void;
}

export function createSecretStore(opts: SecretStoreOptions): SecretStore {
  const { file, encrypt, decrypt } = opts;

  function load(): Record<string, string> {
    try {
      if (!existsSync(file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return {}; // битый файл = секретов нет, пользователь введёт заново
    }
  }

  function save(data: Record<string, string>): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  return {
    set(name, value) {
      const data = load();
      data[name] = encrypt(value).toString('base64');
      save(data);
    },
    has(name) {
      return Object.hasOwn(load(), name);
    },
    get(name) {
      const raw = load()[name];
      if (raw === undefined) return null;
      try {
        return decrypt(Buffer.from(raw, 'base64'));
      } catch {
        return null; // не расшифровывается (другой ключ/повреждение)
      }
    },
    delete(name) {
      const data = load();
      if (!Object.hasOwn(data, name)) return;
      delete data[name];
      save(data);
    },
  };
}

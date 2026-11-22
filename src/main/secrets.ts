// Секреты через electron safeStorage (NFR-12). Только main-процесс, в renderer не передаются.
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { mt, langOf } from './i18n.ts';
import { loadSettings } from './settings/store.ts';
import { createSecretStore } from './secrets-store.ts';
import type { SecretStore } from './secrets-store.ts';

export type SecretName = 'mailPassword' | 'telegramToken';

let store: SecretStore | undefined;

function getStore(requireEncryption = true): SecretStore {
  if (requireEncryption && !safeStorage.isEncryptionAvailable()) {
    const L = langOf(loadSettings(app.getPath('userData')));
    throw new Error(
      mt(
        L,
        'Безопасное хранилище macOS (Связка ключей) недоступно, пароль сохранить нельзя. ' +
          'Откройте приложение из «Программ» под обычной учётной записью и повторите.',
        'The macOS secure storage (Keychain) is unavailable, so the password cannot be saved. ' +
          'Open the app from Applications under a regular user account and try again.',
      ),
    );
  }
  store ??= createSecretStore({
    file: join(app.getPath('userData'), 'secrets.json'),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  return store;
}

export function setSecret(name: SecretName, value: string): void {
  getStore().set(name, value);
}
/** Только наличие записи в файле: шифрование не нужно, исключений нет (даже до app.ready). */
export function hasSecret(name: SecretName): boolean {
  try {
    return getStore(false).has(name);
  } catch {
    return false;
  }
}
/** Только для main-процесса. */
export function getSecret(name: SecretName): string | null {
  return getStore().get(name);
}
export function deleteSecret(name: SecretName): void {
  getStore().delete(name);
}

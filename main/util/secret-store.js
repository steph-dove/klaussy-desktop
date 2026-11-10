// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Encrypts secrets at rest with Electron safeStorage (Keychain, DPAPI or libsecret), never plaintext.

class SecretStoreError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'SecretStoreError';
    this.kind = kind;
  }
}

// Required lazily so plain-Node callers that never touch a secret don't need electron.
function safeStorage() {
  return require('electron').safeStorage;
}

// Linux without a keyring falls back to a hard-coded key ("basic_text"), which
// is plaintext in practice, so it counts as unavailable.
function available() {
  const ss = safeStorage();
  if (!ss || !ss.isEncryptionAvailable()) return false;
  if (process.platform === 'linux' && typeof ss.getSelectedStorageBackend === 'function') {
    return ss.getSelectedStorageBackend() !== 'basic_text';
  }
  return true;
}

function encrypt(plain) {
  if (!available()) {
    throw new SecretStoreError('Secure storage is not available on this system.', 'unavailable');
  }
  return safeStorage().encryptString(String(plain)).toString('base64');
}

function decrypt(encoded) {
  if (!encoded) throw new SecretStoreError('No saved secret.', 'missing');
  try {
    return safeStorage().decryptString(Buffer.from(encoded, 'base64'));
  } catch (_) {
    // A keychain reset or a config copied from another machine can't be decrypted.
    throw new SecretStoreError('The saved secret could not be decrypted.', 'undecryptable');
  }
}

module.exports = { available, encrypt, decrypt, SecretStoreError };

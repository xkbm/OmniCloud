import { getProviderCapabilities, PROVIDER_CAPABILITIES } from './capabilities.js';

export const PROVIDER_LABELS = Object.freeze({
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  yandex: 'Yandex Disk',
  mega: 'MEGA',
  pcloud: 'pCloud',
  s3: 'Amazon S3',
});

export class StorageBackend {
  constructor(account = {}) {
    this.id = String(account.id || '');
    this.userId = account.user_id || account.userId || null;
    this.provider = account.provider || 'unknown';
    this.email = account.email || null;
    this.status = account.status || 'unknown';
    this.totalSpace = Math.max(0, Number(account.total_space ?? account.totalSpace ?? 0));
    this.usedSpace = Math.max(0, Number(account.used_space ?? account.usedSpace ?? 0));
    this.freeSpace = Math.max(0, this.totalSpace - this.usedSpace);
    this.capabilities = {
      ...getProviderCapabilities(this.provider),
      ...(account.capabilities || {}),
    };
  }

  get label() {
    return PROVIDER_LABELS[this.provider] || this.provider;
  }

  get healthy() {
    return this.status === 'active';
  }

  canStore(size = 0) {
    return this.healthy && this.capabilities.upload && this.freeSpace >= Math.max(0, Number(size || 0));
  }

  canNativeMove() {
    return this.healthy && this.capabilities.move;
  }

  serialize() {
    return {
      id: this.id,
      provider: this.provider,
      label: this.label,
      email: this.email,
      status: this.status,
      healthy: this.healthy,
      total_space: this.totalSpace,
      used_space: this.usedSpace,
      free_space: this.freeSpace,
      capabilities: this.capabilities,
    };
  }
}

export function createStorageBackend(account) {
  return new StorageBackend(account);
}

export { PROVIDER_CAPABILITIES };

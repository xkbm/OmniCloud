import { createStorageBackend } from './backend.js';

export const POOL_STRATEGIES = Object.freeze([
  'round_robin',
  'weighted_round_robin',
  'least_used',
  'most_free',
  'manual',
]);

export class StoragePool {
  constructor(accounts = [], config = {}) {
    this.strategy = POOL_STRATEGIES.includes(config.strategy) ? config.strategy : 'round_robin';
    this.order = Array.isArray(config.order) ? config.order.filter((id) => typeof id === 'string') : [];
    this.backends = accounts.map(createStorageBackend);
    this.backendById = new Map(this.backends.map((backend) => [backend.id, backend]));
    this.rrCursor = Number.isSafeInteger(Number(config.rrCursor)) && Number(config.rrCursor) >= 0
      ? Number(config.rrCursor)
      : 0;
  }

  get activeBackends() {
    return this.backends.filter((backend) => backend.healthy);
  }

  get capacity() {
    return this.activeBackends.reduce((sum, backend) => sum + backend.totalSpace, 0);
  }

  get used() {
    return this.activeBackends.reduce((sum, backend) => sum + backend.usedSpace, 0);
  }

  get free() {
    return Math.max(0, this.capacity - this.used);
  }

  get utilization() {
    return this.capacity > 0 ? this.used / this.capacity : 0;
  }

  getBackend(id) {
    return this.backendById.get(String(id)) || null;
  }

  listBackends() {
    const byId = new Map(this.backends.map((backend) => [backend.id, backend]));
    const ordered = [];
    for (const id of this.order) {
      const backend = byId.get(id);
      if (!backend) continue;
      ordered.push(backend);
      byId.delete(id);
    }
    ordered.push(...byId.values());
    return ordered;
  }

  chooseBackend(size = 0, options = {}) {
    const candidates = this.activeBackends.filter((backend) => backend.canStore(size));
    if (!candidates.length) return null;

    if (options.backendId) {
      const requested = this.getBackend(options.backendId);
      if (requested && candidates.includes(requested)) return requested;
    }

    switch (options.strategy || this.strategy) {
      case 'least_used':
        return candidates.reduce((best, backend) => {
          if (!best) return backend;
          const bestRatio = best.totalSpace > 0 ? best.usedSpace / best.totalSpace : 1;
          const ratio = backend.totalSpace > 0 ? backend.usedSpace / backend.totalSpace : 1;
          return ratio < bestRatio ? backend : best;
        }, null);
      case 'most_free':
        return candidates.reduce((best, backend) => (backend.freeSpace > best.freeSpace ? backend : best), candidates[0]);
      case 'manual':
        return candidates.find((backend) => this.order.includes(backend.id)) || candidates[0];
      case 'weighted_round_robin': {
        const weighted = candidates.flatMap((backend) => {
          const freeRatio = backend.totalSpace > 0 ? backend.freeSpace / backend.totalSpace : 0;
          const weight = Math.max(1, Math.round(freeRatio * 10));
          return Array.from({ length: weight }, () => backend);
        });
        return weighted[this.rrCursor % weighted.length];
      }
      case 'round_robin':
      default:
        return candidates[this.rrCursor % candidates.length];
    }
  }

  serialize() {
    return {
      strategy: this.strategy,
      capacity: this.capacity,
      used: this.used,
      free: this.free,
      utilization: this.utilization,
      backends: this.listBackends().map((backend) => backend.serialize()),
    };
  }
}

export function createStoragePool(accounts, config) {
  return new StoragePool(accounts, config);
}

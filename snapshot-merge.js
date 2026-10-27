(function (root, factory) {
  const mergeSnapshots = factory();
  if (typeof module === 'object' && module.exports) module.exports = mergeSnapshots;
  if (root) root.nourSnapshotMerge = mergeSnapshots;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const entityArrays = new Set([
    'products',
    'stockTransfers',
    'orders',
    'invoices',
    'returnsList',
    'damagedMonthlyItems',
    'mergeRecords',
    'returnHistory',
    'customers',
    'suppliers',
    'receipts',
    'inventoryMovements',
    'capitalExpenses'
  ]);

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function sameValue(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function entityKey(collection, value) {
    if (collection === 'inventoryLocations' || collection === 'inventoryWarehouses') {
      const name = typeof value === 'string' ? value : value?.name;
      return name ? `name:${String(name).trim().toLocaleLowerCase()}` : null;
    }
    if (collection === 'loginActivity' && value?.username && value?.action && value?.at) {
      return `login:${String(value.username).toLocaleLowerCase()}:${String(value.action)}:${String(value.at)}`;
    }
    if (collection === 'returnHistory' && value?.invoiceId && value?.date && value?.code) {
      return `return:${String(value.invoiceId)}:${String(value.date)}:${String(value.code)}:${String(value.size || '')}`;
    }
    if (collection === 'inventorySheet') {
      if (value?.code === undefined || value?.code === null) return null;
      return `stock:${String(value.code)}:${String(value.location || '').trim().toLocaleLowerCase()}`;
    }
    if (entityArrays.has(collection) && value?.id !== undefined && value?.id !== null) {
      return `id:${String(value.id)}`;
    }
    return null;
  }

  function toEntityMap(collection, values) {
    const result = new Map();
    for (const value of values) {
      const key = entityKey(collection, value);
      if (!key || result.has(key)) return null;
      result.set(key, value);
    }
    return result;
  }

  function mergeValues(base, local, remote, path, conflicts) {
    if (path === 'settings.lastTab') return local;
    if (path === 'settings.loginActivity') {
      return mergeEntityArray('loginActivity', base, local, remote, path, conflicts);
    }
    if (sameValue(local, base)) return remote;
    if (sameValue(remote, base)) return local;
    if (sameValue(local, remote)) return local;

    if (isRecord(base) && isRecord(local) && isRecord(remote)) {
      const merged = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
      for (const key of keys) {
        const value = mergeValues(base[key], local[key], remote[key], `${path}.${key}`, conflicts);
        if (value !== undefined) merged[key] = value;
      }
      return merged;
    }

    conflicts.push(path);
    return remote;
  }

  function mergeUnkeyedArray(base, local, remote, path, conflicts) {
    if (sameValue(local, base)) return remote;
    if (sameValue(remote, base) || sameValue(local, remote)) return local;
    conflicts.push(path);
    return remote;
  }

  function mergeEntityArray(collection, base, local, remote, path, conflicts) {
    if (![base, local, remote].every(Array.isArray)) {
      return mergeValues(base, local, remote, path, conflicts);
    }

    const baseMap = toEntityMap(collection, base);
    const localMap = toEntityMap(collection, local);
    const remoteMap = toEntityMap(collection, remote);
    if (!baseMap || !localMap || !remoteMap) {
      return mergeUnkeyedArray(base, local, remote, path, conflicts);
    }

    const merged = new Map();
    const keys = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
    for (const key of keys) {
      const hasBase = baseMap.has(key);
      const hasLocal = localMap.has(key);
      const hasRemote = remoteMap.has(key);

      if (!hasBase) {
        if (hasLocal && hasRemote) {
          const value = mergeValues(undefined, localMap.get(key), remoteMap.get(key), `${path}.${key}`, conflicts);
          if (value !== undefined) merged.set(key, value);
        } else if (hasLocal) {
          merged.set(key, localMap.get(key));
        } else if (hasRemote) {
          merged.set(key, remoteMap.get(key));
        }
        continue;
      }

      if (!hasLocal && !hasRemote) continue;
      if (!hasLocal) {
        if (sameValue(remoteMap.get(key), baseMap.get(key))) continue;
        conflicts.push(`${path}.${key}`);
        continue;
      }
      if (!hasRemote) {
        if (sameValue(localMap.get(key), baseMap.get(key))) continue;
        conflicts.push(`${path}.${key}`);
        continue;
      }

      const value = mergeValues(baseMap.get(key), localMap.get(key), remoteMap.get(key), `${path}.${key}`, conflicts);
      if (value !== undefined) merged.set(key, value);
    }

    const baseKeys = [...baseMap.keys()].filter(key => merged.has(key));
    const localKeys = [...localMap.keys()].filter(key => merged.has(key));
    const remoteKeys = [...remoteMap.keys()].filter(key => merged.has(key));
    const sameOrder = (left, right) => left.length === right.length && left.every((key, index) => key === right[index]);
    const localReordered = !sameOrder(localKeys.filter(key => baseMap.has(key)), baseKeys);
    const remoteReordered = !sameOrder(remoteKeys.filter(key => baseMap.has(key)), baseKeys);
    const localBaseOrder = localKeys.filter(key => baseMap.has(key));
    const remoteBaseOrder = remoteKeys.filter(key => baseMap.has(key));
    if (localReordered && remoteReordered && !sameOrder(localBaseOrder, remoteBaseOrder)) {
      conflicts.push(`${path}.$order`);
    }

    const baseSet = new Set(baseMap.keys());
    const localAdded = localKeys.filter(key => !baseSet.has(key));
    const remoteAdded = remoteKeys.filter(key => !baseSet.has(key) && !localAdded.includes(key));
    const baseOrder = localReordered && !remoteReordered ? localBaseOrder : remoteBaseOrder;
    const order = [...localAdded, ...remoteAdded, ...baseOrder];
    return order.map(key => merged.get(key));
  }

  function mergeSnapshots(base, local, remote) {
    const conflicts = [];
    const merged = {};
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(remote || {})]);

    for (const key of keys) {
      if (entityArrays.has(key) || key === 'inventorySheet' || key === 'inventoryLocations' || key === 'inventoryWarehouses') {
        const value = mergeEntityArray(key, base?.[key], local?.[key], remote?.[key], key, conflicts);
        if (value !== undefined) merged[key] = value;
      } else {
        const value = mergeValues(base?.[key], local?.[key], remote?.[key], key, conflicts);
        if (value !== undefined) merged[key] = value;
      }
    }

    return { snapshot: merged, conflicts: [...new Set(conflicts)] };
  }

  mergeSnapshots.equal = sameValue;
  return mergeSnapshots;
});

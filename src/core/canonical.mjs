// A deliberately small, versionable JSON contract. No coercion or user getters.
export function canonicalJson(value) {
  const active = new Set();
  function visit(item) {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON requires finite numbers');
      return JSON.stringify(item); // JSON represents -0 as 0.
    }
    if (typeof item !== 'object') throw new TypeError('Value is outside the strict JSON domain');
    if (active.has(item)) throw new TypeError('Canonical JSON cannot encode a cycle');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol keys are not JSON');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
      throw new TypeError('Accessors are not accepted');
    }
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const keys = Object.keys(descriptors).filter(key => key !== 'length');
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) {
          throw new TypeError('Arrays must be dense and cannot carry extra properties');
        }
        return '[' + keys.map(key => visit(descriptors[key].value)).join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Only plain JSON objects are accepted');
      const keys = Object.keys(descriptors).sort(); // UTF-16 order; no locale dependence.
      if (keys.some(key => !descriptors[key].enumerable)) throw new TypeError('Hidden properties are not JSON');
      return '{' + keys.map(key => JSON.stringify(key) + ':' + visit(descriptors[key].value)).join(',') + '}';
    } finally { active.delete(item); }
  }
  return visit(value);
}

export function freezeJson(value) {
  // Canonical validation happens before callers pass state or input to this helper.
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

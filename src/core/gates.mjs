// An in-memory acceptance gate, not an authorization or worker cancellation API.
export function createResultGate() {
  let sequence = 0, current = null;
  const increment = () => {
    if (sequence === Number.MAX_SAFE_INTEGER) throw new RangeError('Result gate counter exhausted');
    return ++sequence;
  };
  const valid = (revision, contextKey) => {
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof contextKey !== 'string') {
      throw new TypeError('A result ticket requires a nonnegative revision and a context key');
    }
  };
  return Object.freeze({
    issue(revision, contextKey) {
      valid(revision, contextKey);
      current = Object.freeze({sequence: increment(), revision, contextKey});
      return current;
    },
    accept(ticket, revision, contextKey) {
      valid(revision, contextKey);
      if (!current || !ticket || ticket.sequence !== current.sequence
          || ticket.revision !== current.revision || ticket.contextKey !== current.contextKey
          || revision !== current.revision || contextKey !== current.contextKey) return false;
      current = null;
      return true;
    },
    invalidate() { increment(); current = null; }
  });
}

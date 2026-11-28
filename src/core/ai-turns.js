// Recovery lives as long as the server session and its undo snapshots. Missing records
// are deliberately inconclusive: a disconnected client cannot infer whether a write ran.
export function createTurnRegistry(limit = 128) {
  const turns = new Map();
  function lookup(id, scope) {
    const turn = turns.get(id);
    if (!turn || turn.projectId !== scope.projectId || turn.sessionRevision !== scope.sessionRevision ||
        turn.threadId !== scope.threadId) return null;
    return turn;
  }
  function canRetry(turn) {
    return Boolean(turn?.settled && !turn.writeStarted && !turn.retried);
  }
  function begin(id, scope, mode, retryOf) {
    if (typeof id !== 'string' || !/^[\w-]{12,80}$/.test(id) || turns.has(id)) return null;
    const prior = retryOf && lookup(retryOf, scope);
    if (retryOf && (!canRetry(prior) || prior.mode !== mode)) return null;
    const turn = { ...scope, mode, settled: false, writeStarted: false };
    if (prior) prior.retried = true;
    turns.set(id, turn);
    // Active turns must stay queryable until their executor has actually stopped.
    for (const [key, entry] of turns) {
      if (turns.size <= limit) break;
      if (entry.settled) turns.delete(key);
    }
    return turn;
  }
  return { begin, lookup, canRetry };
}

// ============================================================
// NexusHome OS — lógica pura das regras IFTTT (sem DOM/estado)
// Espelha o trigger do Postgres (migração 007): a mesma
// comparação e o mesmo edge-trigger valem no navegador (demo e
// regras SmartThings) e no servidor.
// ============================================================

export function compare(v, op, th) {
  switch (op) {
    case '>': return v > th;
    case '>=': return v >= th;
    case '<': return v < th;
    case '<=': return v <= th;
    case '==': return v === th;
    default: return false;
  }
}

/**
 * Edge trigger: dispara só quando a condição vale agora e NÃO valia na
 * leitura anterior (prev === undefined = primeira leitura, dispara).
 */
export function crossesThreshold(prev, cur, op, th) {
  if (!compare(cur, op, th)) return false;
  return prev === undefined || !compare(prev, op, th);
}

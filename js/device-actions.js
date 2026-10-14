// ============================================================
// NexusHome OS — Ações por tipo de dispositivo (v2.13)
// ------------------------------------------------------------
// Lógica pura (testável com `npm test`): quais ações cada tipo aceita nas
// automações, o patch de status de cada ação (o mesmo que o servidor aplica —
// supabase/migrations/024_device_library.sql) e o texto para o usuário.
// ============================================================

import { SOURCES } from './device-catalog.js';

export const ARMED_LABEL = { off: 'Desarmado', home: 'Armado em casa', away: 'Armado ausente' };
export const VACUUM_LABEL = { cleaning: 'Limpando', docked: 'Na base' };

/** Tipos com liga/desliga ("on") no app e nas cenas. */
const POWER_TYPES = new Set(['light', 'ac', 'tv', 'audio', 'projector', 'media', 'computer', 'appliance', 'fan', 'plug', 'switch', 'speaker']);

/** Ações de automação que o dispositivo aceita. */
export function actionsFor(dev) {
  const type = dev?.type;
  const power = { v: 'power', label: 'Ligar / desligar' };
  switch (type) {
    case 'light': return [power, { v: 'brightness', label: 'Definir brilho (%)' }, { v: 'color', label: 'Definir cor' }];
    case 'ac': return [power, { v: 'temp', label: 'Definir temperatura (°C)' }];
    case 'valve': return [{ v: 'valve', label: 'Abrir / fechar' }];
    case 'tv': case 'audio': return [power, { v: 'volume', label: 'Definir volume (%)' }, { v: 'source', label: 'Trocar entrada' }];
    case 'projector': case 'media': return [power, { v: 'source', label: 'Trocar entrada' }];
    case 'alarm': return [{ v: 'armed', label: 'Armar / desarmar' }];
    case 'gate': case 'curtain': return [{ v: 'open', label: 'Abrir / fechar' }];
    case 'vacuum': return [{ v: 'vacuum', label: 'Iniciar limpeza / voltar à base' }];
    default:
      // circuito do quadro elétrico com relé (v2.11) e outros aparelhos com "on"
      return POWER_TYPES.has(type) || typeof dev?.status?.on === 'boolean' ? [power] : [];
  }
}

/** Opções de valor de uma ação (select) — ou null para campo numérico/cor. */
export function actionChoices(action, dev) {
  switch (action) {
    case 'power': return [['true', 'Ligar'], ['false', 'Desligar']];
    case 'valve': return [['true', 'Abrir'], ['false', 'Fechar']];
    case 'open': return [['true', 'Abrir'], ['false', 'Fechar']];
    case 'armed': return Object.entries(ARMED_LABEL);
    case 'vacuum': return [['cleaning', 'Iniciar limpeza'], ['docked', 'Voltar à base']];
    case 'source': return (SOURCES[dev?.type] || SOURCES.media).map((s) => [s, s]);
    default: return null;
  }
}

/** Patch de status de uma ação (null = ação desconhecida ou valor inválido). */
export function actionPatch(action, value) {
  switch (action) {
    case 'power': return { on: value === true || value === 'true' };
    case 'valve': case 'open': return { open: value === true || value === 'true' };
    case 'temp': return Number.isFinite(Number(value)) ? { temp: Number(value) } : null;
    case 'brightness': return Number.isFinite(Number(value)) ? { brightness: Number(value) } : null;
    case 'color': return { color: String(value) };
    case 'volume': return Number.isFinite(Number(value)) ? { volume: Math.max(0, Math.min(100, Number(value))) } : null;
    case 'source': return value ? { source: String(value) } : null;
    case 'armed': return ARMED_LABEL[value] ? { armed: value } : null;
    case 'vacuum': return VACUUM_LABEL[value] ? { state: value } : null;
    default: return null;
  }
}

/** Texto da ação ("ligar Soundbar", "armar Alarme (ausente)"). */
export function describeAction(name, action, value) {
  const on = value === true || value === 'true';
  switch (action) {
    case 'power': return `${on ? 'ligar' : 'desligar'} ${name}`;
    case 'valve': case 'open': return `${on ? 'abrir' : 'fechar'} ${name}`;
    case 'temp': return `ajustar ${name} para ${value}°C`;
    case 'brightness': return `brilho de ${name} em ${value}%`;
    case 'color': return `cor de ${name} para ${value}`;
    case 'volume': return `volume de ${name} em ${value}%`;
    case 'source': return `${name} na entrada ${value}`;
    case 'armed': return value === 'off' ? `desarmar ${name}` : `armar ${name} (${value === 'home' ? 'em casa' : 'ausente'})`;
    case 'vacuum': return value === 'cleaning' ? `iniciar limpeza: ${name}` : `${name} volta à base`;
    default: return `acionar ${name}`;
  }
}

/** Tem botão de liga/desliga rápido (cartão do cômodo)? */
export function isSwitchable(d) {
  if (!d) return false;
  if (d.type === 'valve' || d.type === 'gate') return true;
  return POWER_TYPES.has(d.type) || typeof d.status?.on === 'boolean';
}

/** O dispositivo está "ativo" (ligado, aberto, armado, limpando)? */
export function isActive(d) {
  if (!d) return false;
  const s = d.status || {};
  if (d.type === 'valve') return s.open !== false;
  if (d.type === 'gate') return s.open === true;
  if (d.type === 'alarm') return !!s.armed && s.armed !== 'off';
  if (d.type === 'vacuum') return s.state === 'cleaning';
  return !!s.on;
}

/** Patch do botão rápido (inverte o estado). */
export function togglePatch(d) {
  const next = !isActive(d);
  if (d.type === 'valve' || d.type === 'gate') return { open: next };
  return { on: next };
}

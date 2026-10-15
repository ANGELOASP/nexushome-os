// Lógica pura das telas de parede (v2.16), testável com `npm test`.
//
// GET  /iot-gateway/panel?room=Cozinha&limit=80   → resumo compacto da casa para as telas
//        (monitor ESP32-P4 de 10,1" do corredor e telas de 7" dos cômodos)
// POST /iot-gateway/panel/command {device_id, action, value}  → aciona um aparelho
//        (mesmas ações do app — js/device-actions.js — e do run_automations da 024)
//
// O ESP32 tem pouca memória para JSON: as chaves são curtas e só vai o que a tela mostra.

export type Device = {
  id: string; name: string; type: string; room: string | null;
  status: Record<string, unknown> | null; is_online: boolean | null;
};
export type Alert = { severity: string; message: string; created_at: string; resolved?: boolean | null };

export type PanelDevice = {
  id: string; n: string; r: string; t: string; ok: boolean;
  on?: boolean; open?: boolean; w?: number; lvl?: number; soc?: number; temp?: number; bri?: number;
  arm?: string; alarm?: boolean; lock?: boolean; act: string[];
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const round = (v: number | undefined, d = 0) => (v === undefined ? undefined : Math.round(v * 10 ** d) / 10 ** d);

/** Ações que a tela oferece para cada aparelho (subconjunto de actionsFor do app). */
export function panelActions(d: Pick<Device, "type" | "status">): string[] {
  const s = d.status ?? {};
  switch (d.type) {
    case "light": return ["power", "brightness"];
    case "ac": return ["power", "temp"];
    case "valve": return ["valve"];
    case "gate": case "curtain": return ["open"];
    case "alarm": return ["armed"];
    default:
      return typeof s.on === "boolean" ? ["power"] : [];
  }
}

/** Patch de status de uma ação — o mesmo de actionPatch (js/device-actions.js). */
export function panelPatch(action: string, value: unknown): Record<string, unknown> | null {
  const yes = value === true || value === "true" || value === 1 || value === "1";
  switch (action) {
    case "power": return { on: yes };
    case "valve": case "open": return { open: yes };
    case "temp": {
      const t = Number(value);
      return Number.isFinite(t) && t >= 16 && t <= 30 ? { temp: Math.round(t) } : null;
    }
    case "brightness": {
      const b = Number(value);
      return Number.isFinite(b) ? { brightness: Math.max(1, Math.min(100, Math.round(b))) } : null;
    }
    case "armed": return ["off", "home", "away"].includes(String(value)) ? { armed: String(value) } : null;
    default: return null;
  }
}

/** Algum alarme ativo no status do aparelho (rompimento, pânico, sobrecarga, alarme disparado...). */
export function deviceAlarm(s: Record<string, unknown>): boolean {
  return ["alarm_burst", "alarm_external", "panic", "trip", "triggered", "leak", "smoke", "gas", "grid_fail"]
    .some((k) => s[k] === true);
}

export function toPanelDevice(d: Device): PanelDevice {
  const s = d.status ?? {};
  const out: PanelDevice = {
    id: d.id, n: d.name, r: d.room ?? "", t: d.type, ok: d.is_online !== false,
    act: panelActions(d),
  };
  const on = bool(s.on); if (on !== undefined) out.on = on;
  const open = bool(s.open); if (open !== undefined) out.open = open;
  const w = round(num(s.watts)); if (w !== undefined) out.w = w;
  const lvl = round(num(s.level_pct)); if (lvl !== undefined) out.lvl = lvl;
  const soc = round(num(s.soc)); if (soc !== undefined) out.soc = soc;
  const temp = round(num(s.temp) ?? num(s.temperature), 1); if (temp !== undefined) out.temp = temp;
  const bri = round(num(s.brightness)); if (bri !== undefined) out.bri = bri;
  if (typeof s.armed === "string") out.arm = s.armed;
  if (deviceAlarm(s)) out.alarm = true;
  if (s.trip === true || s.alarm_burst === true || s.panic === true) out.lock = true;
  return out;
}

/** Resumo da casa: energia, água, reservatório, bateria e saúde (mesmas regras do app). */
export function houseSummary(devices: Device[], alerts: Alert[]) {
  const st = (d: Device) => d.status ?? {};
  // energia: o total do quadro (in_total:false com watts) manda; senão soma os medidores
  const meters = devices.filter((d) => d.type === "meter" && num(st(d).watts) !== undefined);
  const board = meters.find((d) => st(d).in_total === false);
  const watts = board ? num(st(board).watts)! : meters.reduce((a, d) => a + num(st(d).watts)!, 0);
  const water = devices.reduce((a, d) => a + (num(st(d).flow_lph) ?? 0), 0);
  const level = devices.map((d) => num(st(d).level_pct)).find((v) => v !== undefined);
  const bat = devices.find((d) => num(st(d).soc) !== undefined);
  const open = alerts.filter((a) => !a.resolved);
  const crit = open.some((a) => a.severity === "critical") || devices.some((d) => deviceAlarm(st(d)));
  const warn = open.some((a) => a.severity === "warning");
  return {
    watts: Math.round(watts),
    water_lph: Math.round(water),
    level_pct: level === undefined ? null : Math.round(level),
    soc: bat ? Math.round(num(st(bat).soc)!) : null,
    grid_ok: bat ? st(bat).grid_fail !== true : null,
    alerts_open: open.length,
    health: crit ? "critical" : warn ? "warning" : "safe",
  };
}

/** Snapshot das telas. `room` filtra os aparelhos (o resumo da casa vem sempre). */
export function buildSnapshot(devices: Device[], alerts: Alert[], opts: { room?: string; limit?: number; now?: Date } = {}) {
  const limit = Math.max(1, Math.min(150, opts.limit ?? 80));
  const room = (opts.room ?? "").trim().toLowerCase();
  const rooms = [...new Set(devices.map((d) => d.room ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  // medidores de circuito sem relé não têm o que acionar na parede: ficam só no resumo
  const shown = devices
    .filter((d) => !room || (d.room ?? "").toLowerCase() === room)
    .filter((d) => !(d.type === "meter" && typeof d.status?.on !== "boolean"))
    .sort((a, b) => (a.room ?? "").localeCompare(b.room ?? "", "pt-BR") || a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, limit)
    .map(toPanelDevice);
  return {
    v: 1,
    t: (opts.now ?? new Date()).toISOString(),
    house: houseSummary(devices, alerts),
    rooms,
    devices: shown,
    alerts: alerts.filter((a) => !a.resolved).slice(0, 5)
      .map((a) => ({ sev: a.severity, msg: a.message.slice(0, 120), at: a.created_at })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida um comando da tela. Devolve o patch ou o motivo da recusa. */
export function validateCommand(body: unknown, device: Device | null): { patch?: Record<string, unknown>; error?: string; status?: number } {
  if (!body || typeof body !== "object") return { error: "JSON inválido", status: 400 };
  const b = body as Record<string, unknown>;
  if (!UUID.test(String(b.device_id ?? ""))) return { error: "device_id inválido", status: 400 };
  if (!device) return { error: "aparelho não encontrado", status: 404 };
  const action = String(b.action ?? "");
  if (!panelActions(device).includes(action)) return { error: `ação "${action}" não disponível para ${device.type}`, status: 422 };
  const patch = panelPatch(action, b.value);
  if (!patch) return { error: "valor inválido", status: 422 };
  return { patch };
}

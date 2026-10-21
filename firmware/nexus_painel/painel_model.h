// ============================================================
// NexusHome OS — Painel de parede: modelo de dados (v2.16)
// ------------------------------------------------------------
// Lógica pura, sem Arduino nem LVGL (testável no PC com g++):
//   · lê o resumo de GET /iot-gateway/panel (supabase/functions/iot-gateway/panel.ts)
//   · decide o comando de um toque (POST /iot-gateway/panel/command)
//   · formata os números para a tela (vírgula decimal, kW/W, L/h)
// ============================================================
#pragma once
#include <ArduinoJson.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#ifndef PANEL_MAX_DEVS
#define PANEL_MAX_DEVS   96
#endif
#define PANEL_MAX_ROOMS  20
#define PANEL_MAX_ALERTS 5

// ações aceitas pelo servidor (panelActions)
enum : uint8_t { ACT_POWER = 1, ACT_BRI = 2, ACT_TEMP = 4, ACT_VALVE = 8, ACT_OPEN = 16, ACT_ARMED = 32 };
enum : uint8_t { HEALTH_SAFE = 0, HEALTH_WARN = 1, HEALTH_CRIT = 2 };

struct PDev {
  char    id[37];
  char    name[48];
  char    room[32];
  char    type[12];
  bool    ok;          // online
  int8_t  on;          // -1 = sem liga/desliga
  int8_t  open;        // -1 = não se aplica
  float   w;           // watts (NAN = sem medida)
  int16_t lvl;         // % nível (-1)
  int16_t soc;         // % bateria (-1)
  float   temp;        // °C (NAN)
  int16_t bri;         // % brilho (-1)
  int16_t gas;         // % LEL do transmissor de gás (-1)
  char    arm[6];      // off|home|away ("" = não é alarme)
  bool    alarm;       // algum alarme ativo no aparelho
  bool    lock;        // travado (rompimento, sobrecarga...): o painel não reabre
  uint8_t acts;        // ACT_*
};

struct PHouse {
  int32_t watts, water;
  int16_t level, soc;  // -1 = sem dado
  int8_t  gridOk;      // -1 = sem nobreak, 0 = falta de energia, 1 = rede ok
  int16_t alertsOpen;
  uint8_t health;      // HEALTH_*
};

struct PAlert { uint8_t sev; char msg[124]; };

struct PModel {
  bool     valid;
  char     t[26];
  char     ps[12];                    // assinatura da planta (só com ?plan=); "" = não veio
  PHouse   h;
  uint8_t  nRooms;
  char     rooms[PANEL_MAX_ROOMS][32];
  uint8_t  nDevs;
  PDev     devs[PANEL_MAX_DEVS];
  uint8_t  nAlerts;
  PAlert   alerts[PANEL_MAX_ALERTS];
};

static inline void pm_copy(char* dst, size_t n, const char* src) {
  if (!src) src = "";
  strncpy(dst, src, n - 1);
  dst[n - 1] = 0;
}

static inline uint8_t pm_actions(JsonArrayConst a) {
  uint8_t m = 0;
  for (JsonVariantConst v : a) {
    const char* s = v.as<const char*>();
    if (!s) continue;
    if (!strcmp(s, "power")) m |= ACT_POWER;
    else if (!strcmp(s, "brightness")) m |= ACT_BRI;
    else if (!strcmp(s, "temp")) m |= ACT_TEMP;
    else if (!strcmp(s, "valve")) m |= ACT_VALVE;
    else if (!strcmp(s, "open")) m |= ACT_OPEN;
    else if (!strcmp(s, "armed")) m |= ACT_ARMED;
  }
  return m;
}

static inline uint8_t pm_health(const char* s) {
  if (s && !strcmp(s, "critical")) return HEALTH_CRIT;
  if (s && !strcmp(s, "warning")) return HEALTH_WARN;
  return HEALTH_SAFE;
}

/** Lê o JSON do /panel. Devolve false (e não mexe em m) se o JSON for inválido. */
static inline bool pm_parse(const char* json, size_t len, PModel& m) {
  JsonDocument doc;
  if (deserializeJson(doc, json, len)) return false;
  if ((doc["v"] | 0) != 1) return false;
  JsonObjectConst h = doc["house"];
  m.h.watts = h["watts"] | 0;
  m.h.water = h["water_lph"] | 0;
  m.h.level = h["level_pct"].isNull() ? -1 : (int16_t)(h["level_pct"] | 0);
  m.h.soc = h["soc"].isNull() ? -1 : (int16_t)(h["soc"] | 0);
  m.h.gridOk = h["grid_ok"].isNull() ? -1 : ((h["grid_ok"] | true) ? 1 : 0);
  m.h.alertsOpen = h["alerts_open"] | 0;
  m.h.health = pm_health(h["health"] | "safe");
  pm_copy(m.t, sizeof(m.t), doc["t"] | "");
  pm_copy(m.ps, sizeof(m.ps), doc["ps"] | "");

  m.nRooms = 0;
  for (JsonVariantConst r : doc["rooms"].as<JsonArrayConst>()) {
    if (m.nRooms >= PANEL_MAX_ROOMS) break;
    pm_copy(m.rooms[m.nRooms++], 32, r.as<const char*>());
  }
  m.nDevs = 0;
  for (JsonObjectConst d : doc["devices"].as<JsonArrayConst>()) {
    if (m.nDevs >= PANEL_MAX_DEVS) break;
    PDev& x = m.devs[m.nDevs++];
    pm_copy(x.id, sizeof(x.id), d["id"] | "");
    pm_copy(x.name, sizeof(x.name), d["n"] | "");
    pm_copy(x.room, sizeof(x.room), d["r"] | "");
    pm_copy(x.type, sizeof(x.type), d["t"] | "");
    x.ok = d["ok"] | true;
    x.on = d["on"].isNull() ? -1 : ((d["on"] | false) ? 1 : 0);
    x.open = d["open"].isNull() ? -1 : ((d["open"] | false) ? 1 : 0);
    x.w = d["w"].isNull() ? NAN : (float)(d["w"] | 0.0);
    x.lvl = d["lvl"].isNull() ? -1 : (int16_t)(d["lvl"] | 0);
    x.soc = d["soc"].isNull() ? -1 : (int16_t)(d["soc"] | 0);
    x.temp = d["temp"].isNull() ? NAN : (float)(d["temp"] | 0.0);
    x.bri = d["bri"].isNull() ? -1 : (int16_t)(d["bri"] | 0);
    x.gas = d["gas"].isNull() ? -1 : (int16_t)(d["gas"] | 0);
    pm_copy(x.arm, sizeof(x.arm), d["arm"] | "");
    x.alarm = d["alarm"] | false;
    x.lock = d["lock"] | false;
    x.acts = pm_actions(d["act"].as<JsonArrayConst>());
  }
  m.nAlerts = 0;
  for (JsonObjectConst a : doc["alerts"].as<JsonArrayConst>()) {
    if (m.nAlerts >= PANEL_MAX_ALERTS) break;
    PAlert& x = m.alerts[m.nAlerts++];
    x.sev = pm_health(a["sev"] | "info");
    pm_copy(x.msg, sizeof(x.msg), a["msg"] | "");
  }
  m.valid = true;
  return true;
}

/** O aparelho está "ativo" (aceso, ligado, aberto)? Usado na cor do quadro. */
static inline bool pm_active(const PDev& d) {
  if (d.on >= 0) return d.on == 1;
  if (!strcmp(d.type, "valve") || !strcmp(d.type, "gate") || !strcmp(d.type, "curtain")) return d.open == 1;
  if (d.arm[0]) return strcmp(d.arm, "off") != 0;
  return false;
}

/**
 * Comando de um toque no quadro: alterna liga/desliga ou abre/fecha.
 * Devolve false se o toque não faz nada (sensor, alarme — que tem botões próprios).
 * `needsConfirm` = pede confirmação antes (fechar água, cortar circuito, abrir portão).
 */
static inline bool pm_tap_command(const PDev& d, char* action, size_t an, char* value, size_t vn, bool* needsConfirm) {
  *needsConfirm = false;
  if (d.acts & ACT_POWER) {
    if (d.lock && d.on != 1) return false;             // desarmado por sobrecarga: só rearma no quadro
    pm_copy(action, an, "power");
    pm_copy(value, vn, d.on == 1 ? "false" : "true");
    *needsConfirm = !strcmp(d.type, "meter");          // circuito do quadro elétrico
    return true;
  }
  if (d.acts & (ACT_VALVE | ACT_OPEN)) {
    if (d.lock && d.open != 1) return false;           // travado por alarme: só no quadro
    pm_copy(action, an, (d.acts & ACT_VALVE) ? "valve" : "open");
    pm_copy(value, vn, d.open == 1 ? "false" : "true");
    *needsConfirm = true;
    return true;
  }
  return false;
}

/** Pedido de comando pronto (id + ação + valor), montado quando o toque/janela abre. */
struct PCmd { char id[37]; char action[12]; char value[12]; };

static inline void pm_cmd_set(PCmd &c, const char *id, const char *action, const char *value) {
  pm_copy(c.id, sizeof(c.id), id);
  pm_copy(c.action, sizeof(c.action), action);
  pm_copy(c.value, sizeof(c.value), value);
}

/** Comando de um toque já montado (id do aparelho + ação + valor calculados AGORA). */
static inline bool pm_tap_cmd(const PDev &d, PCmd &c, bool *needsConfirm) {
  char a[sizeof(c.action)], v[sizeof(c.value)];
  if (!pm_tap_command(d, a, sizeof(a), v, sizeof(v), needsConfirm)) return false;
  pm_cmd_set(c, d.id, a, v);
  return true;
}

/** Índice do aparelho com este id no snapshot (ou -1: sumiu da lista). */
static inline int pm_find_dev(const PModel &m, const char *id) {
  if (!id || !id[0]) return -1;
  for (int i = 0; i < m.nDevs; i++) if (!strcmp(m.devs[i].id, id)) return i;
  return -1;
}

/**
 * Confirmação de uma janela (modal) aberta antes do snapshot atual: acha o aparelho PELO ID
 * (a lista é recarregada a cada 3 s e a ordem muda). Devolve o índice ou -1 se o comando não
 * deve sair: o aparelho sumiu, ou travou (sobrecarga/rompimento) e o pedido era ligar/abrir.
 */
static inline int pm_cmd_target(const PModel &m, const PCmd &c) {
  int i = pm_find_dev(m, c.id);
  if (i < 0) return -1;
  const PDev &d = m.devs[i];
  bool turnsOn = !strcmp(c.value, "true");
  if (d.lock && turnsOn && (!strcmp(c.action, "power") || !strcmp(c.action, "valve") || !strcmp(c.action, "open"))) return -1;
  return i;
}

/** Corpo JSON do POST /panel/command. */
static inline int pm_command_body(char* out, size_t n, const char* id, const char* action, const char* value) {
  bool literal = !strcmp(value, "true") || !strcmp(value, "false") || (value[0] && strspn(value, "0123456789.-") == strlen(value));
  return snprintf(out, n, literal ? "{\"device_id\":\"%s\",\"action\":\"%s\",\"value\":%s}"
                                  : "{\"device_id\":\"%s\",\"action\":\"%s\",\"value\":\"%s\"}", id, action, value);
}

/** "1,2 kW" / "850 W" */
static inline void pm_fmt_watts(char* out, size_t n, float w) {
  if (isnan(w)) { pm_copy(out, n, "—"); return; }
  if (fabsf(w) >= 1000.0f) {
    int dec = (int)lroundf(w / 100.0f);       // décimos de kW
    snprintf(out, n, "%d,%d kW", dec / 10, abs(dec % 10));
  } else {
    snprintf(out, n, "%d W", (int)lroundf(w));
  }
}

/** "24,5°C" */
static inline void pm_fmt_temp(char* out, size_t n, float t) {
  if (isnan(t)) { pm_copy(out, n, "—"); return; }
  int d = (int)lroundf(t * 10.0f);
  snprintf(out, n, "%s%d,%d°C", d < 0 ? "-" : "", abs(d) / 10, abs(d) % 10);
}

/** Texto do estado de um aparelho no quadro ("Acesa", "Aberta", "1,2 kW"...). */
static inline void pm_state_text(const PDev& d, char* out, size_t n) {
  char w[16];
  if (!d.ok) { pm_copy(out, n, "offline"); return; }
  if (d.lock) { pm_copy(out, n, "TRAVADO"); return; }
  if (d.alarm) { pm_copy(out, n, "ALARME"); return; }
  if (d.arm[0]) {
    pm_copy(out, n, !strcmp(d.arm, "away") ? "Armado (ausente)" : !strcmp(d.arm, "home") ? "Armado (em casa)" : "Desarmado");
    return;
  }
  if (!strcmp(d.type, "light")) {
    if (d.on == 1 && d.bri >= 0) snprintf(out, n, "Acesa · %d%%", d.bri);
    else pm_copy(out, n, d.on == 1 ? "Acesa" : "Apagada");
    return;
  }
  if (!strcmp(d.type, "ac")) {
    char t[16]; pm_fmt_temp(t, sizeof(t), d.temp);
    if (d.on == 1) snprintf(out, n, "Ligado · %s", t); else pm_copy(out, n, "Desligado");
    return;
  }
  if (d.open >= 0) { pm_copy(out, n, d.open ? "Aberta" : "Fechada"); return; }
  if (d.gas >= 0) { snprintf(out, n, "Gás %d%% LEL", d.gas); return; }
  if (d.soc >= 0) { snprintf(out, n, "Bateria %d%%", d.soc); return; }
  if (d.lvl >= 0) { snprintf(out, n, "Nível %d%%", d.lvl); return; }
  if (!isnan(d.w) && d.on >= 0) { pm_fmt_watts(w, sizeof(w), d.w); snprintf(out, n, "%s · %s", d.on ? "Ligado" : "Desligado", w); return; }
  if (d.on >= 0) { pm_copy(out, n, d.on ? "Ligado" : "Desligado"); return; }
  if (!isnan(d.temp)) { pm_fmt_temp(out, n, d.temp); return; }
  if (!isnan(d.w)) { pm_fmt_watts(out, n, d.w); return; }
  pm_copy(out, n, "monitorado");
}

/** Codifica o nome do cômodo para a URL (UTF-8 → %XX). */
static inline void pm_urlencode(char* out, size_t n, const char* s) {
  static const char* hex = "0123456789ABCDEF";
  size_t o = 0;
  for (; *s && o + 4 < n; s++) {
    unsigned char c = (unsigned char)*s;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') out[o++] = c;
    else { out[o++] = '%'; out[o++] = hex[c >> 4]; out[o++] = hex[c & 15]; }
  }
  out[o] = 0;
}

// ============================================================
// Planta (v2.16): GET /iot-gateway/panel/plan — a mesma do app
// (supabase/functions/iot-gateway/plan.ts). Coordenadas em metros.
// ============================================================
#define PLAN_MAX_ROOMS  24
#define PLAN_MAX_PTS    40
#define PLAN_MAX_WALLS  260
#define PLAN_MAX_DEVS   PANEL_MAX_DEVS

struct PRoom { char name[32]; uint32_t color; uint8_t n; float x[PLAN_MAX_PTS], z[PLAN_MAX_PTS]; float cx, cz; };
struct PDevPos { char id[37]; float x, z; };
struct PPlan {
  bool valid;
  char sig[12];                       // assinatura (igual ao `ps` do /panel enquanto a planta não muda)
  float minX, minZ, maxX, maxZ;
  uint8_t nRooms;  PRoom rooms[PLAN_MAX_ROOMS];
  uint16_t nWalls; float walls[PLAN_MAX_WALLS][4];
  uint8_t nDevs;   PDevPos devs[PLAN_MAX_DEVS];
};

static inline uint32_t pm_hex_color(const char *s) {
  if (!s || s[0] != '#') return 0x64748B;
  return (uint32_t)strtoul(s + 1, nullptr, 16) & 0xFFFFFF;
}

/** A planta do app mudou? (o /panel trouxe uma assinatura diferente da planta desenhada) */
static inline bool pm_plan_changed(const PModel &m, const PPlan &p) {
  return m.ps[0] && strcmp(m.ps, p.sig) != 0;
}

static inline bool pm_parse_plan(const char *json, size_t len, PPlan &p) {
  JsonDocument doc;
  if (deserializeJson(doc, json, len)) return false;
  if ((doc["v"] | 0) != 1) return false;
  JsonArrayConst bb = doc["bbox"];
  p.minX = bb[0] | 0.0f; p.minZ = bb[1] | 0.0f; p.maxX = bb[2] | 1.0f; p.maxZ = bb[3] | 1.0f;
  if (p.maxX - p.minX < 0.1f) p.maxX = p.minX + 1;
  if (p.maxZ - p.minZ < 0.1f) p.maxZ = p.minZ + 1;
  pm_copy(p.sig, sizeof(p.sig), doc["sig"] | "");
  p.nRooms = 0;
  for (JsonObjectConst r : doc["rooms"].as<JsonArrayConst>()) {
    if (p.nRooms >= PLAN_MAX_ROOMS) break;
    PRoom &x = p.rooms[p.nRooms];
    pm_copy(x.name, sizeof(x.name), r["n"] | "");
    x.color = pm_hex_color(r["c"] | "#64748b");
    x.n = 0; x.cx = x.cz = 0;
    for (JsonArrayConst pt : r["p"].as<JsonArrayConst>()) {
      if (x.n >= PLAN_MAX_PTS) break;
      x.x[x.n] = pt[0] | 0.0f; x.z[x.n] = pt[1] | 0.0f;
      x.cx += x.x[x.n]; x.cz += x.z[x.n]; x.n++;
    }
    if (x.n < 3) continue;                       // polígono inválido: ignora
    x.cx /= x.n; x.cz /= x.n;
    p.nRooms++;
  }
  p.nWalls = 0;
  for (JsonArrayConst w : doc["walls"].as<JsonArrayConst>()) {
    if (p.nWalls >= PLAN_MAX_WALLS) break;
    for (int k = 0; k < 4; k++) p.walls[p.nWalls][k] = w[k] | 0.0f;
    p.nWalls++;
  }
  p.nDevs = 0;
  for (JsonObjectConst d : doc["devs"].as<JsonArrayConst>()) {
    if (p.nDevs >= PLAN_MAX_DEVS) break;
    PDevPos &x = p.devs[p.nDevs++];
    pm_copy(x.id, sizeof(x.id), d["id"] | "");
    x.x = d["x"] | 0.0f; x.z = d["z"] | 0.0f;
  }
  p.valid = true;
  return true;
}

// ---- encaixe da planta na área da tela (escala, margem e giro de 90° se couber melhor) ----
struct PFit { float s, ox, oy; bool rot; float minX, minZ, maxX, maxZ; };

static inline PFit pm_plan_fit(const PPlan &p, int w, int h, int margin) {
  PFit f; f.minX = p.minX; f.minZ = p.minZ; f.maxX = p.maxX; f.maxZ = p.maxZ;
  float dx = p.maxX - p.minX, dz = p.maxZ - p.minZ;
  float aw = (float)(w - 2 * margin), ah = (float)(h - 2 * margin);
  float sN = fminf(aw / dx, ah / dz);          // sem giro: x → direita, z → baixo
  float sR = fminf(aw / dz, ah / dx);          // girada: z → direita, x → cima
  f.rot = sR > sN * 1.05f;
  f.s = f.rot ? sR : sN;
  float pw = (f.rot ? dz : dx) * f.s, ph = (f.rot ? dx : dz) * f.s;
  f.ox = margin + (aw - pw) / 2; f.oy = margin + (ah - ph) / 2;
  return f;
}

static inline void pm_plan_px(const PFit &f, float x, float z, int *px, int *py) {
  float u, v;
  if (f.rot) { u = (z - f.minZ) * f.s; v = (f.maxX - x) * f.s; }
  else       { u = (x - f.minX) * f.s; v = (z - f.minZ) * f.s; }
  *px = (int)lroundf(f.ox + u); *py = (int)lroundf(f.oy + v);
}

static inline void pm_plan_world(const PFit &f, int px, int py, float *x, float *z) {
  float u = (px - f.ox) / f.s, v = (py - f.oy) / f.s;
  if (f.rot) { *z = f.minZ + u; *x = f.maxX - v; }
  else       { *x = f.minX + u; *z = f.minZ + v; }
}

/** Ponto dentro do polígono (regra par-ímpar). */
static inline bool pm_point_in_room(const PRoom &r, float x, float z) {
  bool in = false;
  for (int i = 0, j = r.n - 1; i < r.n; j = i++) {
    if (((r.z[i] > z) != (r.z[j] > z)) && (x < (r.x[j] - r.x[i]) * (z - r.z[i]) / (r.z[j] - r.z[i]) + r.x[i])) in = !in;
  }
  return in;
}

/** Cômodo sob o toque (pixel da área da planta) ou -1. */
static inline int pm_plan_room_at(const PPlan &p, const PFit &f, int px, int py) {
  float x, z; pm_plan_world(f, px, py, &x, &z);
  for (int i = 0; i < p.nRooms; i++) if (pm_point_in_room(p.rooms[i], x, z)) return i;
  return -1;
}

/**
 * Triangulação por "orelhas" (os cômodos não são convexos e o LVGL 8 só preenche
 * polígonos convexos). Devolve o número de triângulos; tri = índices de 3 em 3.
 */
static inline int pm_triangulate(const float *x, const float *z, int n, uint8_t *tri, int maxTri) {
  if (n < 3) return 0;
  uint8_t idx[PLAN_MAX_PTS]; int m = n;
  float area = 0;
  for (int i = 0, j = n - 1; i < n; j = i++) area += x[j] * z[i] - x[i] * z[j];
  for (int i = 0; i < n; i++) idx[i] = (uint8_t)(area > 0 ? i : n - 1 - i);   // sempre anti-horário
  int nt = 0, guard = 0;
  while (m > 3 && nt < maxTri && guard++ < 4 * n * n) {
    bool cut = false;
    for (int k = 0; k < m; k++) {
      int a = idx[(k + m - 1) % m], b = idx[k], c = idx[(k + 1) % m];
      float cr = (x[b] - x[a]) * (z[c] - z[a]) - (z[b] - z[a]) * (x[c] - x[a]);
      if (cr <= 1e-9f) continue;                          // vértice reflexo (ou colinear)
      bool inside = false;
      for (int q = 0; q < m && !inside; q++) {
        int p = idx[q];
        if (p == a || p == b || p == c) continue;
        float d1 = (x[b] - x[a]) * (z[p] - z[a]) - (z[b] - z[a]) * (x[p] - x[a]);
        float d2 = (x[c] - x[b]) * (z[p] - z[b]) - (z[c] - z[b]) * (x[p] - x[b]);
        float d3 = (x[a] - x[c]) * (z[p] - z[c]) - (z[a] - z[c]) * (x[p] - x[c]);
        inside = d1 >= 0 && d2 >= 0 && d3 >= 0;
      }
      if (inside) continue;
      tri[3 * nt] = a; tri[3 * nt + 1] = b; tri[3 * nt + 2] = c; nt++;
      for (int q = k; q < m - 1; q++) idx[q] = idx[q + 1];
      m--; cut = true; break;
    }
    if (!cut) {                                           // polígono degenerado: tira um vértice
      for (int q = 0; q < m - 1; q++) idx[q] = idx[q + 1];
      m--;
    }
  }
  if (m == 3 && nt < maxTri) { tri[3 * nt] = idx[0]; tri[3 * nt + 1] = idx[1]; tri[3 * nt + 2] = idx[2]; nt++; }
  return nt;
}

/** Área de uma lista de triângulos (para conferir a triangulação no teste). */
static inline float pm_tri_area(const float *x, const float *z, const uint8_t *tri, int nt) {
  float s = 0;
  for (int t = 0; t < nt; t++) {
    int a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    s += fabsf((x[b] - x[a]) * (z[c] - z[a]) - (z[b] - z[a]) * (x[c] - x[a])) / 2;
  }
  return s;
}

/** Nome do tipo em português para o subtítulo do quadro (tela do cômodo). */
static inline const char *pm_type_label(const char *t) {
  static const char *const map[][2] = {
    { "light", "Luz" }, { "ac", "Ar-condicionado" }, { "valve", "Válvula" }, { "meter", "Circuito do quadro" },
    { "sensor", "Sensor" }, { "fan", "Ventilador / exaustor" }, { "alarm", "Alarme" }, { "gate", "Portão" },
    { "curtain", "Cortina" }, { "tv", "TV" }, { "plug", "Tomada" }, { "switch", "Interruptor" }, { "lock", "Fechadura" },
    { "camera", "Câmera" }, { "speaker", "Assistente" }, { "audio", "Áudio" }, { "projector", "Projetor" },
    { "media", "Mídia" }, { "computer", "Computador" }, { "tablet", "Tablet" }, { "network", "Rede" },
    { "appliance", "Eletrodoméstico" }, { "vacuum", "Robô aspirador" }, { "solar", "Energia" }, { "hub", "Hub" },
  };
  for (auto &m : map) if (!strcmp(t, m[0])) return m[1];
  return "Aparelho";
}

/**
 * Próximo caractere de um nome de cômodo, normalizado para comparar: minúsculas, inclusive as
 * letras acentuadas do português em UTF-8 (Á À Â Ã É Ê Í Ó Ô Õ Ú Ç → á à â ã é ê í ó ô õ ú ç,
 * faixa Latin-1 U+00C0–U+00DE). Devolve o código (ASCII ou U+00xx) e avança `s`; 0 no fim.
 */
static inline unsigned pm_room_char(const char *&s) {
  unsigned char c = (unsigned char)*s;
  if (!c) return 0;
  if (c == 0xC3 && ((unsigned char)s[1] & 0xC0) == 0x80) {          // U+00C0..U+00FF
    unsigned u = 0xC0 + ((unsigned char)s[1] & 0x3F);
    s += 2;
    if (u >= 0xC0 && u <= 0xDE && u != 0xD7) u += 0x20;            // maiúscula acentuada → minúscula (× fica)
    return u;
  }
  s++;
  if (c >= 'A' && c <= 'Z') c += 32;
  return c;
}

static inline bool pm_room_space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

/**
 * Mesmo cômodo? Como o servidor (panel.ts: toLowerCase() + trim()): ignora maiúsculas, também
 * nas letras acentuadas, e os espaços nas pontas ("Área Externa " = "área externa").
 */
static inline bool pm_same_room(const char *a, const char *b) {
  if (!a) a = "";
  if (!b) b = "";
  while (pm_room_space(*a)) a++;
  while (pm_room_space(*b)) b++;
  const char *ea = a + strlen(a), *eb = b + strlen(b);
  while (ea > a && pm_room_space(ea[-1])) ea--;
  while (eb > b && pm_room_space(eb[-1])) eb--;
  while (a < ea && b < eb) {
    if (pm_room_char(a) != pm_room_char(b)) return false;
  }
  return a >= ea && b >= eb;
}

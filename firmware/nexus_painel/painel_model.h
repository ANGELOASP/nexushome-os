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

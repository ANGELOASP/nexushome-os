// ============================================================
// NexusHome OS — Painel de parede (v2.16): interface LVGL 8
// ------------------------------------------------------------
// Mesma linguagem visual do app (tinta escura, latão para o que está ligado,
// vermelho só para alarme). Layout calculado pelo tamanho da tela:
//   retrato (P4 10,1" do corredor): resumo 2×2, alertas, cômodos e quadros
//   paisagem (7" do cômodo, ou P4 girado): resumo à esquerda, quadros à direita
// Os widgets são criados uma vez (pool de quadros) e só atualizados depois.
// ============================================================
#include <Arduino.h>
#include <esp_display_panel.hpp>
#include <lvgl.h>
#include "lvgl_v8_port.h"
#include "ui.h"

using namespace esp_panel::drivers;
using namespace esp_panel::board;

LV_FONT_DECLARE(nh_font_16);
LV_FONT_DECLARE(nh_font_20);
LV_FONT_DECLARE(nh_font_24);
LV_FONT_DECLARE(nh_font_48);

// paleta (css/styles.css do app)
#define C_INK     lv_color_hex(0x0C1017)
#define C_CARD    lv_color_hex(0x121823)
#define C_RAISED  lv_color_hex(0x182030)
#define C_LINE    lv_color_hex(0x263044)
#define C_TEXT    lv_color_hex(0xE8EDF5)
#define C_MUTED   lv_color_hex(0x8B97AB)
#define C_ACCENT  lv_color_hex(0xF2B24A)
#define C_ON_BG   lv_color_hex(0x2E2412)
#define C_OK      lv_color_hex(0x5FD38D)
#define C_WARN    lv_color_hex(0xF2B24A)
#define C_CRIT    lv_color_hex(0xFF6B6B)
#define C_CRIT_BG lv_color_hex(0x3A1518)
#define C_WATER   lv_color_hex(0x5BC0EB)

static UiCmdFn s_cmd = nullptr;
static bool s_room = false;
static char s_roomName[32] = "";
static Board *s_board = nullptr;

// troca de dados entre a tarefa de rede e a tela
static SemaphoreHandle_t s_mx = nullptr;
static PModel s_in, s_ui;              // s_in: escrito pela rede · s_ui: só a tela
static UiConn s_connIn, s_conn;
static volatile bool s_newModel = false, s_newConn = false;

// widgets
static lv_obj_t *hdrTitle, *hdrSub, *hdrClock, *hdrPill, *hdrPillTxt, *hdrConn;
static lv_obj_t *cardVal[4], *cardSub[4];
static lv_obj_t *alertBox, *alertRows[3];
static lv_obj_t *chipBar = nullptr, *grid;
static lv_obj_t *chips[PANEL_MAX_ROOMS + 1];
static uint8_t nChips = 0;
static lv_obj_t *tiles[PANEL_MAX_DEVS], *tileName[PANEL_MAX_DEVS], *tileRoom[PANEL_MAX_DEVS], *tileState[PANEL_MAX_DEVS];
static int16_t tileDev[PANEL_MAX_DEVS];   // quadro → índice em s_ui.devs
static char s_filter[32] = "";            // cômodo escolhido no corredor ("" = todos)
static char s_pendingId[37] = "";
static uint32_t s_pendingAt = 0;
static lv_obj_t *s_modal = nullptr;
static int16_t s_modalDev = -1;
static int s_modalTemp = 23;
static lv_obj_t *s_modalTempLbl = nullptr, *s_modalSlider = nullptr;

static lv_obj_t *mkLabel(lv_obj_t *p, const lv_font_t *f, lv_color_t c, const char *t) {
  lv_obj_t *l = lv_label_create(p);
  lv_obj_set_style_text_font(l, f, 0);
  lv_obj_set_style_text_color(l, c, 0);
  lv_label_set_text(l, t);
  return l;
}

static lv_obj_t *mkBox(lv_obj_t *p, int x, int y, int w, int h, lv_color_t bg) {
  lv_obj_t *o = lv_obj_create(p);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_size(o, w, h);
  lv_obj_set_style_bg_color(o, bg, 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
  lv_obj_set_style_border_color(o, C_LINE, 0);
  lv_obj_set_style_border_width(o, 1, 0);
  lv_obj_set_style_radius(o, 16, 0);
  lv_obj_set_style_pad_all(o, 14, 0);
  lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE);
  return o;
}

static void sendCmd(int devIdx, const char *action, const char *value) {
  if (devIdx < 0 || devIdx >= s_ui.nDevs || !s_cmd) return;
  UiCmd c;
  pm_copy(c.id, sizeof(c.id), s_ui.devs[devIdx].id);
  pm_copy(c.action, sizeof(c.action), action);
  pm_copy(c.value, sizeof(c.value), value);
  s_cmd(c);
  pm_copy(s_pendingId, sizeof(s_pendingId), c.id);
  s_pendingAt = millis();
}

// ------------------------------------------------------------ janelas (modal)
static void closeModal() {
  if (s_modal) { lv_obj_del_async(s_modal); s_modal = nullptr; }
  s_modalDev = -1; s_modalTempLbl = nullptr; s_modalSlider = nullptr;
}

static void onModalBtn(lv_event_t *e) {
  const char *what = (const char *)lv_event_get_user_data(e);
  int dev = s_modalDev;
  if (!strcmp(what, "cancel")) { closeModal(); return; }
  if (!strncmp(what, "arm:", 4)) { sendCmd(dev, "armed", what + 4); closeModal(); return; }
  if (!strcmp(what, "tap")) {
    char a[16], v[16]; bool conf;
    if (dev >= 0 && pm_tap_command(s_ui.devs[dev], a, sizeof(a), v, sizeof(v), &conf)) sendCmd(dev, a, v);
    closeModal(); return;
  }
  if (!strcmp(what, "bri") && s_modalSlider) {
    char v[8]; snprintf(v, sizeof(v), "%d", (int)lv_slider_get_value(s_modalSlider));
    sendCmd(dev, "brightness", v); closeModal(); return;
  }
  if (!strcmp(what, "t-") || !strcmp(what, "t+")) {
    s_modalTemp += what[1] == '+' ? 1 : -1;
    if (s_modalTemp < 16) s_modalTemp = 16;
    if (s_modalTemp > 30) s_modalTemp = 30;
    if (s_modalTempLbl) lv_label_set_text_fmt(s_modalTempLbl, "%d°C", s_modalTemp);
    return;
  }
  if (!strcmp(what, "temp")) {
    char v[8]; snprintf(v, sizeof(v), "%d", s_modalTemp);
    sendCmd(dev, "temp", v); closeModal(); return;
  }
}

static lv_obj_t *modalButton(lv_obj_t *p, const char *txt, const char *what, bool primary, int w) {
  lv_obj_t *b = lv_btn_create(p);
  lv_obj_set_size(b, w, 64);
  lv_obj_set_style_radius(b, 14, 0);
  lv_obj_set_style_bg_color(b, primary ? C_ACCENT : C_RAISED, 0);
  lv_obj_set_style_shadow_width(b, 0, 0);
  lv_obj_t *l = mkLabel(b, &nh_font_20, primary ? lv_color_hex(0x1B1403) : C_TEXT, txt);
  lv_obj_center(l);
  lv_obj_add_event_cb(b, onModalBtn, LV_EVENT_CLICKED, (void *)what);
  return b;
}

// janela centralizada com título e uma linha de botões
static lv_obj_t *openModal(int dev, const char *title, const char *text) {
  closeModal();
  s_modalDev = dev;
  int W = lv_disp_get_hor_res(nullptr), H = lv_disp_get_ver_res(nullptr);
  s_modal = lv_obj_create(lv_scr_act());
  lv_obj_set_size(s_modal, W, H);
  lv_obj_set_pos(s_modal, 0, 0);
  lv_obj_set_style_bg_color(s_modal, lv_color_black(), 0);
  lv_obj_set_style_bg_opa(s_modal, LV_OPA_70, 0);
  lv_obj_set_style_border_width(s_modal, 0, 0);
  lv_obj_set_style_radius(s_modal, 0, 0);
  lv_obj_clear_flag(s_modal, LV_OBJ_FLAG_SCROLLABLE);
  int cw = W < 700 ? W - 40 : 620;
  lv_obj_t *card = mkBox(s_modal, (W - cw) / 2, H / 2 - 170, cw, 340, C_CARD);
  lv_obj_set_style_pad_all(card, 24, 0);
  lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(card, 16, 0);
  lv_obj_t *t = mkLabel(card, &nh_font_24, C_TEXT, title);
  lv_label_set_long_mode(t, LV_LABEL_LONG_DOT);
  lv_obj_set_width(t, cw - 48);
  if (text && text[0]) {
    lv_obj_t *x = mkLabel(card, &nh_font_20, C_MUTED, text);
    lv_label_set_long_mode(x, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(x, cw - 48);
  }
  return card;
}

static lv_obj_t *modalRow(lv_obj_t *card) {
  lv_obj_t *row = lv_obj_create(card);
  lv_obj_set_size(row, LV_PCT(100), 72);
  lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(row, 0, 0);
  lv_obj_set_style_pad_all(row, 0, 0);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(row, 12, 0);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
  return row;
}

static void openConfirm(int dev) {
  const PDev &d = s_ui.devs[dev];
  char a[16], v[16], q[96]; bool conf;
  if (!pm_tap_command(d, a, sizeof(a), v, sizeof(v), &conf)) return;
  bool turnOn = !strcmp(v, "true");
  if (!strcmp(a, "power")) snprintf(q, sizeof(q), "%s este circuito no quadro?", turnOn ? "Ligar" : "Desligar");
  else snprintf(q, sizeof(q), "%s agora?", turnOn ? "Abrir" : "Fechar");
  lv_obj_t *card = openModal(dev, d.name, q);
  lv_obj_t *row = modalRow(card);
  int bw = (lv_obj_get_width(card) - 48 - 12) / 2;
  modalButton(row, "Cancelar", "cancel", false, bw);
  modalButton(row, turnOn ? (strcmp(a, "power") ? "Abrir" : "Ligar") : (strcmp(a, "power") ? "Fechar" : "Desligar"), "tap", true, bw);
}

static void openAlarm(int dev) {
  const PDev &d = s_ui.devs[dev];
  char st[48]; pm_state_text(d, st, sizeof(st));
  lv_obj_t *card = openModal(dev, d.name, st);
  lv_obj_t *row = modalRow(card);
  int bw = (lv_obj_get_width(card) - 48 - 24) / 3;
  modalButton(row, "Desarmar", "arm:off", !strcmp(d.arm, "off"), bw);
  modalButton(row, "Em casa", "arm:home", !strcmp(d.arm, "home"), bw);
  modalButton(row, "Ausente", "arm:away", !strcmp(d.arm, "away"), bw);
  lv_obj_t *row2 = modalRow(card);
  modalButton(row2, "Fechar", "cancel", false, lv_obj_get_width(card) - 48);
}

static void openDetail(int dev) {
  const PDev &d = s_ui.devs[dev];
  char st[48]; pm_state_text(d, st, sizeof(st));
  lv_obj_t *card = openModal(dev, d.name, st);
  int inner = lv_obj_get_width(card) - 48;
  if (d.acts & ACT_BRI) {
    s_modalSlider = lv_slider_create(card);
    lv_obj_set_width(s_modalSlider, inner - 20);
    lv_slider_set_range(s_modalSlider, 1, 100);
    lv_slider_set_value(s_modalSlider, d.bri >= 0 ? d.bri : 70, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(s_modalSlider, C_ACCENT, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s_modalSlider, C_ACCENT, LV_PART_KNOB);
    lv_obj_t *row = modalRow(card);
    modalButton(row, "Cancelar", "cancel", false, (inner - 12) / 2);
    modalButton(row, "Aplicar brilho", "bri", true, (inner - 12) / 2);
  } else if (d.acts & ACT_TEMP) {
    s_modalTemp = isnan(d.temp) ? 23 : (int)lroundf(d.temp);
    lv_obj_t *row = modalRow(card);
    modalButton(row, "-", "t-", false, 90);
    s_modalTempLbl = mkLabel(row, &nh_font_24, C_TEXT, "");
    lv_obj_set_width(s_modalTempLbl, inner - 2 * 90 - 24);
    lv_obj_set_style_text_align(s_modalTempLbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text_fmt(s_modalTempLbl, "%d°C", s_modalTemp);
    modalButton(row, "+", "t+", false, 90);
    lv_obj_t *row2 = modalRow(card);
    modalButton(row2, "Cancelar", "cancel", false, (inner - 12) / 2);
    modalButton(row2, "Aplicar", "temp", true, (inner - 12) / 2);
  } else {
    lv_obj_t *row = modalRow(card);
    modalButton(row, "Fechar", "cancel", false, inner);
  }
}

// ------------------------------------------------------------ quadros
static void onTile(lv_event_t *e) {
  int i = (int)(intptr_t)lv_event_get_user_data(e);
  int dev = tileDev[i];
  if (dev < 0 || dev >= s_ui.nDevs) return;
  const PDev &d = s_ui.devs[dev];
  lv_event_code_t code = lv_event_get_code(e);
  if (code == LV_EVENT_LONG_PRESSED) {
    if (d.acts & (ACT_BRI | ACT_TEMP)) openDetail(dev);
    return;
  }
  if (code != LV_EVENT_SHORT_CLICKED) return;
  if (d.acts & ACT_ARMED) { openAlarm(dev); return; }
  char a[16], v[16]; bool conf;
  if (!pm_tap_command(d, a, sizeof(a), v, sizeof(v), &conf)) {
    openDetail(dev);                       // sensor, válvula travada...: só mostra o estado
    return;
  }
  if (conf) openConfirm(dev); else sendCmd(dev, a, v);
}

static void onChip(lv_event_t *e) {
  int i = (int)(intptr_t)lv_event_get_user_data(e);
  if (i == 0) s_filter[0] = 0;
  else pm_copy(s_filter, sizeof(s_filter), s_ui.rooms[i - 1]);
  s_newModel = true;                         // redesenha com o filtro novo
}

static void styleChip(lv_obj_t *c, bool on) {
  lv_obj_set_style_bg_color(c, on ? C_ACCENT : C_RAISED, 0);
  lv_obj_t *l = lv_obj_get_child(c, 0);
  if (l) lv_obj_set_style_text_color(l, on ? lv_color_hex(0x1B1403) : C_TEXT, 0);
}

static void rebuildChips() {
  if (!chipBar) return;
  bool same = nChips == s_ui.nRooms + 1;
  for (int i = 0; same && i < s_ui.nRooms; i++) {
    lv_obj_t *l = lv_obj_get_child(chips[i + 1], 0);
    same = l && !strcmp(lv_label_get_text(l), s_ui.rooms[i]);
  }
  if (!same) {
    lv_obj_clean(chipBar);
    nChips = 0;
    for (int i = 0; i <= s_ui.nRooms; i++) {
      lv_obj_t *c = lv_btn_create(chipBar);
      lv_obj_set_height(c, 52);
      lv_obj_set_style_radius(c, 26, 0);
      lv_obj_set_style_shadow_width(c, 0, 0);
      lv_obj_set_style_pad_hor(c, 22, 0);
      lv_obj_t *l = mkLabel(c, &nh_font_20, C_TEXT, i == 0 ? "Todos" : s_ui.rooms[i - 1]);
      lv_obj_center(l);
      lv_obj_add_event_cb(c, onChip, LV_EVENT_CLICKED, (void *)(intptr_t)i);
      chips[nChips++] = c;
    }
  }
  for (int i = 0; i < nChips; i++) {
    bool on = i == 0 ? s_filter[0] == 0 : !strcmp(s_filter, s_ui.rooms[i - 1]);
    styleChip(chips[i], on);
  }
}

static void refreshTiles() {
  int t = 0;
  bool pendingStill = s_pendingId[0] && millis() - s_pendingAt < 12000;
  for (int i = 0; i < s_ui.nDevs && t < PANEL_MAX_DEVS; i++) {
    const PDev &d = s_ui.devs[i];
    if (!s_room && s_filter[0] && strcmp(d.room, s_filter)) continue;
    tileDev[t] = i;
    lv_obj_t *tile = tiles[t];
    lv_obj_clear_flag(tile, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(tileName[t], d.name);
    lv_label_set_text(tileRoom[t], s_room ? d.type : d.room);
    char st[48];
    bool pending = pendingStill && !strcmp(d.id, s_pendingId);
    if (pending) pm_copy(st, sizeof(st), "enviando…");
    else pm_state_text(d, st, sizeof(st));
    lv_label_set_text(tileState[t], st);
    bool active = pm_active(d), alarm = d.alarm || d.lock;
    lv_obj_set_style_bg_color(tile, alarm ? C_CRIT_BG : active ? C_ON_BG : C_CARD, 0);
    lv_obj_set_style_border_color(tile, alarm ? C_CRIT : active ? C_ACCENT : C_LINE, 0);
    lv_obj_set_style_text_color(tileState[t], alarm ? C_CRIT : active ? C_ACCENT : C_MUTED, 0);
    lv_obj_set_style_opa(tile, d.ok ? LV_OPA_COVER : LV_OPA_60, 0);
    t++;
  }
  for (int i = t; i < PANEL_MAX_DEVS; i++) { tileDev[i] = -1; lv_obj_add_flag(tiles[i], LV_OBJ_FLAG_HIDDEN); }
}

static void refreshSummary() {
  const PHouse &h = s_ui.h;
  char b[32];
  pm_fmt_watts(b, sizeof(b), (float)h.watts);
  lv_label_set_text(cardVal[0], b);
  lv_label_set_text_fmt(cardVal[1], "%ld L/h", (long)h.water);
  if (h.level >= 0) lv_label_set_text_fmt(cardVal[2], "%d%%", h.level); else lv_label_set_text(cardVal[2], "-");
  lv_obj_set_style_text_color(cardVal[2], h.level >= 0 && h.level < 20 ? C_CRIT : C_WATER, 0);
  if (h.soc >= 0) lv_label_set_text_fmt(cardVal[3], "%d%%", h.soc); else lv_label_set_text(cardVal[3], "-");
  lv_obj_set_style_text_color(cardVal[3], h.soc >= 0 && h.soc <= 10 ? C_CRIT : h.soc >= 0 && h.soc <= 20 ? C_WARN : C_OK, 0);
  if (h.gridOk == 0) {
    lv_label_set_text(cardSub[3], "FALTA DE ENERGIA");
    lv_obj_set_style_text_color(cardSub[3], C_CRIT, 0);
  } else {
    lv_label_set_text(cardSub[3], h.gridOk == 1 ? "rede ok · nobreak" : "sem nobreak");
    lv_obj_set_style_text_color(cardSub[3], C_MUTED, 0);
  }
  // saúde da casa (pílula do cabeçalho)
  const char *txt = h.health == HEALTH_CRIT ? "Crítico" : h.health == HEALTH_WARN ? "Atenção" : "Seguro";
  lv_color_t c = h.health == HEALTH_CRIT ? C_CRIT : h.health == HEALTH_WARN ? C_WARN : C_OK;
  lv_label_set_text(hdrPillTxt, txt);
  lv_obj_set_style_text_color(hdrPillTxt, c, 0);
  lv_obj_set_style_border_color(hdrPill, c, 0);
  lv_obj_set_style_bg_color(hdrPill, h.health == HEALTH_CRIT ? C_CRIT_BG : C_CARD, 0);
  // alertas
  for (int i = 0; i < 3; i++) {
    if (i < s_ui.nAlerts) {
      const PAlert &a = s_ui.alerts[i];
      lv_label_set_text_fmt(alertRows[i], "• %s", a.msg);
      lv_obj_set_style_text_color(alertRows[i], a.sev == HEALTH_CRIT ? C_CRIT : a.sev == HEALTH_WARN ? C_WARN : C_TEXT, 0);
      lv_obj_clear_flag(alertRows[i], LV_OBJ_FLAG_HIDDEN);
    } else if (i == 0) {
      lv_label_set_text(alertRows[0], "Nenhum alerta. Tudo funcionando normalmente.");
      lv_obj_set_style_text_color(alertRows[0], C_MUTED, 0);
      lv_obj_clear_flag(alertRows[0], LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_add_flag(alertRows[i], LV_OBJ_FLAG_HIDDEN);
    }
  }
  lv_obj_set_style_border_color(alertBox, s_ui.nAlerts && s_ui.alerts[0].sev == HEALTH_CRIT ? C_CRIT : C_LINE, 0);
  // cômodo: clima no subtítulo (sensor do cômodo com temperatura)
  if (s_room) {
    for (int i = 0; i < s_ui.nDevs; i++) {
      if (!isnan(s_ui.devs[i].temp) && !strcmp(s_ui.devs[i].type, "sensor")) {
        char t[16]; pm_fmt_temp(t, sizeof(t), s_ui.devs[i].temp);
        lv_label_set_text_fmt(hdrSub, "%s · %s", s_conn.date, t);
        return;
      }
    }
  }
}

static void refreshConn() {
  lv_label_set_text(hdrClock, s_conn.clock[0] ? s_conn.clock : "--:--");
  if (!s_room || lv_label_get_text(hdrSub)[0] == 0) lv_label_set_text(hdrSub, s_conn.date);
  if (!s_conn.wifi) lv_label_set_text(hdrConn, "sem Wi-Fi");
  else if (!s_conn.online) lv_label_set_text_fmt(hdrConn, "sem conexão · atualizado há %lu min", (unsigned long)(s_conn.ageS / 60));
  else lv_label_set_text(hdrConn, "");
  lv_obj_set_style_text_color(hdrConn, C_WARN, 0);
}

static void onTimer(lv_timer_t *) {
  bool model = false, conn = false;
  if (xSemaphoreTake(s_mx, 0) == pdTRUE) {
    if (s_newModel) { memcpy(&s_ui, &s_in, sizeof(PModel)); s_newModel = false; model = true; }
    if (s_newConn) { s_conn = s_connIn; s_newConn = false; conn = true; }
    xSemaphoreGive(s_mx);
  }
  if (conn) refreshConn();
  if (model && s_ui.valid) {
    if (s_pendingId[0] && millis() - s_pendingAt > 12000) s_pendingId[0] = 0;
    rebuildChips();
    refreshSummary();
    refreshTiles();
  }
}

// ------------------------------------------------------------ montagem
static void mkCard(lv_obj_t *scr, int i, int x, int y, int w, int h, const char *title, lv_color_t color, bool big) {
  lv_obj_t *c = mkBox(scr, x, y, w, h, C_CARD);
  mkLabel(c, &nh_font_16, C_MUTED, title);
  cardVal[i] = mkLabel(c, big ? &nh_font_48 : &nh_font_24, color, "-");
  lv_obj_align(cardVal[i], LV_ALIGN_LEFT_MID, 0, big ? 6 : 4);
  cardSub[i] = mkLabel(c, &nh_font_16, C_MUTED, "");
  lv_obj_align(cardSub[i], LV_ALIGN_BOTTOM_LEFT, 0, 0);
}

static void build() {
  int W = lv_disp_get_hor_res(nullptr), H = lv_disp_get_ver_res(nullptr);
  bool portrait = H > W;
  const int P = 16;
  lv_obj_t *scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, C_INK, 0);
  lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

  // cabeçalho
  int HH = portrait ? 104 : 72;
  hdrTitle = mkLabel(scr, &nh_font_24, C_TEXT, s_room ? s_roomName : "NexusHome");
  lv_obj_set_pos(hdrTitle, P + 4, portrait ? 22 : 10);
  hdrSub = mkLabel(scr, &nh_font_16, C_MUTED, "");
  lv_obj_set_pos(hdrSub, P + 4, portrait ? 58 : 42);
  hdrClock = mkLabel(scr, &nh_font_24, C_TEXT, "--:--");
  lv_obj_align(hdrClock, LV_ALIGN_TOP_RIGHT, -P - 4, portrait ? 22 : 10);
  hdrPill = mkBox(scr, 0, 0, 150, 44, C_CARD);
  lv_obj_set_style_radius(hdrPill, 22, 0);
  lv_obj_set_style_pad_all(hdrPill, 0, 0);
  lv_obj_align(hdrPill, LV_ALIGN_TOP_RIGHT, -P - 110, portrait ? 18 : 10);
  hdrPillTxt = mkLabel(hdrPill, &nh_font_20, C_OK, "Seguro");
  lv_obj_center(hdrPillTxt);
  hdrConn = mkLabel(scr, &nh_font_16, C_WARN, "");
  lv_obj_align(hdrConn, LV_ALIGN_TOP_RIGHT, -P - 4, portrait ? 64 : 48);

  int y = HH;
  int gx, gy, gw, gh;   // área dos quadros
  if (portrait) {
    int cw = (W - 3 * P) / 2, ch = 150;
    mkCard(scr, 0, P, y, cw, ch, "ENERGIA AGORA", C_ACCENT, true);
    mkCard(scr, 1, 2 * P + cw, y, cw, ch, "ÁGUA AGORA", C_WATER, true);
    mkCard(scr, 2, P, y + ch + P, cw, ch, "RESERVATÓRIO", C_WATER, true);
    mkCard(scr, 3, 2 * P + cw, y + ch + P, cw, ch, "BATERIA", C_OK, true);
    lv_label_set_text(cardSub[0], "consumo da casa");
    lv_label_set_text(cardSub[1], "vazão de todos os ramais");
    lv_label_set_text(cardSub[2], "nível das caixas");
    y += 2 * ch + 2 * P;
    alertBox = mkBox(scr, P, y, W - 2 * P, 128, C_CARD);
    y += 128 + P;
    chipBar = lv_obj_create(scr);
    lv_obj_set_pos(chipBar, P, y);
    lv_obj_set_size(chipBar, W - 2 * P, 60);
    y += 60 + P;
    gx = P; gy = y; gw = W - 2 * P; gh = H - y - P;
  } else {
    int lw = W >= 1200 ? 400 : 290;
    int ch = s_room ? 92 : 86;
    const char *titles[4] = { "ENERGIA DA CASA", "ÁGUA", "RESERVATÓRIO", "BATERIA" };
    lv_color_t colors[4] = { C_ACCENT, C_WATER, C_WATER, C_OK };
    for (int i = 0; i < 4; i++) mkCard(scr, i, P, y + i * (ch + P / 2), lw, ch, titles[i], colors[i], false);
    int ay = y + 4 * (ch + P / 2);
    alertBox = mkBox(scr, P, ay, lw, H - ay - P, C_CARD);
    gx = lw + 2 * P; gy = y; gw = W - gx - P; gh = H - y - P;
    if (!s_room) {
      chipBar = lv_obj_create(scr);
      lv_obj_set_pos(chipBar, gx, y);
      lv_obj_set_size(chipBar, gw, 60);
      gy += 60 + P; gh -= 60 + P;
    }
  }
  if (chipBar) {
    lv_obj_set_style_bg_opa(chipBar, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(chipBar, 0, 0);
    lv_obj_set_style_pad_all(chipBar, 0, 0);
    lv_obj_set_flex_flow(chipBar, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_column(chipBar, 10, 0);
    lv_obj_set_scroll_dir(chipBar, LV_DIR_HOR);
    lv_obj_set_scrollbar_mode(chipBar, LV_SCROLLBAR_MODE_OFF);
  }
  lv_obj_set_flex_flow(alertBox, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(alertBox, 6, 0);
  mkLabel(alertBox, &nh_font_16, C_MUTED, "ALERTAS");
  for (int i = 0; i < 3; i++) {
    alertRows[i] = mkLabel(alertBox, &nh_font_16, C_TEXT, "");
    lv_label_set_long_mode(alertRows[i], LV_LABEL_LONG_DOT);
    lv_obj_set_width(alertRows[i], lv_obj_get_width(alertBox) - 28);
  }

  // grade de quadros (rola na vertical)
  grid = lv_obj_create(scr);
  lv_obj_set_pos(grid, gx, gy);
  lv_obj_set_size(grid, gw, gh);
  lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(grid, 0, 0);
  lv_obj_set_style_pad_all(grid, 0, 0);
  lv_obj_set_flex_flow(grid, LV_FLEX_FLOW_ROW_WRAP);
  lv_obj_set_style_pad_row(grid, 12, 0);
  lv_obj_set_style_pad_column(grid, 12, 0);
  lv_obj_set_scroll_dir(grid, LV_DIR_VER);
  int cols = gw >= 700 ? (gw >= 1000 ? 3 : 2) : 2;
  int tw = (gw - (cols - 1) * 12) / cols, th = portrait ? 124 : 104;
  for (int i = 0; i < PANEL_MAX_DEVS; i++) {
    lv_obj_t *t = mkBox(grid, 0, 0, tw, th, C_CARD);
    lv_obj_add_flag(t, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(t, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_pad_all(t, 12, 0);
    tileName[i] = mkLabel(t, &nh_font_20, C_TEXT, "");
    lv_label_set_long_mode(tileName[i], LV_LABEL_LONG_DOT);
    lv_obj_set_width(tileName[i], tw - 24);
    tileRoom[i] = mkLabel(t, &nh_font_16, C_MUTED, "");
    lv_obj_align(tileRoom[i], LV_ALIGN_TOP_LEFT, 0, 28);
    tileState[i] = mkLabel(t, portrait ? &nh_font_24 : &nh_font_20, C_MUTED, "");
    lv_label_set_long_mode(tileState[i], LV_LABEL_LONG_DOT);
    lv_obj_set_width(tileState[i], tw - 24);
    lv_obj_align(tileState[i], LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_obj_add_event_cb(t, onTile, LV_EVENT_SHORT_CLICKED, (void *)(intptr_t)i);
    lv_obj_add_event_cb(t, onTile, LV_EVENT_LONG_PRESSED, (void *)(intptr_t)i);
    tiles[i] = t;
    tileDev[i] = -1;
  }

  // primeira tela antes do servidor responder
  lv_label_set_text(alertRows[0], "Conectando ao NexusHome…");
  lv_obj_set_style_text_color(alertRows[0], C_MUTED, 0);
  lv_obj_add_flag(alertRows[1], LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(alertRows[2], LV_OBJ_FLAG_HIDDEN);
  lv_timer_create(onTimer, 400, nullptr);
}

bool ui_begin(bool modoComodo, const char *comodo, UiCmdFn onCmd) {
  s_room = modoComodo;
  pm_copy(s_roomName, sizeof(s_roomName), comodo);
  s_cmd = onCmd;
  s_mx = xSemaphoreCreateMutex();
  s_board = new Board();
  s_board->init();
  if (!s_board->begin()) return false;
  lvgl_port_init(s_board->getLCD(), s_board->getTouch());
  lvgl_port_lock(-1);
  build();
  lvgl_port_unlock();
  return true;
}

void ui_set_model(const PModel &m) {
  if (!s_mx) return;
  xSemaphoreTake(s_mx, portMAX_DELAY);
  memcpy(&s_in, &m, sizeof(PModel));
  s_newModel = true;
  xSemaphoreGive(s_mx);
}

void ui_set_conn(const UiConn &c) {
  if (!s_mx) return;
  xSemaphoreTake(s_mx, portMAX_DELAY);
  s_connIn = c;
  s_newConn = true;
  xSemaphoreGive(s_mx);
}

void ui_set_brightness(int pct) {
  if (!s_board) return;
  auto *bl = s_board->getBacklight();
  if (!bl) return;
  if (pct <= 0) bl->off();
  else { bl->on(); bl->setBrightness(pct); }
}

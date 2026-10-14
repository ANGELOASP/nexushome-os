// ============================================================
// NexusHome OS — Tela touch do quadro elétrico (ver ui.h)
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │ Energia da casa                     Wi-Fi: ok   Medidores 33/33│  ← VERMELHO com sobrecarga,
//  ├──────────────┬───────────────────────────────────────────────┤     âmbar com corte de demanda
//  │              │                                               │     (tocar abre o circuito)
//  │ Agora        │ [ Íntimo · 10 ] [ Social · 5 ] [ Serviços · 18 ]│
//  │  8,2 kW      │  Chuveiro        Ar-condicionado  Tomadas 10 A │  ← toque = detalhes e
//  │ ████░░ 68%   │  Banheiro 1      Quarto 2         Quarto Princ.│     ligar / desligar / rearmar
//  │ do limite    │  7,6 kW          1,1 kW           85 W         │     (sempre confirmando)
//  │ Íntimo 7,9kW │  ligado          ligado           ligado       │
//  │ Social 0,2kW │  ...  (rola para cima/baixo)                  │
//  │ Serviços ... │                                               │
//  │ 1.234 kWh    │                                               │
//  └──────────────┴───────────────────────────────────────────────┘
// ============================================================
#include <Arduino.h>
#include <esp_display_panel.hpp>
#include <lvgl.h>
#include "lvgl_v8_port.h"
#include "ui.h"

LV_FONT_DECLARE(nh_font_16);
LV_FONT_DECLARE(nh_font_20);
LV_FONT_DECLARE(nh_font_24);
LV_FONT_DECLARE(nh_font_48);

using namespace esp_panel::board;

// ---- paleta (a mesma da tela da água) ----
#define C_BG        lv_color_hex(0x0B1220)
#define C_CARD      lv_color_hex(0x121B2E)
#define C_LINE      lv_color_hex(0x24324D)
#define C_TEXT      lv_color_hex(0xE5ECF6)
#define C_MUTED     lv_color_hex(0x8EA0BC)
#define C_ENERGY    lv_color_hex(0x22D3EE)
#define C_ON_BG     lv_color_hex(0x0F3A26)
#define C_ON        lv_color_hex(0x34D399)
#define C_OFF_BG    lv_color_hex(0x1C2433)
#define C_OFF       lv_color_hex(0x94A3B8)
#define C_ALARM_BG  lv_color_hex(0x4A0F14)
#define C_ALARM     lv_color_hex(0xF87171)
#define C_WARN_BG   lv_color_hex(0x3D2A08)
#define C_WARN      lv_color_hex(0xFBBF24)
#define C_TAB_ON    lv_color_hex(0x1E3A5F)

enum TileState : uint8_t { T_NONE = 0, T_NOREAD, T_ON, T_OFF, T_TRIP, T_SHED, T_METER };

static UiRequestFn s_req = nullptr;
static const UiCircuit *s_c = nullptr;
static int s_n = 0;
static const char *const *s_groupName = nullptr;
static int s_groups = 0;
static int s_tab = 0;
static UiState s_last;
static bool s_haveState = false;

static lv_obj_t *hdr, *hdrTitle, *chipWifi, *chipBus;
static lv_obj_t *nowValue, *limitBar, *limitText, *kwhText;
static lv_obj_t *groupValue[UI_MAX_GROUPS], *groupBar[UI_MAX_GROUPS];
static lv_obj_t *tabBtn[UI_MAX_GROUPS], *tabLabel[UI_MAX_GROUPS];
static lv_obj_t *grid;
static lv_obj_t *tile[UI_MAX_CIRCUITS], *tileW[UI_MAX_CIRCUITS], *tileSt[UI_MAX_CIRCUITS], *tileLoad[UI_MAX_CIRCUITS];
static uint8_t tileLast[UI_MAX_CIRCUITS];
static char tileName[UI_MAX_CIRCUITS][64];
static lv_obj_t *modal = nullptr;
static UiRequest s_pending;

// ---- utilidades ----
static void comma(char *s) { for (char *p = s; *p; p++) if (*p == '.') *p = ','; }

// 640 → "640 W" · 7600 → "7,6 kW"
static void fmtW(char *out, size_t n, float w) {
  if (w < 0) w = 0;
  if (w < 999.5f) snprintf(out, n, "%.0f W", w);
  else { snprintf(out, n, "%.1f kW", w / 1000.0f); comma(out); }
}

// 1234.5 → "1.234 kWh" (milhar com ponto, como no Brasil)
static void fmtKwh(char *out, size_t n, float kwh) {
  long v = (long)(kwh + 0.5f);
  if (v >= 1000) snprintf(out, n, "%ld.%03ld kWh", v / 1000, v % 1000);
  else if (kwh < 10) { snprintf(out, n, "%.1f kWh", kwh); comma(out); }
  else snprintf(out, n, "%ld kWh", v);
}

// só redesenha quando o texto muda (a tela atualiza ~3 vezes por segundo)
static void setText(lv_obj_t *l, const char *s) {
  const char *cur = lv_label_get_text(l);
  if (!cur || strcmp(cur, s)) lv_label_set_text(l, s);
}

static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h, lv_color_t bg, lv_color_t border) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_size(o, w, h);
  lv_obj_set_style_bg_color(o, bg, 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
  lv_obj_set_style_border_color(o, border, 0);
  lv_obj_set_style_border_width(o, 2, 0);
  lv_obj_set_style_radius(o, 14, 0);
  lv_obj_set_style_pad_all(o, 0, 0);
  lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE);
  return o;
}

static lv_obj_t *text(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, const char *s) {
  lv_obj_t *l = lv_label_create(parent);
  lv_obj_set_style_text_font(l, font, 0);
  lv_obj_set_style_text_color(l, color, 0);
  lv_label_set_text(l, s);
  return l;
}

static lv_obj_t *bar(lv_obj_t *parent, int x, int y, int w, int h) {
  lv_obj_t *b = lv_bar_create(parent);
  lv_obj_set_pos(b, x, y);
  lv_obj_set_size(b, w, h);
  lv_bar_set_range(b, 0, 100);
  lv_obj_set_style_bg_color(b, lv_color_hex(0x0E2238), LV_PART_MAIN);
  lv_obj_set_style_bg_color(b, C_ENERGY, LV_PART_INDICATOR);
  lv_obj_set_style_radius(b, h / 2, LV_PART_MAIN);
  lv_obj_set_style_radius(b, h / 2, LV_PART_INDICATOR);
  return b;
}

static TileState stateOf(const UiState &s, int i) {
  if (s.trip[i]) return T_TRIP;
  if (s.shed[i]) return T_SHED;
  if (!s.meterOk[i] && !s_c[i].relay) return T_NOREAD;
  if (!s_c[i].relay) return T_METER;
  return s.on[i] ? T_ON : T_OFF;
}

// ---- diálogo (sempre por cima de tudo) ----
static void closeModal() { if (modal) { lv_obj_del(modal); modal = nullptr; } }

static void onModalOk(lv_event_t *) {
  UiRequest r = s_pending;
  closeModal();
  if (r.type && s_req) s_req(r);
}
static void onModalCancel(lv_event_t *) { closeModal(); }

static void modalButton(lv_obj_t *card, int x, int w, const char *label, lv_color_t bg, lv_event_cb_t cb) {
  lv_obj_t *b = lv_btn_create(card);
  lv_obj_set_pos(b, x, 212);
  lv_obj_set_size(b, w, 56);
  lv_obj_set_style_bg_color(b, bg, 0);
  lv_obj_set_style_radius(b, 12, 0);
  lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, nullptr);
  lv_obj_t *l = text(b, &nh_font_20, C_TEXT, label);
  lv_obj_center(l);
}

// okLabel = nullptr → só "Fechar"
static void showModal(const char *title, const char *body, const char *note, lv_color_t noteColor,
                      const char *okLabel, lv_color_t okColor, UiRequest req) {
  closeModal();
  s_pending = req;
  modal = lv_obj_create(lv_layer_top());
  lv_obj_set_size(modal, 800, 480);
  lv_obj_set_pos(modal, 0, 0);
  lv_obj_set_style_bg_color(modal, lv_color_black(), 0);
  lv_obj_set_style_bg_opa(modal, LV_OPA_60, 0);
  lv_obj_set_style_border_width(modal, 0, 0);
  lv_obj_set_style_radius(modal, 0, 0);
  lv_obj_clear_flag(modal, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(modal, LV_OBJ_FLAG_CLICKABLE);   // toque fora do cartão não passa para a tela de trás

  lv_obj_t *card = box(modal, 130, 92, 540, 290, C_CARD, C_LINE);
  lv_obj_t *t = text(card, &nh_font_24, C_TEXT, title);
  lv_label_set_long_mode(t, LV_LABEL_LONG_DOT);
  lv_obj_set_width(t, 496);
  lv_obj_set_pos(t, 22, 18);
  lv_obj_t *b = text(card, &nh_font_16, C_TEXT, body);
  lv_label_set_long_mode(b, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(b, 496);
  lv_obj_set_pos(b, 22, 60);
  if (note && note[0]) {
    lv_obj_t *n = text(card, &nh_font_16, noteColor, note);
    lv_label_set_long_mode(n, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(n, 496);
    lv_obj_set_pos(n, 22, 132);
  }
  if (okLabel) {
    modalButton(card, 22, 236, "Cancelar", C_LINE, onModalCancel);
    modalButton(card, 278, 240, okLabel, okColor, onModalOk);
  } else {
    modalButton(card, 278, 240, "Fechar", C_LINE, onModalCancel);
  }
}

// ---- eventos ----
static void onTile(lv_event_t *e) {
  int i = (int)(intptr_t)lv_event_get_user_data(e);
  if (!s_haveState || i < 0 || i >= s_n) return;
  const UiState &s = s_last;
  char title[72], body[220], note[200], w[16], v[16], a[16], k[24], pf[12];
  snprintf(title, sizeof(title), "%s", s_c[i].name);
  if (s.meterOk[i]) {
    fmtW(w, sizeof(w), s.watts[i]);
    snprintf(v, sizeof(v), "%.1f V", s.volts[i]); comma(v);
    snprintf(a, sizeof(a), "%.2f A", s.amps[i]); comma(a);
    fmtKwh(k, sizeof(k), s.kwh[i]);
    snprintf(pf, sizeof(pf), "%.2f", s.pf[i]); comma(pf);
    int load = s_c[i].breakerA > 0 ? (int)(s.amps[i] / s_c[i].breakerA * 100.0f + 0.5f) : 0;
    snprintf(body, sizeof(body), "Agora: %s  ·  %s  ·  %s  ·  FP %s\nAcumulado: %s\nCarga: %d%% do disjuntor de %.0f A",
             w, v, a, pf, k, load, s_c[i].breakerA);
  } else {
    snprintf(body, sizeof(body), "Medidor sem resposta no barramento RS-485.\nConfira o cabo A/B e o endereço do PZEM.");
  }

  TileState st = stateOf(s, i);
  if (st == T_TRIP) {
    snprintf(note, sizeof(note), "Desligado por SOBRECARGA (corrente acima do disjuntor por 30 s). "
                                 "Descubra a causa antes de rearmar.");
    showModal(title, body, note, C_ALARM, "Rearmar", lv_color_hex(0x15803D), UiRequest{ UI_REQ_REARM, (int16_t)i, true, false });
  } else if (!s_c[i].relay) {
    snprintf(note, sizeof(note), "Circuito só com medição (sem relé): liga e desliga pelos interruptores e pelo disjuntor.");
    showModal(title, body, note, C_MUTED, nullptr, C_LINE, UiRequest{});
  } else if (s.on[i]) {
    if (st == T_SHED)
      snprintf(note, sizeof(note), "Cortado pela gestão de demanda: volta sozinho quando o consumo da casa baixar. "
                                   "Desligar aqui impede que ele volte.");
    else
      snprintf(note, sizeof(note), "Desligar corta a energia deste circuito no quadro até você ligar de novo "
                                   "(pela tela ou pelo app).");
    showModal(title, body, note, st == T_SHED ? C_WARN : C_MUTED, "Desligar", lv_color_hex(0xB45309),
              UiRequest{ UI_REQ_SET, (int16_t)i, false, false });
  } else {
    snprintf(note, sizeof(note), "O circuito está desligado no quadro.");
    showModal(title, body, note, C_MUTED, "Ligar", lv_color_hex(0x15803D), UiRequest{ UI_REQ_SET, (int16_t)i, true, false });
  }
}

static void showTab(int g) {
  s_tab = g;
  for (int k = 0; k < s_groups; k++) {
    lv_obj_set_style_bg_color(tabBtn[k], k == g ? C_TAB_ON : C_CARD, 0);
    lv_obj_set_style_border_color(tabBtn[k], k == g ? C_ENERGY : C_LINE, 0);
  }
  for (int i = 0; i < s_n; i++) {
    if (s_c[i].group == g) lv_obj_clear_flag(tile[i], LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(tile[i], LV_OBJ_FLAG_HIDDEN);
  }
  lv_obj_scroll_to_y(grid, 0, LV_ANIM_OFF);
}

static void onTab(lv_event_t *e) { showTab((int)(intptr_t)lv_event_get_user_data(e)); }

// toque na faixa de alarme: abre a aba do primeiro circuito desarmado (ou cortado) e mostra o circuito
static void onHeader(lv_event_t *) {
  if (!s_haveState) return;
  int pick = -1;
  for (int i = 0; i < s_n && pick < 0; i++) if (s_last.trip[i]) pick = i;
  for (int i = 0; i < s_n && pick < 0; i++) if (s_last.shed[i]) pick = i;
  if (pick < 0) return;
  showTab(s_c[pick].group);
  lv_obj_scroll_to_view(tile[pick], LV_ANIM_OFF);
  lv_event_send(tile[pick], LV_EVENT_CLICKED, nullptr);
}

// ---- montagem da tela ----
static void build() {
  lv_obj_t *scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, C_BG, 0);
  lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

  // cabeçalho (vira faixa de alarme)
  hdr = box(scr, 0, 0, 800, 56, C_CARD, C_CARD);
  lv_obj_set_style_radius(hdr, 0, 0);
  lv_obj_add_flag(hdr, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(hdr, onHeader, LV_EVENT_CLICKED, nullptr);
  hdrTitle = text(hdr, &nh_font_24, C_TEXT, "Energia da casa");
  lv_label_set_long_mode(hdrTitle, LV_LABEL_LONG_DOT);
  lv_obj_set_width(hdrTitle, 470);
  lv_obj_align(hdrTitle, LV_ALIGN_LEFT_MID, 18, 0);
  chipWifi = text(hdr, &nh_font_16, C_MUTED, "Wi-Fi");
  lv_obj_align(chipWifi, LV_ALIGN_RIGHT_MID, -190, 0);
  chipBus = text(hdr, &nh_font_16, C_MUTED, "Medidores");
  lv_obj_align(chipBus, LV_ALIGN_RIGHT_MID, -18, 0);

  // consumo da casa
  lv_obj_t *left = box(scr, 12, 64, 236, 404, C_CARD, C_LINE);
  lv_obj_t *lt = text(left, &nh_font_20, C_TEXT, "Agora");
  lv_obj_set_pos(lt, 16, 12);
  nowValue = text(left, &nh_font_48, C_TEXT, "--");
  lv_obj_set_pos(nowValue, 14, 40);
  limitBar = bar(left, 16, 106, 204, 14);
  limitText = text(left, &nh_font_16, C_MUTED, "");
  lv_label_set_long_mode(limitText, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(limitText, 204);
  lv_obj_set_pos(limitText, 16, 126);

  lv_obj_t *sep = box(left, 16, 176, 204, 2, C_LINE, C_LINE);
  lv_obj_set_style_radius(sep, 0, 0);
  for (int g = 0; g < s_groups && g < UI_MAX_GROUPS; g++) {
    int y = 190 + g * 54;
    lv_obj_t *gn = text(left, &nh_font_16, C_MUTED, s_groupName[g]);
    lv_obj_set_pos(gn, 16, y);
    groupValue[g] = text(left, &nh_font_20, C_TEXT, "--");
    lv_obj_align(groupValue[g], LV_ALIGN_TOP_RIGHT, -16, y - 2);
    groupBar[g] = bar(left, 16, y + 26, 204, 8);
  }
  kwhText = text(left, &nh_font_16, C_MUTED, "");
  lv_obj_set_pos(kwhText, 16, 366);

  // abas dos subquadros
  int tabW = (528 - (s_groups - 1) * 8) / (s_groups ? s_groups : 1);
  for (int g = 0; g < s_groups && g < UI_MAX_GROUPS; g++) {
    tabBtn[g] = box(scr, 260 + g * (tabW + 8), 64, tabW, 48, C_CARD, C_LINE);
    lv_obj_set_style_radius(tabBtn[g], 12, 0);
    lv_obj_add_flag(tabBtn[g], LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(tabBtn[g], onTab, LV_EVENT_CLICKED, (void *)(intptr_t)g);
    int count = 0;
    for (int i = 0; i < s_n; i++) count += s_c[i].group == g;
    char b[48];
    snprintf(b, sizeof(b), "%s · %d", s_groupName[g], count);
    tabLabel[g] = text(tabBtn[g], &nh_font_20, C_TEXT, b);
    lv_obj_center(tabLabel[g]);
  }

  // circuitos (rola na vertical)
  grid = lv_obj_create(scr);
  lv_obj_set_pos(grid, 260, 120);
  lv_obj_set_size(grid, 528, 348);
  lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(grid, 0, 0);
  lv_obj_set_style_pad_all(grid, 0, 0);
  lv_obj_set_style_pad_row(grid, 8, 0);
  lv_obj_set_style_pad_column(grid, 8, 0);
  lv_obj_set_flex_flow(grid, LV_FLEX_FLOW_ROW_WRAP);
  lv_obj_set_scroll_dir(grid, LV_DIR_VER);
  lv_obj_set_scrollbar_mode(grid, LV_SCROLLBAR_MODE_ACTIVE);

  for (int i = 0; i < s_n; i++) {
    tile[i] = box(grid, 0, 0, 170, 124, C_OFF_BG, C_LINE);   // 3 por linha
    lv_obj_add_flag(tile[i], LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(tile[i], onTile, LV_EVENT_CLICKED, (void *)(intptr_t)i);
    // "Chuveiro — Banheiro 1" → "Chuveiro\nBanheiro 1"
    const char *src = s_c[i].name;
    const char *dash = strstr(src, " — ");
    if (dash) snprintf(tileName[i], sizeof(tileName[i]), "%.*s\n%s", (int)(dash - src), src, dash + strlen(" — "));
    else snprintf(tileName[i], sizeof(tileName[i]), "%s", src);
    lv_obj_t *n = text(tile[i], &nh_font_16, C_TEXT, tileName[i]);
    lv_label_set_long_mode(n, LV_LABEL_LONG_DOT);
    lv_obj_set_size(n, 152, 44);
    lv_obj_set_pos(n, 9, 7);
    tileW[i] = text(tile[i], &nh_font_24, C_TEXT, "--");
    lv_obj_set_pos(tileW[i], 9, 52);
    tileSt[i] = text(tile[i], &nh_font_16, C_OFF, "");
    lv_obj_set_pos(tileSt[i], 9, 82);
    tileLoad[i] = bar(tile[i], 9, 108, 148, 6);
    tileLast[i] = T_NONE;
  }
  if (s_groups) showTab(0);
}

bool ui_begin(const UiCircuit *circuits, int count, const char *const *groupNames, int groupCount, UiRequestFn onRequest) {
  s_req = onRequest;
  s_c = circuits;
  s_n = count > UI_MAX_CIRCUITS ? UI_MAX_CIRCUITS : count;
  s_groupName = groupNames;
  s_groups = groupCount > UI_MAX_GROUPS ? UI_MAX_GROUPS : groupCount;
  Board *board = new Board();
  board->init();
  if (!board->begin()) return false;
  lvgl_port_init(board->getLCD(), board->getTouch());
  lvgl_port_lock(-1);
  build();
  lvgl_port_unlock();
  return true;
}

void ui_update(const UiState &s) {
  if (!lvgl_port_lock(50)) return;   // tela ocupada: tenta no próximo ciclo
  s_last = s;
  s_haveState = true;
  char b[96], w[24];

  // cabeçalho: sobrecarga (vermelho) > corte de demanda (âmbar) > normal
  int trips = 0, sheds = 0, firstTrip = -1;
  for (int i = 0; i < s_n; i++) {
    if (s.trip[i]) { trips++; if (firstTrip < 0) firstTrip = i; }
    if (s.shed[i]) sheds++;
  }
  lv_color_t hb = trips ? C_ALARM_BG : (sheds ? C_WARN_BG : C_CARD);
  lv_color_t hl = trips ? C_ALARM : (sheds ? C_WARN : C_CARD);
  lv_obj_set_style_bg_color(hdr, hb, 0);
  lv_obj_set_style_border_color(hdr, hl, 0);
  if (trips == 1) snprintf(b, sizeof(b), "Sobrecarga: %s desligado", s_c[firstTrip].name);
  else if (trips > 1) snprintf(b, sizeof(b), "Sobrecarga: %d circuitos desligados", trips);
  else if (sheds) snprintf(b, sizeof(b), "Consumo alto: %d circuito%s cortado%s", sheds, sheds > 1 ? "s" : "", sheds > 1 ? "s" : "");
  else snprintf(b, sizeof(b), "Energia da casa");
  lv_obj_set_style_text_font(hdrTitle, (trips || sheds) ? &nh_font_20 : &nh_font_24, 0);
  setText(hdrTitle, b);
  setText(chipWifi, s.wifiOk ? "Wi-Fi: ok" : "Wi-Fi: sem rede");
  lv_obj_set_style_text_color(chipWifi, s.wifiOk ? C_ON : C_WARN, 0);
  bool busOk = s.relaysOk && s.metersOk == s_n;
  if (!s.relaysOk) snprintf(b, sizeof(b), "Relés: falha");
  else snprintf(b, sizeof(b), "Medidores %d/%d", s.metersOk, s_n);
  setText(chipBus, b);
  lv_obj_set_style_text_color(chipBus, busOk ? C_ON : C_WARN, 0);

  // consumo da casa
  fmtW(w, sizeof(w), s.totalW);
  setText(nowValue, s.metersOk ? w : "--");
  if (s.limitW > 0) {
    int pct = (int)(s.totalW / s.limitW * 100.0f + 0.5f);
    lv_bar_set_value(limitBar, pct > 100 ? 100 : pct, LV_ANIM_ON);
    lv_obj_set_style_bg_color(limitBar, pct >= 100 ? C_ALARM : (pct >= 85 ? C_WARN : C_ENERGY), LV_PART_INDICATOR);
    char lim[16];
    fmtW(lim, sizeof(lim), s.limitW);
    snprintf(b, sizeof(b), "%d%% do limite de %s", pct, lim);
    lv_obj_clear_flag(limitBar, LV_OBJ_FLAG_HIDDEN);
  } else {
    snprintf(b, sizeof(b), "Gestão de demanda desligada (sem limite)");
    lv_obj_add_flag(limitBar, LV_OBJ_FLAG_HIDDEN);
  }
  setText(limitText, b);
  float groupW[UI_MAX_GROUPS] = { 0 };
  for (int i = 0; i < s_n; i++) if (s.meterOk[i] && s_c[i].group < UI_MAX_GROUPS) groupW[s_c[i].group] += s.watts[i];
  for (int g = 0; g < s_groups; g++) {
    fmtW(w, sizeof(w), groupW[g]);
    setText(groupValue[g], w);
    lv_obj_align(groupValue[g], LV_ALIGN_TOP_RIGHT, -16, 190 + g * 54 - 2);
    int pct = s.totalW > 1 ? (int)(groupW[g] / s.totalW * 100.0f + 0.5f) : 0;
    lv_bar_set_value(groupBar[g], pct, LV_ANIM_ON);
    // aba vermelha/âmbar quando há circuito desarmado/cortado escondido nela
    bool gt = false, gs = false;
    for (int i = 0; i < s_n; i++) if (s_c[i].group == g) { gt |= s.trip[i]; gs |= s.shed[i]; }
    lv_obj_set_style_text_color(tabLabel[g], gt ? C_ALARM : (gs ? C_WARN : C_TEXT), 0);
  }
  fmtKwh(w, sizeof(w), s.totalKwh);
  snprintf(b, sizeof(b), "Acumulado: %s", w);
  setText(kwhText, b);

  // circuitos
  for (int i = 0; i < s_n; i++) {
    TileState st = stateOf(s, i);
    if (st != tileLast[i]) {
      tileLast[i] = st;
      lv_color_t bg = C_OFF_BG, bd = C_LINE, tc = C_OFF;
      const char *label = "";
      switch (st) {
        case T_TRIP:   bg = C_ALARM_BG; bd = C_ALARM; tc = C_ALARM; label = "SOBRECARGA"; break;
        case T_SHED:   bg = C_WARN_BG;  bd = C_WARN;  tc = C_WARN;  label = "cortado: demanda"; break;
        case T_ON:     bg = C_ON_BG;    bd = C_ON;    tc = C_ON;    label = "ligado"; break;
        case T_OFF:    label = "desligado"; break;
        case T_METER:  bg = C_CARD;     tc = C_MUTED; label = "só medição"; break;
        case T_NOREAD: bg = C_CARD;     tc = C_WARN;  label = "sem leitura"; break;
        default: break;
      }
      lv_obj_set_style_bg_color(tile[i], bg, 0);
      lv_obj_set_style_border_color(tile[i], bd, 0);
      lv_obj_set_style_text_color(tileSt[i], tc, 0);
      lv_label_set_text(tileSt[i], label);
    }
    if (s.meterOk[i]) fmtW(w, sizeof(w), s.watts[i]);
    else snprintf(w, sizeof(w), "--");
    setText(tileW[i], w);
    int load = (s.meterOk[i] && s_c[i].breakerA > 0) ? (int)(s.amps[i] / s_c[i].breakerA * 100.0f + 0.5f) : 0;
    lv_bar_set_value(tileLoad[i], load > 100 ? 100 : load, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(tileLoad[i], load >= 95 ? C_ALARM : (load >= 80 ? C_WARN : C_ENERGY), LV_PART_INDICATOR);
  }
  lvgl_port_unlock();
}

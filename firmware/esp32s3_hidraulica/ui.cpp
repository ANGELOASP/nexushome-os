// ============================================================
// NexusHome OS — Tela touch da caixa d'água (ver ui.h)
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │ Água da casa                          Wi-Fi ●   Sensores ●    │  ← fica VERMELHO com alarme
//  ├──────────────┬───────────────────────────────────────────────┤     (+ botão "Rearmar")
//  │ Reservatórios│  Cozinha   Banheiro 1  Banheiro 2  Á. Serviço │
//  │  ███  64%    │  ABERTA    ABERTA      FECHADA     ABERTA     │  ← toque = abrir/fechar
//  │  ███ 640 L   │  2,5 L/min                                    │     (sempre pede confirmação)
//  │  ███         │  Ramal 5   Ramal 6     GERAL       Á. Externa │
//  ├──────────────┴───────────────────────────────────────────────┤
//  │ Agora: 18,5 L/min · Total: 245 L        [ SEGURE: FECHAR TUDO ]│  ← pânico: segurar 2 s
//  └──────────────────────────────────────────────────────────────┘
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

// ---- paleta ----
#define C_BG        lv_color_hex(0x0B1220)
#define C_CARD      lv_color_hex(0x121B2E)
#define C_LINE      lv_color_hex(0x24324D)
#define C_TEXT      lv_color_hex(0xE5ECF6)
#define C_MUTED     lv_color_hex(0x8EA0BC)
#define C_WATER     lv_color_hex(0x38BDF8)
#define C_OPEN_BG   lv_color_hex(0x0F3A26)
#define C_OPEN      lv_color_hex(0x34D399)
#define C_SHUT_BG   lv_color_hex(0x1C2433)
#define C_SHUT      lv_color_hex(0x94A3B8)
#define C_ALARM_BG  lv_color_hex(0x4A0F14)
#define C_ALARM     lv_color_hex(0xF87171)
#define C_WARN      lv_color_hex(0xFBBF24)

static const char *VALVE_LABEL[8] = { "Cozinha", "Banheiro 1", "Banheiro 2", "Área de Serviço",
                                      "Ramal 5", "Ramal 6", "Geral", "Área Externa" };

static UiRequestFn s_req = nullptr;
static UiState s_last;
static bool s_haveState = false;

static lv_obj_t *hdr, *hdrTitle, *chipWifi, *chipBus, *btnRearm;
static lv_obj_t *tankBar, *tankPct, *tankLiters, *tankNote;
static lv_obj_t *tile[8], *tileState[8], *tileFlow[8];
static lv_obj_t *nowLabel, *totalLabel, *panicBtn, *panicLabel;
static lv_obj_t *modal = nullptr;
static UiRequest s_pending;
static uint32_t s_panicPressAt = 0;
static lv_timer_t *s_panicTimer = nullptr;
static bool s_panicFired = false;

// ---- utilidades ----
static void fmt1(char *out, size_t n, float v) {          // 12.5 → "12,5"
  snprintf(out, n, "%.1f", v);
  for (char *p = out; *p; p++) if (*p == '.') *p = ',';
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

// ---- diálogo de confirmação / aviso (sempre por cima de tudo) ----
static void closeModal() { if (modal) { lv_obj_del(modal); modal = nullptr; } }

static void onModalOk(lv_event_t *) {
  UiRequest r = s_pending;
  closeModal();
  if (r.type && s_req) s_req(r);
}
static void onModalCancel(lv_event_t *) { closeModal(); }

static lv_obj_t *modalButton(lv_obj_t *card, int x, const char *label, lv_color_t bg, lv_event_cb_t cb) {
  lv_obj_t *b = lv_btn_create(card);
  lv_obj_set_pos(b, x, 150);
  lv_obj_set_size(b, 206, 56);
  lv_obj_set_style_bg_color(b, bg, 0);
  lv_obj_set_style_radius(b, 12, 0);
  lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, nullptr);
  lv_obj_t *l = text(b, &nh_font_20, C_TEXT, label);
  lv_obj_center(l);
  return b;
}

// okLabel = nullptr → aviso só com "Entendi"
static void showModal(const char *title, const char *body, const char *okLabel, lv_color_t okColor, UiRequest req) {
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

  lv_obj_t *card = box(modal, 160, 120, 480, 230, C_CARD, C_LINE);
  lv_obj_t *t = text(card, &nh_font_24, C_TEXT, title);
  lv_obj_set_pos(t, 22, 18);
  lv_obj_t *b = text(card, &nh_font_16, C_MUTED, body);
  lv_label_set_long_mode(b, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(b, 436);
  lv_obj_set_pos(b, 22, 62);
  if (okLabel) {
    modalButton(card, 22, "Cancelar", C_LINE, onModalCancel);
    modalButton(card, 248, okLabel, okColor, onModalOk);
  } else {
    modalButton(card, 248, "Entendi", C_LINE, onModalCancel);
  }
}

// ---- eventos ----
static void onTile(lv_event_t *e) {
  int i = (int)(intptr_t)lv_event_get_user_data(e);
  if (!s_haveState) return;
  char title[64], body[200];
  if (s_last.blocked[i]) {
    snprintf(title, sizeof(title), "%s está travada", VALVE_LABEL[i]);
    snprintf(body, sizeof(body), "Ela foi fechada por segurança (alarme ou pânico). Verifique o motivo e toque em "
                                 "\"Rearmar\" no topo da tela para liberar.");
    showModal(title, body, nullptr, C_LINE, UiRequest{});
    return;
  }
  bool willOpen = !s_last.valveOpen[i];
  snprintf(title, sizeof(title), "%s a água: %s?", willOpen ? "Abrir" : "Fechar", VALVE_LABEL[i]);
  if (i == 6)
    snprintf(body, sizeof(body), willOpen ? "Libera a água para toda a casa." :
                                            "Corta a água de TODA a casa (válvula geral de emergência).");
  else
    snprintf(body, sizeof(body), willOpen ? "A água volta a chegar neste ramal." :
                                            "Este ramal fica sem água até você abrir de novo.");
  showModal(title, body, willOpen ? "Abrir" : "Fechar", willOpen ? lv_color_hex(0x15803D) : lv_color_hex(0xB45309),
            UiRequest{ UI_REQ_SET_VALVE, (int8_t)i, willOpen, false });
}

static void onRearm(lv_event_t *) {
  showModal("Rearmar o sistema?",
            "Confirme que o vazamento foi resolvido. Todos os alarmes serão liberados e TODAS as válvulas reabertas.",
            "Rearmar", lv_color_hex(0x15803D), UiRequest{ UI_REQ_RESET, -1, true, false });
}

static void panicTick(lv_timer_t *) {
  if (!s_panicPressAt || s_panicFired) return;
  uint32_t held = lv_tick_elaps(s_panicPressAt);
  if (held >= 2000) {
    s_panicFired = true;
    lv_label_set_text(panicLabel, "FECHANDO TUDO...");
    if (s_req) s_req(UiRequest{ UI_REQ_PANIC, -1, false, false });
  } else {
    char b[48];
    snprintf(b, sizeof(b), "Segure... %.1f s", (2000 - held) / 1000.0f);
    for (char *p = b; *p; p++) if (*p == '.') *p = ',';
    lv_label_set_text(panicLabel, b);
  }
}

static void onPanic(lv_event_t *e) {
  lv_event_code_t code = lv_event_get_code(e);
  if (code == LV_EVENT_PRESSED) {
    s_panicPressAt = lv_tick_get();
    s_panicFired = false;
    if (!s_panicTimer) s_panicTimer = lv_timer_create(panicTick, 100, nullptr);
  } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
    s_panicPressAt = 0;
    if (s_panicTimer) { lv_timer_del(s_panicTimer); s_panicTimer = nullptr; }
    lv_label_set_text(panicLabel, s_panicFired ? "TUDO FECHADO" : "FECHAR TUDO");
  }
}

// ---- montagem da tela ----
static void build() {
  lv_obj_t *scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, C_BG, 0);
  lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

  // cabeçalho (vira faixa de alarme)
  hdr = box(scr, 0, 0, 800, 56, C_CARD, C_CARD);
  lv_obj_set_style_radius(hdr, 0, 0);
  hdrTitle = text(hdr, &nh_font_24, C_TEXT, "Água da casa");
  lv_label_set_long_mode(hdrTitle, LV_LABEL_LONG_DOT);
  lv_obj_set_width(hdrTitle, 600);
  lv_obj_align(hdrTitle, LV_ALIGN_LEFT_MID, 18, 0);
  chipWifi = text(hdr, &nh_font_16, C_MUTED, "Wi-Fi");
  lv_obj_align(chipWifi, LV_ALIGN_RIGHT_MID, -150, 0);
  chipBus = text(hdr, &nh_font_16, C_MUTED, "Sensores");
  lv_obj_align(chipBus, LV_ALIGN_RIGHT_MID, -18, 0);
  btnRearm = lv_btn_create(hdr);
  lv_obj_set_size(btnRearm, 150, 42);
  lv_obj_align(btnRearm, LV_ALIGN_RIGHT_MID, -8, 0);
  lv_obj_set_style_bg_color(btnRearm, lv_color_hex(0x15803D), 0);
  lv_obj_set_style_radius(btnRearm, 10, 0);
  lv_obj_t *rl = text(btnRearm, &nh_font_20, C_TEXT, "Rearmar");
  lv_obj_center(rl);
  lv_obj_add_event_cb(btnRearm, onRearm, LV_EVENT_CLICKED, nullptr);
  lv_obj_add_flag(btnRearm, LV_OBJ_FLAG_HIDDEN);

  // reservatórios
  lv_obj_t *tank = box(scr, 12, 64, 220, 340, C_CARD, C_LINE);
  lv_obj_t *tt = text(tank, &nh_font_20, C_TEXT, "Reservatórios");
  lv_obj_set_pos(tt, 16, 12);
  tankBar = lv_bar_create(tank);
  lv_obj_set_size(tankBar, 64, 240);
  lv_obj_set_pos(tankBar, 18, 50);
  lv_bar_set_range(tankBar, 0, 100);
  lv_obj_set_style_bg_color(tankBar, lv_color_hex(0x0E2238), LV_PART_MAIN);
  lv_obj_set_style_bg_color(tankBar, C_WATER, LV_PART_INDICATOR);
  lv_obj_set_style_radius(tankBar, 10, LV_PART_MAIN);
  lv_obj_set_style_radius(tankBar, 6, LV_PART_INDICATOR);
  tankPct = text(tank, &nh_font_48, C_TEXT, "--%");
  lv_obj_set_pos(tankPct, 92, 96);
  tankLiters = text(tank, &nh_font_16, C_MUTED, "-- L\nde 1000 L");
  lv_obj_set_pos(tankLiters, 96, 160);
  tankNote = text(tank, &nh_font_16, C_MUTED, "");
  lv_label_set_long_mode(tankNote, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(tankNote, 190);
  lv_obj_set_pos(tankNote, 16, 300);

  // válvulas (4 × 2)
  for (int i = 0; i < 8; i++) {
    int c = i % 4, r = i / 4;
    tile[i] = box(scr, 244 + c * 136, 64 + r * 178, 128, 162, C_SHUT_BG, C_LINE);
    lv_obj_add_flag(tile[i], LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(tile[i], onTile, LV_EVENT_CLICKED, (void *)(intptr_t)i);
    lv_obj_t *n = text(tile[i], &nh_font_20, C_TEXT, VALVE_LABEL[i]);
    lv_label_set_long_mode(n, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(n, 112);
    lv_obj_set_pos(n, 10, 10);
    tileState[i] = text(tile[i], &nh_font_20, C_SHUT, "--");
    lv_obj_set_pos(tileState[i], 10, 78);
    tileFlow[i] = text(tile[i], &nh_font_16, C_MUTED, "");
    lv_obj_set_pos(tileFlow[i], 10, 122);
  }

  // rodapé: consumo + pânico
  nowLabel = text(scr, &nh_font_20, C_TEXT, "Agora: -- L/min");
  lv_obj_set_pos(nowLabel, 16, 416);
  totalLabel = text(scr, &nh_font_16, C_MUTED, "Total medido: -- L");
  lv_obj_set_pos(totalLabel, 16, 446);
  panicBtn = lv_btn_create(scr);
  lv_obj_set_pos(panicBtn, 476, 412);
  lv_obj_set_size(panicBtn, 312, 60);
  lv_obj_set_style_bg_color(panicBtn, lv_color_hex(0xB91C1C), 0);
  lv_obj_set_style_radius(panicBtn, 14, 0);
  panicLabel = text(panicBtn, &nh_font_20, C_TEXT, "FECHAR TUDO");
  lv_obj_align(panicLabel, LV_ALIGN_CENTER, 0, -9);
  lv_obj_t *ph = text(panicBtn, &nh_font_16, lv_color_hex(0xFECACA), "segure 2 segundos");
  lv_obj_align(ph, LV_ALIGN_CENTER, 0, 13);
  lv_obj_add_event_cb(panicBtn, onPanic, LV_EVENT_PRESSED, nullptr);
  lv_obj_add_event_cb(panicBtn, onPanic, LV_EVENT_RELEASED, nullptr);
  lv_obj_add_event_cb(panicBtn, onPanic, LV_EVENT_PRESS_LOST, nullptr);
}

bool ui_begin(UiRequestFn onRequest) {
  s_req = onRequest;
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
  char b[96], n[16];

  // cabeçalho / alarme
  bool alarm = s.alarmBurst || s.alarmExternal || s.panic;
  lv_obj_set_style_bg_color(hdr, alarm ? C_ALARM_BG : C_CARD, 0);
  lv_obj_set_style_border_color(hdr, alarm ? C_ALARM : C_CARD, 0);
  lv_obj_set_style_text_font(hdrTitle, alarm ? &nh_font_20 : &nh_font_24, 0);
  if (s.panic)              lv_label_set_text(hdrTitle, "PÂNICO: toda a água foi fechada");
  else if (s.alarmBurst)    lv_label_set_text(hdrTitle, "Possível rompimento: geral fechada");
  else if (s.alarmExternal) lv_label_set_text(hdrTitle, "Vazamento externo: Área Externa fechada");
  else                      lv_label_set_text(hdrTitle, "Água da casa");
  if (alarm) {
    lv_obj_clear_flag(btnRearm, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(chipWifi, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(chipBus, LV_OBJ_FLAG_HIDDEN);
  } else {
    lv_obj_add_flag(btnRearm, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(chipWifi, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(chipBus, LV_OBJ_FLAG_HIDDEN);
  }
  lv_label_set_text(chipWifi, s.wifiOk ? "Wi-Fi: ok" : "Wi-Fi: sem rede");
  lv_obj_set_style_text_color(chipWifi, s.wifiOk ? C_OPEN : C_WARN, 0);
  bool busOk = s.sondaOk && s.countersOk && s.relaysOk;
  lv_label_set_text(chipBus, busOk ? "Sensores: ok" : "Sensores: falha");
  lv_obj_set_style_text_color(chipBus, busOk ? C_OPEN : C_WARN, 0);

  // reservatórios
  if (s.sondaOk) {
    int pct = (int)(s.levelPct + 0.5f);
    lv_bar_set_value(tankBar, pct, LV_ANIM_ON);
    lv_obj_set_style_bg_color(tankBar, pct < 20 ? C_ALARM : (pct < 40 ? C_WARN : C_WATER), LV_PART_INDICATOR);
    snprintf(b, sizeof(b), "%d%%", pct);
    lv_label_set_text(tankPct, b);
    snprintf(b, sizeof(b), "%.0f L\nde 1000 L", s.volumeL);
    lv_label_set_text(tankLiters, b);
    lv_label_set_text(tankNote, pct < 20 ? "Nível muito baixo" : (pct < 40 ? "Nível baixo" : "Nível normal"));
    lv_obj_set_style_text_color(tankNote, pct < 20 ? C_ALARM : (pct < 40 ? C_WARN : C_OPEN), 0);
  } else {
    lv_label_set_text(tankPct, "--%");
    lv_label_set_text(tankLiters, "sem leitura");
    lv_label_set_text(tankNote, "Sonda sem sinal: verifique o cabo RS-485");
    lv_obj_set_style_text_color(tankNote, C_WARN, 0);
  }

  // válvulas
  float sum = 0;
  for (int i = 0; i < 7; i++) sum += s.flowLpm[i];
  for (int i = 0; i < 8; i++) {
    bool blk = s.blocked[i], open = s.valveOpen[i];
    lv_obj_set_style_bg_color(tile[i], blk ? C_ALARM_BG : (open ? C_OPEN_BG : C_SHUT_BG), 0);
    lv_obj_set_style_border_color(tile[i], blk ? C_ALARM : (open ? C_OPEN : C_LINE), 0);
    lv_label_set_text(tileState[i], blk ? "TRAVADA" : (open ? "ABERTA" : "FECHADA"));
    lv_obj_set_style_text_color(tileState[i], blk ? C_ALARM : (open ? C_OPEN : C_SHUT), 0);
    float f = i < 6 ? s.flowLpm[i] : (i == 6 ? sum : s.flowLpm[6]);
    if (!s.countersOk) lv_label_set_text(tileFlow[i], "vazão: --");
    else if (f < 0.05f) lv_label_set_text(tileFlow[i], "parado");
    else { fmt1(n, sizeof(n), f); snprintf(b, sizeof(b), "%s L/min", n); lv_label_set_text(tileFlow[i], b); }
  }

  // rodapé
  if (s.countersOk) { fmt1(n, sizeof(n), sum); snprintf(b, sizeof(b), "Agora: %s L/min", n); }
  else snprintf(b, sizeof(b), "Agora: medidores sem sinal");
  lv_label_set_text(nowLabel, b);
  snprintf(b, sizeof(b), "Total medido: %.0f L", s.totalL);
  lv_label_set_text(totalLabel, b);
  lvgl_port_unlock();
}

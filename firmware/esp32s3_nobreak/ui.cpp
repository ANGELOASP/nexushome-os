// ============================================================
// NexusHome OS — Tela touch do nobreak (ver ui.h)
//
//  ┌──────────────────────────────────────────────────────────────────┐
//  │ Nobreak — banco LiFePO4               Wi-Fi: ok    Medidores 3/3 │ ← VERMELHO na falta de energia,
//  ├────────────────────┬─────────────────────────────────────────────┤   bateria crítica ou tensão baixa;
//  │ Bateria    200 Ah  │ Fluxo de energia                            │   âmbar com bateria baixa ou
//  │  87 %              │ ┌──────┐    ┌────────┐    ┌──────┐          │   medidor sem resposta
//  │ ██████████████░░░  │ │ Rede │ ─► │Inversor│ ─► │ Casa │          │
//  │ 26,40 V · 12,3 A   │ │1,2 kW│    │na rede │    │430 W │          │
//  │ Carregando · 325 W │ └──────┘    └───┬────┘    └──────┘          │
//  │ ────────────────── │       Bateria: carregando 325 W             │
//  │ Autonomia          │ Rede OK                                     │
//  │  —                 ├─────────────────────────────────────────────┤
//  │ rede presente: a   │ Medidores (barramento D)                    │
//  │ bateria é reserva  │ PZEM-017 · 41 · Banco 24 V            ok    │
//  │ (toque: detalhes)  │ PZEM-016 · 42 · Entrada da rede       ok    │
//  └────────────────────┴─────────────────────────────────────────────┘
// ============================================================
#include <Arduino.h>
#include <esp_display_panel.hpp>
#include <lvgl.h>
#include "lvgl_v8_port.h"
#include "ui.h"

LV_FONT_DECLARE(nh_font_16);
LV_FONT_DECLARE(nh_font_20);
LV_FONT_DECLARE(nh_font_24);
LV_FONT_DECLARE(nh_font_48);   // só " %,-./0-9KLWhk": SoC ("87 %") e autonomia ("9,8 h")

using namespace esp_panel::board;

// ---- paleta (a mesma da tela da água e da energia) ----
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

static UiRequestFn s_req = nullptr;
static const UiMeter *s_m = nullptr;
static int s_n = 0;
static UiState s_last;
static bool s_haveState = false;

static lv_obj_t *hdr, *hdrTitle, *chipWifi, *chipBus;
static lv_obj_t *socValue, *socBar, *battVA, *battMode, *autoValue, *autoNote;
static lv_obj_t *boxGrid, *gridValue, *gridSub, *boxInv, *invValue, *invSub, *boxHouse, *houseValue, *houseSub;
static lv_obj_t *arrow1[2], *arrow2[2], *battLink, *battLinkText, *flowState;
static lv_obj_t *meterName[UI_METERS], *meterVals[UI_METERS], *meterSt[UI_METERS];
static lv_obj_t *modal = nullptr;
static UiRequest s_pending;

// pontos das setas (o lv_line guarda o ponteiro: precisam ser estáticos)
static lv_point_t a1Body[2], a1Head[3], a2Body[2], a2Head[3], linkPts[2];

// ---- utilidades ----
static void comma(char *s) { for (char *p = s; *p; p++) if (*p == '.') *p = ','; }

// 640 → "640 W" · 1234 → "1,2 kW"
static void fmtW(char *out, size_t n, float w) {
  if (w < 0) w = 0;
  if (w < 999.5f) snprintf(out, n, "%.0f W", w);
  else { snprintf(out, n, "%.1f kW", w / 1000.0f); comma(out); }
}

// só redesenha quando o texto muda (a tela atualiza ~3 vezes por segundo)
static void setText(lv_obj_t *l, const char *s) {
  const char *cur = lv_label_get_text(l);
  if (!cur || strcmp(cur, s)) lv_label_set_text(l, s);
}

static void setFont(lv_obj_t *l, const lv_font_t *f) {
  if (lv_obj_get_style_text_font(l, LV_PART_MAIN) != f) lv_obj_set_style_text_font(l, f, 0);
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
  lv_obj_set_style_bg_color(b, C_ON, LV_PART_INDICATOR);
  lv_obj_set_style_radius(b, 8, LV_PART_MAIN);
  lv_obj_set_style_radius(b, 8, LV_PART_INDICATOR);
  return b;
}

static lv_obj_t *line(lv_obj_t *parent, lv_point_t *pts, uint16_t n, int width) {
  lv_obj_t *l = lv_line_create(parent);
  lv_line_set_points(l, pts, n);
  lv_obj_set_style_line_width(l, width, 0);
  lv_obj_set_style_line_rounded(l, true, 0);
  lv_obj_set_style_line_color(l, C_LINE, 0);
  return l;
}

// seta horizontal de x1 a x2 na altura y (corpo + ponta)
static void arrow(lv_obj_t *parent, lv_obj_t **out, lv_point_t *body, lv_point_t *head, int x1, int x2, int y) {
  body[0] = { (lv_coord_t)x1, (lv_coord_t)y };
  body[1] = { (lv_coord_t)x2, (lv_coord_t)y };
  head[0] = { (lv_coord_t)(x2 - 9), (lv_coord_t)(y - 8) };
  head[1] = { (lv_coord_t)x2, (lv_coord_t)y };
  head[2] = { (lv_coord_t)(x2 - 9), (lv_coord_t)(y + 8) };
  out[0] = line(parent, body, 2, 4);
  out[1] = line(parent, head, 3, 4);
}

static void colorArrow(lv_obj_t **a, lv_color_t c) {
  for (int k = 0; k < 2; k++) lv_obj_set_style_line_color(a[k], c, 0);
}

static void colorBox(lv_obj_t *b, lv_color_t bg, lv_color_t border) {
  lv_obj_set_style_bg_color(b, bg, 0);
  lv_obj_set_style_border_color(b, border, 0);
}

static lv_color_t levelColor(uint8_t level) { return level >= 2 ? C_ALARM : (level == 1 ? C_WARN : C_ON); }

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
  lv_obj_set_pos(b, x, 222);
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

  lv_obj_t *card = box(modal, 120, 86, 560, 300, C_CARD, C_LINE);
  lv_obj_t *t = text(card, &nh_font_24, C_TEXT, title);
  lv_label_set_long_mode(t, LV_LABEL_LONG_DOT);
  lv_obj_set_width(t, 516);
  lv_obj_set_pos(t, 22, 18);
  lv_obj_t *b = text(card, &nh_font_16, C_TEXT, body);
  lv_label_set_long_mode(b, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(b, 516);
  lv_obj_set_pos(b, 22, 58);
  if (note && note[0]) {
    lv_obj_t *n = text(card, &nh_font_16, noteColor, note);
    lv_label_set_long_mode(n, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(n, 516);
    lv_obj_set_pos(n, 22, 150);
  }
  if (okLabel) {
    modalButton(card, 22, 246, "Cancelar", C_LINE, onModalCancel);
    modalButton(card, 288, 250, okLabel, okColor, onModalOk);
  } else {
    modalButton(card, 288, 250, "Fechar", C_LINE, onModalCancel);
  }
}

// ---- eventos ----
// toque na bateria: detalhes + "Marcar 100 %" (recalibração manual com o banco cheio)
static void onBattery(lv_event_t *) {
  if (!s_haveState) return;
  const UiState &s = s_last;
  char body[300], note[220], w[16], soc[12], v[16], a[16], nv[12];
  snprintf(soc, sizeof(soc), "%.1f", s.soc); comma(soc);
  snprintf(nv, sizeof(nv), "%.1f", s.bankV); comma(nv);
  if (s.battOk) {
    fmtW(w, sizeof(w), s.battW);
    snprintf(v, sizeof(v), "%.2f V", s.battV); comma(v);
    snprintf(a, sizeof(a), "%.1f A", s.battA); comma(a);
    snprintf(body, sizeof(body),
             "Carga estimada: %s %% (contagem de Ah)\nBanco: %s  ·  %s  ·  %s  ·  %s\n"
             "Capacidade: %.0f Ah em %s V",
             soc, v, a, w, s.discharging ? "descarregando" : "carregando ou em repouso", s.bankAh, nv);
  } else {
    snprintf(body, sizeof(body), "PZEM-017 (banco) sem resposta no barramento D.\n"
                                 "Confira o cabo A/B, o fusível de 1 A da tensão do banco e o endereço 41.\n"
                                 "Carga estimada (última contagem): %s %%", soc);
  }
  snprintf(note, sizeof(note), "O SoC volta sozinho a 100 %% com 27,6 V e menos de 5 A por 10 min. "
                               "Use \"Marcar 100 %%\" só se o banco acabou de carregar por completo.");
  showModal("Bateria do nobreak", body, note, C_MUTED, "Marcar 100 %", lv_color_hex(0x15803D),
            UiRequest{ UI_REQ_SET_SOC, 100.0f });
}

// ---- montagem da tela ----
static lv_obj_t *flowBox(lv_obj_t *parent, int x, const char *name, lv_obj_t **value, lv_obj_t **sub) {
  lv_obj_t *b = box(parent, x, 46, 128, 96, C_OFF_BG, C_LINE);
  lv_obj_set_style_radius(b, 12, 0);
  lv_obj_t *n = text(b, &nh_font_16, C_MUTED, name);
  lv_obj_set_pos(n, 10, 8);
  *value = text(b, &nh_font_24, C_TEXT, "--");
  lv_label_set_long_mode(*value, LV_LABEL_LONG_DOT);
  lv_obj_set_width(*value, 110);
  lv_obj_set_pos(*value, 10, 32);
  *sub = text(b, &nh_font_16, C_MUTED, "");
  lv_label_set_long_mode(*sub, LV_LABEL_LONG_DOT);
  lv_obj_set_width(*sub, 110);
  lv_obj_set_pos(*sub, 10, 66);
  return b;
}

static void build() {
  lv_obj_t *scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, C_BG, 0);
  lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

  // cabeçalho (vira faixa de alarme)
  hdr = box(scr, 0, 0, 800, 56, C_CARD, C_CARD);
  lv_obj_set_style_radius(hdr, 0, 0);
  hdrTitle = text(hdr, &nh_font_24, C_TEXT, "Nobreak — banco LiFePO4");
  lv_label_set_long_mode(hdrTitle, LV_LABEL_LONG_DOT);
  lv_obj_set_width(hdrTitle, 500);
  lv_obj_align(hdrTitle, LV_ALIGN_LEFT_MID, 18, 0);
  chipWifi = text(hdr, &nh_font_16, C_MUTED, "Wi-Fi");
  lv_obj_align(chipWifi, LV_ALIGN_RIGHT_MID, -170, 0);
  chipBus = text(hdr, &nh_font_16, C_MUTED, "Medidores");
  lv_obj_align(chipBus, LV_ALIGN_RIGHT_MID, -18, 0);

  // ---- bateria (esquerda; toque = detalhes) ----
  lv_obj_t *left = box(scr, 12, 64, 300, 404, C_CARD, C_LINE);
  lv_obj_add_flag(left, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(left, onBattery, LV_EVENT_CLICKED, nullptr);
  lv_obj_t *lt = text(left, &nh_font_20, C_TEXT, "Bateria");
  lv_obj_set_pos(lt, 16, 12);
  lv_obj_t *cap = text(left, &nh_font_16, C_MUTED, "LiFePO4 24 V");
  lv_obj_align(cap, LV_ALIGN_TOP_RIGHT, -16, 15);
  socValue = text(left, &nh_font_48, C_TEXT, "--");
  lv_obj_set_pos(socValue, 14, 40);
  socBar = bar(left, 16, 106, 268, 28);
  battVA = text(left, &nh_font_24, C_TEXT, "--");
  lv_obj_set_pos(battVA, 16, 146);
  battMode = text(left, &nh_font_16, C_MUTED, "");
  lv_label_set_long_mode(battMode, LV_LABEL_LONG_DOT);
  lv_obj_set_width(battMode, 268);
  lv_obj_set_pos(battMode, 16, 180);
  lv_obj_t *sep = box(left, 16, 212, 268, 2, C_LINE, C_LINE);
  lv_obj_set_style_radius(sep, 0, 0);
  lv_obj_t *at = text(left, &nh_font_20, C_TEXT, "Autonomia");
  lv_obj_set_pos(at, 16, 226);
  autoValue = text(left, &nh_font_24, C_TEXT, "—");
  lv_obj_set_pos(autoValue, 14, 256);
  autoNote = text(left, &nh_font_16, C_MUTED, "");
  lv_label_set_long_mode(autoNote, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(autoNote, 268);
  lv_obj_set_pos(autoNote, 16, 318);

  // ---- fluxo Rede → Inversor → Casa (direita, em cima) ----
  lv_obj_t *flow = box(scr, 324, 64, 464, 228, C_CARD, C_LINE);
  lv_obj_t *ft = text(flow, &nh_font_20, C_TEXT, "Fluxo de energia");
  lv_obj_set_pos(ft, 16, 10);
  boxGrid = flowBox(flow, 16, "Rede", &gridValue, &gridSub);
  boxInv = flowBox(flow, 166, "Inversor", &invValue, &invSub);
  boxHouse = flowBox(flow, 316, "Casa (QDC)", &houseValue, &houseSub);
  arrow(flow, arrow1, a1Body, a1Head, 148, 162, 94);
  arrow(flow, arrow2, a2Body, a2Head, 298, 312, 94);
  linkPts[0] = { 230, 144 };
  linkPts[1] = { 230, 160 };
  battLink = line(flow, linkPts, 2, 4);
  battLinkText = text(flow, &nh_font_16, C_MUTED, "");
  lv_label_set_long_mode(battLinkText, LV_LABEL_LONG_DOT);
  lv_obj_set_width(battLinkText, 300);
  lv_obj_set_style_text_align(battLinkText, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_pos(battLinkText, 80, 162);
  flowState = text(flow, &nh_font_20, C_MUTED, "");
  lv_label_set_long_mode(flowState, LV_LABEL_LONG_DOT);
  lv_obj_set_width(flowState, 432);
  lv_obj_set_pos(flowState, 16, 190);

  // ---- medidores (direita, embaixo) ----
  lv_obj_t *mc = box(scr, 324, 300, 464, 168, C_CARD, C_LINE);
  lv_obj_t *mt = text(mc, &nh_font_16, C_MUTED, "Medidores (barramento D, 9600 bps)");
  lv_obj_set_pos(mt, 16, 8);
  for (int k = 0; k < s_n; k++) {
    int y = 32 + k * 44;
    char b[64];
    snprintf(b, sizeof(b), "%s · %u · %s", s_m[k].model, s_m[k].addr, s_m[k].role);
    meterName[k] = text(mc, &nh_font_16, C_TEXT, b);
    lv_label_set_long_mode(meterName[k], LV_LABEL_LONG_DOT);
    lv_obj_set_width(meterName[k], 300);
    lv_obj_set_pos(meterName[k], 16, y);
    meterVals[k] = text(mc, &nh_font_16, C_MUTED, "");
    lv_label_set_long_mode(meterVals[k], LV_LABEL_LONG_DOT);
    lv_obj_set_width(meterVals[k], 300);
    lv_obj_set_pos(meterVals[k], 16, y + 19);
    meterSt[k] = text(mc, &nh_font_16, C_MUTED, "--");
    lv_obj_align(meterSt[k], LV_ALIGN_TOP_RIGHT, -16, y + 10);
  }
}

bool ui_begin(const UiMeter *meters, int count, UiRequestFn onRequest) {
  s_req = onRequest;
  s_m = meters;
  s_n = count > UI_METERS ? UI_METERS : count;
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
  char b[128], w[24], w2[24];
  int socPct = (int)(s.soc + 0.5f);

  // ---- cabeçalho: falta de energia / bateria crítica / tensão baixa (vermelho) >
  //      bateria baixa / medidor sem resposta (âmbar) > normal ----
  int offline = -1;
  for (int k = 0; k < s_n; k++)
    if (!s.meterOk[k] && !(k == 1 && s.gridFail)) { offline = k; break; }   // 42 mudo na falta é esperado
  bool red = s.gridFail || s.socLevel >= 2 || s.battLowV;
  bool amber = !red && (s.socLevel == 1 || offline >= 0);
  if (s.gridFail) snprintf(b, sizeof(b), "FALTA DE ENERGIA — casa no inversor (bateria %d %%)", socPct);
  else if (s.socLevel >= 2) snprintf(b, sizeof(b), "Bateria crítica: %d %%", socPct);
  else if (s.battLowV) { snprintf(b, sizeof(b), "Tensão do banco baixa: %.1f V", s.battV); comma(b); }
  else if (s.socLevel == 1) snprintf(b, sizeof(b), "Bateria baixa: %d %%", socPct);
  else if (offline >= 0) snprintf(b, sizeof(b), "Sem resposta: %s %u (%s)", s_m[offline].model, s_m[offline].addr, s_m[offline].role);
  else snprintf(b, sizeof(b), "Nobreak — banco LiFePO4");
  lv_obj_set_style_bg_color(hdr, red ? C_ALARM_BG : (amber ? C_WARN_BG : C_CARD), 0);
  lv_obj_set_style_border_color(hdr, red ? C_ALARM : (amber ? C_WARN : C_CARD), 0);
  setFont(hdrTitle, (red || amber) ? &nh_font_20 : &nh_font_24);
  setText(hdrTitle, b);
  setText(chipWifi, s.wifiOk ? "Wi-Fi: ok" : "Wi-Fi: sem rede");
  lv_obj_set_style_text_color(chipWifi, s.wifiOk ? C_ON : C_WARN, 0);
  snprintf(b, sizeof(b), "Medidores %d/%d", s.metersOk, s_n);
  setText(chipBus, b);
  lv_obj_set_style_text_color(chipBus, s.metersOk == s_n ? C_ON : (s.gridFail && s.metersOk == s_n - 1 ? C_MUTED : C_WARN), 0);

  // ---- bateria ----
  snprintf(b, sizeof(b), "%d %%", socPct);
  setText(socValue, b);
  lv_obj_set_style_text_color(socValue, s.socLevel ? levelColor(s.socLevel) : C_TEXT, 0);
  lv_bar_set_value(socBar, socPct < 0 ? 0 : (socPct > 100 ? 100 : socPct), LV_ANIM_ON);
  lv_obj_set_style_bg_color(socBar, levelColor(s.socLevel), LV_PART_INDICATOR);
  if (s.battOk) {
    snprintf(b, sizeof(b), "%.2f V · %.1f A", s.battV, s.battA);
    comma(b);
    setText(battVA, b);
    lv_obj_set_style_text_color(battVA, s.battLowV ? C_ALARM : C_TEXT, 0);
    fmtW(w, sizeof(w), s.battW);
    if (s.battA < 0.5f) snprintf(b, sizeof(b), "Em repouso");
    else snprintf(b, sizeof(b), "%s · %s", s.discharging ? "Descarregando" : "Carregando", w);
    setText(battMode, b);
    lv_obj_set_style_text_color(battMode, s.discharging && s.battA >= 0.5f ? C_WARN : C_MUTED, 0);
  } else {
    setText(battVA, "--");
    lv_obj_set_style_text_color(battVA, C_MUTED, 0);
    setText(battMode, "PZEM-017 sem resposta (SoC parado)");
    lv_obj_set_style_text_color(battMode, C_WARN, 0);
  }

  // ---- autonomia (só na falta de energia) ----
  if (s.gridFail && s.autonomyH >= 0) {
    if (s.autonomyH < 10) snprintf(b, sizeof(b), "%.1f h", s.autonomyH);
    else snprintf(b, sizeof(b), "%.0f h", s.autonomyH);
    comma(b);
    setFont(autoValue, &nh_font_48);
    setText(autoValue, b);
    lv_obj_set_style_text_color(autoValue, s.autonomyH < 1 ? C_ALARM : (s.autonomyH < 3 ? C_WARN : C_TEXT), 0);
    fmtW(w, sizeof(w), s.avgOutW);
    snprintf(b, sizeof(b), "com a carga média de %s (últimos 10 min), até o corte em 24,0 V", w);
  } else {
    setFont(autoValue, &nh_font_24);
    setText(autoValue, "—");
    lv_obj_set_style_text_color(autoValue, C_MUTED, 0);
    if (s.gridFail) snprintf(b, sizeof(b), "sem estimativa: falta a leitura da saída do inversor (PZEM-016 43)");
    else snprintf(b, sizeof(b), "rede presente: a bateria fica de reserva.\nToque para os detalhes.");
  }
  setText(autoNote, b);

  // ---- fluxo ----
  if (s.gridFail) {
    setText(gridValue, "FALTA");
    if (s.gridMeterOk) { snprintf(w2, sizeof(w2), "%.0f V", s.gridV); setText(gridSub, w2); }
    else setText(gridSub, "sem tensão");
    colorBox(boxGrid, C_ALARM_BG, C_ALARM);
    lv_obj_set_style_text_color(gridValue, C_ALARM, 0);
    colorArrow(arrow1, C_ALARM);
  } else if (s.gridMeterOk) {
    fmtW(w, sizeof(w), s.gridW);
    setText(gridValue, w);
    snprintf(w2, sizeof(w2), "%.0f V · %.0f Hz", s.gridV, s.gridHz);
    setText(gridSub, w2);
    colorBox(boxGrid, C_ON_BG, C_ON);
    lv_obj_set_style_text_color(gridValue, C_TEXT, 0);
    colorArrow(arrow1, C_ON);
  } else {
    setText(gridValue, "--");
    setText(gridSub, "sem leitura");
    colorBox(boxGrid, C_OFF_BG, C_WARN);
    lv_obj_set_style_text_color(gridValue, C_MUTED, 0);
    colorArrow(arrow1, C_LINE);
  }
  setText(invValue, s.discharging ? "bateria" : "rede");
  lv_obj_set_style_text_color(invValue, s.discharging ? C_WARN : C_TEXT, 0);
  if (s.battOk) { snprintf(w2, sizeof(w2), "banco %.1f V", s.battV); comma(w2); setText(invSub, w2); }
  else setText(invSub, "banco: --");
  colorBox(boxInv, s.discharging ? C_WARN_BG : C_OFF_BG, s.discharging ? C_WARN : C_LINE);
  if (s.outOk) {
    fmtW(w, sizeof(w), s.outW);
    setText(houseValue, w);
    snprintf(w2, sizeof(w2), "%.0f V", s.outV);
    setText(houseSub, w2);
    colorBox(boxHouse, C_OFF_BG, s.outV >= 180 ? C_ENERGY : C_ALARM);
    colorArrow(arrow2, s.outV >= 180 ? C_ENERGY : C_ALARM);
  } else {
    setText(houseValue, "--");
    setText(houseSub, "sem leitura");
    colorBox(boxHouse, C_OFF_BG, C_WARN);
    colorArrow(arrow2, C_LINE);
  }
  fmtW(w, sizeof(w), s.battW);
  if (!s.battOk) snprintf(b, sizeof(b), "Bateria: sem leitura");
  else if (s.battA < 0.5f) snprintf(b, sizeof(b), "Bateria: em repouso");
  else snprintf(b, sizeof(b), "Bateria: %s %s", s.discharging ? "descarregando" : "carregando", w);
  setText(battLinkText, b);
  lv_obj_set_style_line_color(battLink, s.discharging ? C_WARN : (s.battA >= 0.5f ? C_ON : C_LINE), 0);
  if (s.gridFail) {
    setText(flowState, "FALTA DE ENERGIA — casa na bateria");
    lv_obj_set_style_text_color(flowState, C_ALARM, 0);
  } else if (s.discharging) {
    setText(flowState, "Rede OK — inversor usando a bateria");
    lv_obj_set_style_text_color(flowState, C_WARN, 0);
  } else if (s.gridMeterOk) {
    setText(flowState, "Rede OK");
    lv_obj_set_style_text_color(flowState, C_ON, 0);
  } else {
    setText(flowState, "Rede: sem leitura");
    lv_obj_set_style_text_color(flowState, C_WARN, 0);
  }

  // ---- medidores ----
  for (int k = 0; k < s_n; k++) {
    bool ok = s.meterOk[k];
    if (k == 0) {
      if (ok) { snprintf(b, sizeof(b), "%.2f V · %.1f A", s.battV, s.battA); comma(b); }
      else snprintf(b, sizeof(b), "--");
    } else if (k == 1) {
      if (ok) { fmtW(w, sizeof(w), s.gridW); snprintf(b, sizeof(b), "%.0f V · %s · %.1f Hz", s.gridV, w, s.gridHz); comma(b); }
      else snprintf(b, sizeof(b), s.gridFail ? "sem tensão da rede (normal na falta)" : "--");
    } else {
      if (ok) { fmtW(w, sizeof(w), s.outW); snprintf(b, sizeof(b), "%.0f V · %s", s.outV, w); }
      else snprintf(b, sizeof(b), "--");
    }
    setText(meterVals[k], b);
    if (ok) {
      setText(meterSt[k], "ok");
      lv_obj_set_style_text_color(meterSt[k], C_ON, 0);
    } else if (k == 1 && s.gridFail) {
      setText(meterSt[k], "sem rede");
      lv_obj_set_style_text_color(meterSt[k], C_ALARM, 0);
    } else {
      setText(meterSt[k], "sem resposta");
      lv_obj_set_style_text_color(meterSt[k], C_WARN, 0);
    }
    lv_obj_align(meterSt[k], LV_ALIGN_TOP_RIGHT, -16, 32 + k * 44 + 10);
  }
  lvgl_port_unlock();
}

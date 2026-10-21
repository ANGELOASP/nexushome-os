// ============================================================
// NexusHome OS — Tela touch da Segurança (ver ui.h)
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │ Casa segura                      Alarme: Desarmado  Wi-Fi: ok │  ← VERDE normal · ÂMBAR aviso
//  ├──────────────┬──────────────┬──────────────┬─────────────────┤     (pré-alarme de gás, atraso,
//  │    Luzes     │  Ambientes   │ Gás e fumaça │     Alarme      │      fonte na bateria) · VERMELHO
//  ├──────────────┴──────────────┴──────────────┴─────────────────┤     (gás travado, fumaça, pânico,
//  │ [Sala de Estar] [Sala de TV] [Cozinha] [Quarto P.] [Quarto 2] │      alarme disparado). Tocar:
//  │   Acesa           Apagada      ...                            │      silenciar / ir para a aba
//  │ [Quarto 3] [Banheiro 1] [Banheiro 2] [Lavanderia] [Á. Externa]│
//  └──────────────────────────────────────────────────────────────┘
//  Luzes: estado REAL (retorno), toque alterna · Ambientes: T/UR/presença (banheiro: exaustor)
//  Gás e fumaça: % LEL, válvula, "segure 2 s para rearmar" · Alarme: modos com confirmação, silenciar
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

// ---- paleta (a mesma das telas de água e energia) ----
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
#define C_LAMP_BG   lv_color_hex(0x3A3410)
#define C_LAMP      lv_color_hex(0xFDE047)
#define C_BTN_GO    lv_color_hex(0x15803D)
#define C_BTN_WARN  lv_color_hex(0xB45309)
#define C_BTN_STOP  lv_color_hex(0xB91C1C)

#define TABS 4
#define REARM_HOLD_MS 2000
enum { TAB_LIGHTS = 0, TAB_ROOMS, TAB_GAS, TAB_ALARM };
static const char *const TAB_NAMES[TABS] = { "Luzes", "Ambientes", "Gás e fumaça", "Alarme" };
static const char *const ARM_LABEL[3] = { "Desarmado", "Em casa", "Ausente" };

static UiRequestFn s_req = nullptr;
static UiConfig s_cfg;
static UiState s_last;
static bool s_haveState = false;
static int s_tab = 0;

static lv_obj_t *hdr, *hdrTitle, *chipAlarm, *chipWifi;
static lv_obj_t *tabBtn[TABS], *tabLabel[TABS], *panel[TABS];
// luzes
static lv_obj_t *lTile[UI_LIGHTS], *lState[UI_LIGHTS], *lSub[UI_LIGHTS];
// ambientes
static lv_obj_t *rTile[UI_ROOMS], *rTemp[UI_ROOMS], *rHum[UI_ROOMS], *rPres[UI_ROOMS], *rNote[UI_ROOMS];
// gás e fumaça
static lv_obj_t *gValue[UI_GAS], *gBar[UI_GAS], *gStatus[UI_GAS], *gCard[UI_GAS];
static lv_obj_t *valveCard, *valveState, *valveLine, *btnValve, *btnValveLbl, *btnRearm, *rearmLbl, *rearmBar;
static lv_obj_t *smokeState[UI_SMOKE], *panicLbl, *f2Lbl, *battLbl, *sirenLbl;
static int8_t smokeRoom[UI_SMOKE];
// alarme
static lv_obj_t *aMode, *aStatus, *aBtn[3], *zoneFront, *zoneService, *zonePres[UI_ROOMS], *btnSilence, *btnSilenceLbl;
// aviso (toast) e diálogo
static lv_obj_t *toastBox, *toastLbl;
static uint32_t toastAt = 0;
static bool toastOn = false;
static uint16_t s_noticeSeq = 0;
static lv_obj_t *modal = nullptr;
#define MODAL_MAX 3
static UiRequest s_pending[MODAL_MAX];
static uint32_t rearmPressAt = 0;
static bool rearmFired = false;

// ---- utilidades ----
static void comma(char *s) { for (char *p = s; *p; p++) if (*p == '.') *p = ','; }

// só redesenha quando o texto/cor muda (a tela atualiza ~3 vezes por segundo)
static void setText(lv_obj_t *l, const char *s) {
  const char *cur = lv_label_get_text(l);
  if (!cur || strcmp(cur, s)) lv_label_set_text(l, s);
}
static void setTextColor(lv_obj_t *o, lv_color_t c) {
  if (lv_obj_get_style_text_color(o, 0).full != c.full) lv_obj_set_style_text_color(o, c, 0);
}
static void setBox(lv_obj_t *o, lv_color_t bg, lv_color_t border) {
  if (lv_obj_get_style_bg_color(o, 0).full != bg.full) lv_obj_set_style_bg_color(o, bg, 0);
  if (lv_obj_get_style_border_color(o, 0).full != border.full) lv_obj_set_style_border_color(o, border, 0);
}
static void setBarColor(lv_obj_t *b, lv_color_t c) {
  if (lv_obj_get_style_bg_color(b, LV_PART_INDICATOR).full != c.full) lv_obj_set_style_bg_color(b, c, LV_PART_INDICATOR);
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

static lv_obj_t *textAt(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, const char *s, int x, int y, int w) {
  lv_obj_t *l = text(parent, font, color, s);
  lv_obj_set_pos(l, x, y);
  if (w > 0) { lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP); lv_obj_set_width(l, w); }
  return l;
}

static lv_obj_t *bar(lv_obj_t *parent, int x, int y, int w, int h, int maxv) {
  lv_obj_t *b = lv_bar_create(parent);
  lv_obj_set_pos(b, x, y);
  lv_obj_set_size(b, w, h);
  lv_bar_set_range(b, 0, maxv);
  lv_obj_set_style_bg_color(b, lv_color_hex(0x0E2238), LV_PART_MAIN);
  lv_obj_set_style_bg_color(b, C_ENERGY, LV_PART_INDICATOR);
  lv_obj_set_style_radius(b, h / 2, LV_PART_MAIN);
  lv_obj_set_style_radius(b, h / 2, LV_PART_INDICATOR);
  return b;
}

static lv_obj_t *button(lv_obj_t *parent, int x, int y, int w, int h, lv_color_t bg, const char *label, lv_obj_t **lbl) {
  lv_obj_t *b = box(parent, x, y, w, h, bg, bg);
  lv_obj_set_style_radius(b, 12, 0);
  lv_obj_add_flag(b, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_t *l = text(b, &nh_font_20, C_TEXT, label);
  lv_label_set_long_mode(l, LV_LABEL_LONG_DOT);
  lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_width(l, w - 16);
  lv_obj_center(l);
  if (lbl) *lbl = l;
  return b;
}

// texto numa linha de até maxw px: abrevia a última palavra ("Quarto Principal" → "Quarto Princ.")
static void fitText(char *out, size_t n, const char *src, const lv_font_t *font, lv_coord_t maxw) {
  snprintf(out, n, "%s", src);
  lv_point_t sz;
  lv_txt_get_size(&sz, out, font, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
  char *sp = strrchr(out, ' ');
  while (sz.x > maxw && sp && strlen(sp + 1) > 3) {
    size_t len = strlen(out);
    if (out[len - 1] == '.') out[--len] = 0;
    out[len - 1] = '.';
    lv_txt_get_size(&sz, out, font, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
  }
}

static void send(const UiRequest &r) { if (s_req) s_req(r); }

// ---- aviso curto (some sozinho) ----
static void toast(const char *msg) {
  setText(toastLbl, msg);
  lv_obj_clear_flag(toastBox, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_foreground(toastBox);
  toastAt = lv_tick_get();
  toastOn = true;
}

// ---- diálogo (sempre por cima de tudo): "Cancelar" + até 3 ações ----
static void closeModal() { if (modal) { lv_obj_del(modal); modal = nullptr; } }

static void onModalBtn(lv_event_t *e) {
  int k = (int)(intptr_t)lv_event_get_user_data(e);
  UiRequest r = (k >= 0 && k < MODAL_MAX) ? s_pending[k] : UiRequest{};
  closeModal();
  if (r.type) send(r);
}

static void showModalN(const char *title, const char *body, const char *note, lv_color_t noteColor,
                       int n, const char *const *labels, const lv_color_t *colors, const UiRequest *reqs) {
  closeModal();
  if (n > MODAL_MAX) n = MODAL_MAX;
  for (int k = 0; k < MODAL_MAX; k++) s_pending[k] = k < n ? reqs[k] : UiRequest{};
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
  textAt(card, &nh_font_16, C_TEXT, body, 22, 60, 496);
  if (note && note[0]) textAt(card, &nh_font_16, noteColor, note, 22, 132, 496);
  // botões: [Cancelar] [ação 1] [ação 2] [ação 3] dividindo 496 px
  int cols = n + 1, w = (496 - (cols - 1) * 10) / cols;
  lv_obj_t *b = button(card, 22, 212, w, 56, C_LINE, n ? "Cancelar" : "Fechar", nullptr);
  lv_obj_add_event_cb(b, onModalBtn, LV_EVENT_CLICKED, (void *)(intptr_t)-1);
  for (int k = 0; k < n; k++) {
    b = button(card, 22 + (k + 1) * (w + 10), 212, w, 56, colors[k], labels[k], nullptr);
    lv_obj_add_event_cb(b, onModalBtn, LV_EVENT_CLICKED, (void *)(intptr_t)k);
  }
}

static void showModal(const char *title, const char *body, const char *note, lv_color_t noteColor,
                      const char *okLabel, lv_color_t okColor, UiRequest req) {
  showModalN(title, body, note, noteColor, okLabel ? 1 : 0, &okLabel, &okColor, &req);
}

// ---- abas ----
static void showTab(int t) {
  s_tab = t;
  for (int k = 0; k < TABS; k++) {
    lv_obj_set_style_bg_color(tabBtn[k], k == t ? C_TAB_ON : C_CARD, 0);
    lv_obj_set_style_border_color(tabBtn[k], k == t ? C_ENERGY : C_LINE, 0);
    if (k == t) lv_obj_clear_flag(panel[k], LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(panel[k], LV_OBJ_FLAG_HIDDEN);
  }
}
static void onTab(lv_event_t *e) { showTab((int)(intptr_t)lv_event_get_user_data(e)); }

static void askSilence() {
  showModal("Silenciar as sirenes?", "As sirenes param agora. O que disparou continua marcado na tela e no app "
            "(o alarme de gás continua travado até o rearme).", "", C_MUTED, "Silenciar", C_BTN_WARN,
            UiRequest{ UI_REQ_SILENCE, 0, false, 0, false });
}

// toque no cabeçalho: com sirene tocando, oferece silenciar; senão abre a aba do problema
static void onHeader(lv_event_t *) {
  if (!s_haveState) return;
  const UiState &s = s_last;
  if (s.sirens) { askSilence(); return; }
  bool smoke = false;
  for (int r = 0; r < UI_ROOMS; r++) smoke |= s.smoke[r];
  if (s.gasLatched || smoke || s.gasWarn[0] || s.gasWarn[1] || s.acFail || s.battLow) showTab(TAB_GAS);
  else if (s.triggered || s.entryLeftS || s.exitLeftS || s.panic) showTab(TAB_ALARM);
}

// ---- luzes: toque alterna (o .ino confere o retorno) ----
static void onLight(lv_event_t *e) {
  int i = (int)(intptr_t)lv_event_get_user_data(e);
  if (!s_haveState || i < 0 || i >= UI_LIGHTS) return;
  const UiState &s = s_last;
  char b[112];
  if (s.lightBlocked[i]) { snprintf(b, sizeof(b), "%s: gás na área — a luz não é comutada até o rearme.", s_cfg.lights[i].name); toast(b); return; }
  if (!s.lightKnown[i]) { snprintf(b, sizeof(b), "%s: sem retorno do módulo de relés.", s_cfg.lights[i].name); toast(b); return; }
  if (s.lightPending[i]) { toast("Aguarde: conferindo o comando anterior..."); return; }
  send(UiRequest{ UI_REQ_LIGHT, (int16_t)i, !s.lightOn[i], 0, false });
}

// ---- ambientes: banheiro abre o exaustor ----
static void onRoom(lv_event_t *e) {
  int r = (int)(intptr_t)lv_event_get_user_data(e);
  if (!s_haveState || r < 0 || r >= UI_ROOMS) return;
  int f = s_cfg.rooms[r].fan;
  if (f < 0 || f >= UI_FANS) return;
  const UiState &s = s_last;
  char title[64], body[200], hum[24];
  snprintf(title, sizeof(title), "Exaustor — %s", s_cfg.rooms[r].name);
  if (s.climateOk[r]) { snprintf(hum, sizeof(hum), "%.0f %%", s.hum[r]); }
  else snprintf(hum, sizeof(hum), "sem leitura");
  if (s.fanAuto[f])
    snprintf(body, sizeof(body), "Agora: %s, automático pela umidade (%s).\nLiga com UR acima de 75 %% e desliga abaixo de 60 %% "
             "(mínimo 5 min, máximo 60 min).", s.fanOn[f] ? "ligado" : "desligado", hum);
  else
    snprintf(body, sizeof(body), "Agora: %s, manual por mais %u min (umidade %s).\nDepois volta ao automático.",
             s.fanOn[f] ? "ligado" : "desligado", (unsigned)((s.fanManualLeftS[f] + 59) / 60), hum);
  if (s.fanBlocked[f]) {
    showModalN(title, body, "BLOQUEADO: gás detectado. Nenhum exaustor é ligado nem desligado até o gás sair e o "
               "corte ser rearmado.", C_ALARM, 0, nullptr, nullptr, nullptr);
    return;
  }
  static const char *const labels[3] = { "Desligar", "Ligar", "Auto" };
  const lv_color_t colors[3] = { C_BTN_WARN, C_BTN_GO, C_TAB_ON };
  const UiRequest reqs[3] = { UiRequest{ UI_REQ_FAN, (int16_t)f, false, 0, false }, UiRequest{ UI_REQ_FAN, (int16_t)f, true, 1, false },
                              UiRequest{ UI_REQ_FAN, (int16_t)f, false, 2, false } };
  showModalN(title, body, "Ligar ou desligar aqui vale por 30 min.", C_MUTED, 3, labels, colors, reqs);
}

// ---- gás: válvula (confirma) e rearme (segurar 2 s) ----
static void onValve(lv_event_t *) {
  if (!s_haveState) return;
  const UiState &s = s_last;
  if (s.gasCut) {
    if (s.gasLatched) { toast("Alarme de gás travado: rearme primeiro (segure o botão por 2 s)."); return; }
    showModal("Liberar a válvula de gás?", "Desliga o corte por software (Relay 91 CH7).",
              "A válvula tem rearme MANUAL: depois de liberar, reabra-a na mão.", C_WARN, "Liberar", C_BTN_GO,
              UiRequest{ UI_REQ_VALVE, 0, true, 0, false });
  } else {
    showModal("Fechar a válvula de gás?", "Liga o corte por software (Relay 91 CH7): a válvula fecha e o gás da casa é cortado.",
              "Para voltar a ter gás: libere aqui e reabra a válvula na mão.", C_MUTED, "Fechar", C_BTN_STOP,
              UiRequest{ UI_REQ_VALVE, 0, false, 0, false });
  }
}

static void onRearm(lv_event_t *e) {
  lv_event_code_t code = lv_event_get_code(e);
  if (code == LV_EVENT_PRESSED) {
    rearmPressAt = lv_tick_get();
    rearmFired = false;
  } else if (code == LV_EVENT_PRESSING) {
    if (!s_haveState || !s_last.gasLatched || rearmFired) return;
    uint32_t el = lv_tick_elaps(rearmPressAt);
    lv_bar_set_value(rearmBar, el >= REARM_HOLD_MS ? 100 : (int)(el * 100 / REARM_HOLD_MS), LV_ANIM_OFF);
    if (el >= REARM_HOLD_MS) {
      rearmFired = true;
      send(UiRequest{ UI_REQ_REARM, 0, false, 0, false });
    }
  } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
    lv_bar_set_value(rearmBar, 0, LV_ANIM_OFF);
    if (!s_haveState || rearmFired) return;
    toast(s_last.gasLatched ? "Segure o botão por 2 segundos para rearmar." : "Nenhum alarme de gás travado.");
  }
}

// ---- alarme: modos com confirmação; silenciar direto ----
static void onArm(lv_event_t *e) {
  int m = (int)(intptr_t)lv_event_get_user_data(e);
  if (!s_haveState || m < 0 || m > 2) return;
  const UiState &s = s_last;
  if (m == s.armed && !s.triggered && !s.exitLeftS) { toast("O alarme já está neste modo."); return; }
  char title[48], body[220];
  if (m == 0) {
    snprintf(title, sizeof(title), "Desarmar o alarme?");
    snprintf(body, sizeof(body), "Portas e presença deixam de disparar. As sirenes da intrusão param. "
             "Fumaça, gás e pânico continuam vigiados sempre.");
    showModal(title, body, "", C_MUTED, "Desarmar", C_BTN_GO, UiRequest{ UI_REQ_ARM, 0, false, 0, false });
  } else {
    snprintf(title, sizeof(title), "Armar: %s?", ARM_LABEL[m]);
    snprintf(body, sizeof(body), "%s\nVocê tem %u s para sair. Ao voltar, a porta de entrada dá %u s para desarmar; "
             "a porta da cozinha/serviço dispara na hora.",
             m == 1 ? "Vigia só as portas (presença liberada)." : "Vigia as portas e todos os sensores de presença.",
             (unsigned)s_cfg.exitDelayS, (unsigned)s_cfg.entryDelayS);
    showModal(title, body, "", C_MUTED, "Armar", C_BTN_WARN, UiRequest{ UI_REQ_ARM, 0, false, (int8_t)m, false });
  }
}

static void onSilence(lv_event_t *) {
  if (!s_haveState) return;
  if (!s_last.sirens) { toast("As sirenes estão desligadas."); return; }
  send(UiRequest{ UI_REQ_SILENCE, 0, false, 0, false });
}

// ---- montagem da tela ----
static void buildLights(lv_obj_t *p) {
  for (int i = 0; i < UI_LIGHTS; i++) {
    lTile[i] = box(p, (i % 5) * 157, (i / 5) * 174, 148, 166, C_OFF_BG, C_LINE);
    lv_obj_add_flag(lTile[i], LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(lTile[i], onLight, LV_EVENT_CLICKED, (void *)(intptr_t)i);
    lv_obj_t *n = textAt(lTile[i], &nh_font_20, C_TEXT, s_cfg.lights[i].name, 10, 10, 128);
    lv_obj_set_height(n, 52);
    lState[i] = textAt(lTile[i], &nh_font_24, C_OFF, "--", 10, 86, 0);
    lSub[i] = textAt(lTile[i], &nh_font_16, C_MUTED, s_cfg.lights[i].tag, 10, 126, 128);
  }
}

static void buildRooms(lv_obj_t *p) {
  for (int r = 0; r < UI_ROOMS; r++) {
    rTile[r] = box(p, (r % 5) * 157, (r / 5) * 174, 148, 166, C_CARD, C_LINE);
    if (s_cfg.rooms[r].fan >= 0) {
      lv_obj_add_flag(rTile[r], LV_OBJ_FLAG_CLICKABLE);
      lv_obj_add_event_cb(rTile[r], onRoom, LV_EVENT_CLICKED, (void *)(intptr_t)r);
    }
    char nm[40];
    fitText(nm, sizeof(nm), s_cfg.rooms[r].name, &nh_font_16, 128);
    lv_obj_t *n = textAt(rTile[r], &nh_font_16, C_TEXT, nm, 10, 8, 0);
    lv_label_set_long_mode(n, LV_LABEL_LONG_DOT);
    lv_obj_set_size(n, 130, 20);
    rTemp[r] = textAt(rTile[r], &nh_font_24, C_TEXT, "--", 10, 32, 0);
    rHum[r] = textAt(rTile[r], &nh_font_16, C_MUTED, "", 10, 64, 0);
    rPres[r] = textAt(rTile[r], &nh_font_16, C_MUTED, "", 10, 88, 0);
    rNote[r] = textAt(rTile[r], &nh_font_16, C_MUTED, "", 10, 112, 128);
  }
}

static void buildGas(lv_obj_t *p) {
  for (int g = 0; g < UI_GAS; g++) {
    gCard[g] = box(p, 0, g * 178, 250, 170, C_CARD, C_LINE);
    char t[48];
    snprintf(t, sizeof(t), "Gás — %s", s_cfg.gasNames[g]);
    textAt(gCard[g], &nh_font_20, C_TEXT, t, 14, 10, 0);
    gValue[g] = textAt(gCard[g], &nh_font_48, C_TEXT, "--", 14, 38, 0);
    textAt(gCard[g], &nh_font_16, C_MUTED, "LEL", 190, 64, 0);
    gBar[g] = bar(gCard[g], 14, 102, 222, 12, 25);   // escala até 25 % LEL (AL2 = 20 %)
    gStatus[g] = textAt(gCard[g], &nh_font_16, C_MUTED, "", 14, 122, 222);
  }

  valveCard = box(p, 258, 0, 250, 348, C_CARD, C_LINE);
  textAt(valveCard, &nh_font_20, C_TEXT, "Válvula de gás", 14, 10, 0);
  valveState = textAt(valveCard, &nh_font_24, C_TEXT, "--", 14, 40, 0);
  valveLine = textAt(valveCard, &nh_font_16, C_MUTED, "", 14, 74, 222);
  textAt(valveCard, &nh_font_16, C_MUTED, "Rearme manual: depois de liberar, reabra a válvula na mão.", 14, 140, 222);
  btnValve = button(valveCard, 14, 206, 222, 58, C_BTN_STOP, "Fechar válvula", &btnValveLbl);
  lv_obj_add_event_cb(btnValve, onValve, LV_EVENT_CLICKED, nullptr);
  btnRearm = button(valveCard, 14, 274, 222, 62, C_OFF_BG, "Sem alarme travado", &rearmLbl);
  lv_obj_set_style_text_font(rearmLbl, &nh_font_16, 0);
  lv_obj_align(rearmLbl, LV_ALIGN_TOP_MID, 0, 12);
  rearmBar = bar(btnRearm, 12, 44, 198, 8, 100);
  lv_obj_clear_flag(rearmBar, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(btnRearm, onRearm, LV_EVENT_ALL, nullptr);

  lv_obj_t *sc = box(p, 516, 0, 260, 348, C_CARD, C_LINE);
  textAt(sc, &nh_font_20, C_TEXT, "Fumaça e calor", 14, 10, 0);
  for (int k = 0; k < UI_SMOKE; k++) {
    smokeRoom[k] = -1;
    for (int r = 0; r < UI_ROOMS; r++) if (s_cfg.rooms[r].smoke == k) smokeRoom[k] = r;
    textAt(sc, &nh_font_16, C_MUTED, s_cfg.smokeNames[k], 14, 44 + k * 28, 0);
    smokeState[k] = text(sc, &nh_font_16, C_MUTED, "--");
    lv_obj_align(smokeState[k], LV_ALIGN_TOP_RIGHT, -14, 44 + k * 28);
  }
  lv_obj_t *sep = box(sc, 14, 214, 232, 2, C_LINE, C_LINE);
  lv_obj_set_style_radius(sep, 0, 0);
  panicLbl = textAt(sc, &nh_font_16, C_MUTED, "", 14, 226, 232);
  f2Lbl = textAt(sc, &nh_font_16, C_MUTED, "", 14, 254, 232);
  battLbl = textAt(sc, &nh_font_16, C_MUTED, "", 14, 282, 232);
  sirenLbl = textAt(sc, &nh_font_16, C_MUTED, "", 14, 310, 232);
}

static void buildAlarm(lv_obj_t *p) {
  lv_obj_t *l = box(p, 0, 0, 380, 348, C_CARD, C_LINE);
  textAt(l, &nh_font_20, C_TEXT, "Alarme da casa", 16, 10, 0);
  aMode = textAt(l, &nh_font_24, C_TEXT, "--", 16, 40, 0);
  aStatus = textAt(l, &nh_font_16, C_MUTED, "", 16, 74, 348);
  static const char *const labels[3] = { "Desarmar", "Em casa (só portas)", "Ausente (portas e presença)" };
  for (int m = 0; m < 3; m++) {
    aBtn[m] = button(l, 16, 132 + m * 70, 348, 62, C_OFF_BG, labels[m], nullptr);
    lv_obj_set_style_border_width(aBtn[m], 2, 0);
    lv_obj_add_event_cb(aBtn[m], onArm, LV_EVENT_CLICKED, (void *)(intptr_t)m);
  }

  lv_obj_t *z = box(p, 388, 0, 388, 348, C_CARD, C_LINE);
  textAt(z, &nh_font_20, C_TEXT, "Zonas", 16, 10, 0);
  textAt(z, &nh_font_16, C_MUTED, "Porta de entrada", 16, 44, 0);
  zoneFront = text(z, &nh_font_16, C_MUTED, "--");
  lv_obj_align(zoneFront, LV_ALIGN_TOP_RIGHT, -16, 44);
  textAt(z, &nh_font_16, C_MUTED, "Porta da cozinha/serviço", 16, 72, 0);
  zoneService = text(z, &nh_font_16, C_MUTED, "--");
  lv_obj_align(zoneService, LV_ALIGN_TOP_RIGHT, -16, 72);
  textAt(z, &nh_font_16, C_MUTED, "Presença (só no modo Ausente):", 16, 106, 0);
  int n = 0;
  for (int r = 0; r < UI_ROOMS; r++) {
    zonePres[r] = nullptr;
    if (!s_cfg.rooms[r].hasPresence) continue;
    char b[48];
    snprintf(b, sizeof(b), "\xE2\x80\xA2 %s", s_cfg.rooms[r].name);
    zonePres[r] = textAt(z, &nh_font_16, C_MUTED, b, 16 + (n % 2) * 182, 132 + (n / 2) * 26, 0);
    lv_label_set_long_mode(zonePres[r], LV_LABEL_LONG_DOT);
    lv_obj_set_width(zonePres[r], 176);
    n++;
  }
  btnSilence = button(z, 16, 274, 356, 62, C_OFF_BG, "Silenciar sirenes", &btnSilenceLbl);
  lv_obj_add_event_cb(btnSilence, onSilence, LV_EVENT_CLICKED, nullptr);
}

static void build() {
  lv_obj_t *scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, C_BG, 0);
  lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

  // cabeçalho (verde / âmbar / vermelho)
  hdr = box(scr, 0, 0, 800, 56, C_CARD, C_CARD);
  lv_obj_set_style_radius(hdr, 0, 0);
  lv_obj_add_flag(hdr, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(hdr, onHeader, LV_EVENT_CLICKED, nullptr);
  hdrTitle = text(hdr, &nh_font_24, C_TEXT, "Segurança da casa");
  lv_label_set_long_mode(hdrTitle, LV_LABEL_LONG_DOT);
  lv_obj_set_width(hdrTitle, 470);
  lv_obj_align(hdrTitle, LV_ALIGN_LEFT_MID, 18, 0);
  chipAlarm = text(hdr, &nh_font_16, C_MUTED, "Alarme");
  lv_obj_align(chipAlarm, LV_ALIGN_RIGHT_MID, -150, 0);
  chipWifi = text(hdr, &nh_font_16, C_MUTED, "Wi-Fi");
  lv_obj_align(chipWifi, LV_ALIGN_RIGHT_MID, -18, 0);

  // abas
  for (int t = 0; t < TABS; t++) {
    tabBtn[t] = box(scr, 12 + t * 196, 64, 188, 48, C_CARD, C_LINE);
    lv_obj_set_style_radius(tabBtn[t], 12, 0);
    lv_obj_add_flag(tabBtn[t], LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(tabBtn[t], onTab, LV_EVENT_CLICKED, (void *)(intptr_t)t);
    tabLabel[t] = text(tabBtn[t], &nh_font_20, C_TEXT, TAB_NAMES[t]);
    lv_obj_center(tabLabel[t]);
    panel[t] = lv_obj_create(scr);
    lv_obj_set_pos(panel[t], 12, 120);
    lv_obj_set_size(panel[t], 776, 348);
    lv_obj_set_style_bg_opa(panel[t], LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(panel[t], 0, 0);
    lv_obj_set_style_pad_all(panel[t], 0, 0);
    lv_obj_clear_flag(panel[t], LV_OBJ_FLAG_SCROLLABLE);
  }
  buildLights(panel[TAB_LIGHTS]);
  buildRooms(panel[TAB_ROOMS]);
  buildGas(panel[TAB_GAS]);
  buildAlarm(panel[TAB_ALARM]);

  // aviso curto
  toastBox = box(lv_layer_top(), 140, 404, 520, 60, C_CARD, C_ENERGY);
  toastLbl = textAt(toastBox, &nh_font_16, C_TEXT, "", 16, 0, 488);
  lv_obj_set_style_text_align(toastLbl, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(toastLbl, LV_ALIGN_LEFT_MID, 16, 0);
  lv_obj_clear_flag(toastBox, LV_OBJ_FLAG_CLICKABLE);   // o aviso não rouba toques da tela
  lv_obj_add_flag(toastBox, LV_OBJ_FLAG_HIDDEN);
  showTab(TAB_LIGHTS);
}

bool ui_begin(const UiConfig &cfg, UiRequestFn onRequest) {
  s_req = onRequest;
  s_cfg = cfg;
  Board *board = new Board();
  board->init();
  if (!board->begin()) return false;
  lvgl_port_init(board->getLCD(), board->getTouch());
  lvgl_port_lock(-1);
  build();
  lvgl_port_unlock();
  return true;
}

// ---- atualização ----
enum Level : uint8_t { LVL_OK = 0, LVL_WARN = 1, LVL_ALARM = 2 };

static void fmtLel(char *out, size_t n, float lel) {
  if (lel < 10) snprintf(out, n, "%.1f%%", lel);
  else snprintf(out, n, "%.0f%%", lel);
  comma(out);
}

static const char *zoneName(uint8_t z) {
  return z == 1 ? "porta de entrada" : z == 2 ? "porta da cozinha/serviço" : z == 4 ? "presença"
       : z == 8 ? "sabotagem (módulo sem resposta)" : "zona";
}

// título do cabeçalho e nível (o problema mais grave vence; entre iguais, o último da lista)
static Level headerText(const UiState &s, char *b, size_t n, int tabLevel[TABS]) {
  for (int t = 0; t < TABS; t++) tabLevel[t] = LVL_OK;
  Level lv = LVL_OK;
  char m[96];
  b[0] = 0;
  auto set = [&](Level l, int tab, const char *msg) {
    if (l > tabLevel[tab]) tabLevel[tab] = l;
    if (l >= lv) { lv = l; snprintf(b, n, "%s", msg); }
  };
  // avisos (âmbar)
  for (int i = 0; i < UI_LIGHTS; i++) if (!s.lightKnown[i]) { set(LVL_WARN, TAB_LIGHTS, "Luzes: sem retorno do módulo de relés"); break; }
  for (int i = 0; i < UI_LIGHTS; i++) if (s.lightBlocked[i] && tabLevel[TAB_LIGHTS] < LVL_WARN) tabLevel[TAB_LIGHTS] = LVL_WARN;
  if (s.modulesOk < s.modulesTotal) {
    snprintf(m, sizeof(m), "Barramento B: %u de %u aparelhos respondendo", s.modulesOk, s.modulesTotal);
    set(LVL_WARN, TAB_LIGHTS, m);
  }
  if (s.exitLeftS) { snprintf(m, sizeof(m), "Alarme armando: %u s para sair", s.exitLeftS); set(LVL_WARN, TAB_ALARM, m); }
  if (s.acFail) set(LVL_WARN, TAB_GAS, "Fonte de segurança na bateria (sem 220 V)");
  for (int g = 0; g < UI_GAS; g++)
    if (s.gasWarn[g] && !s.gasTripped[g]) { snprintf(m, sizeof(m), "Gás: pré-alarme na %s", s_cfg.gasNames[g]); set(LVL_WARN, TAB_GAS, m); }
  if (s.entryLeftS) { snprintf(m, sizeof(m), "Porta de entrada aberta: desarme em %u s", s.entryLeftS); set(LVL_WARN, TAB_ALARM, m); }
  // alarmes (vermelho)
  if (s.battLow) set(LVL_ALARM, TAB_GAS, "Bateria da segurança BAIXA");
  if (s.panic) set(LVL_ALARM, TAB_ALARM, "PÂNICO acionado");
  if (s.triggered) { snprintf(m, sizeof(m), "ALARME DISPARADO: %s", zoneName(s.trigZone)); set(LVL_ALARM, TAB_ALARM, m); }
  for (int r = 0; r < UI_ROOMS; r++)
    if (s.smoke[r]) { snprintf(m, sizeof(m), s_cfg.rooms[r].heat ? "CALOR na %s" : "FUMAÇA: %s", s_cfg.rooms[r].name); set(LVL_ALARM, TAB_GAS, m); }
  if (s.gasLatched) {
    int g = s.gasTripped[1] && !s.gasTripped[0] ? 1 : 0;
    snprintf(m, sizeof(m), "GÁS na %s: válvula cortada", s_cfg.gasNames[g]);
    set(LVL_ALARM, TAB_GAS, m);
  }
  if (!b[0]) snprintf(b, n, "Casa segura");
  return lv;
}

static void updateHeader(const UiState &s) {
  char b[96];
  int tabLevel[TABS];
  Level lv = headerText(s, b, sizeof(b), tabLevel);
  if (s.sirens && lv == LVL_ALARM && strlen(b) < 28) strncat(b, " (toque: silenciar)", sizeof(b) - strlen(b) - 1);
  setBox(hdr, lv == LVL_ALARM ? C_ALARM_BG : lv == LVL_WARN ? C_WARN_BG : C_ON_BG,
         lv == LVL_ALARM ? C_ALARM : lv == LVL_WARN ? C_WARN : C_ON_BG);
  const lv_font_t *font = strlen(b) > 30 ? &nh_font_20 : &nh_font_24;
  if (lv_obj_get_style_text_font(hdrTitle, 0) != font) lv_obj_set_style_text_font(hdrTitle, font, 0);
  setText(hdrTitle, b);
  snprintf(b, sizeof(b), "Alarme: %s", s.triggered ? "DISPARADO" : ARM_LABEL[s.armed <= 2 ? s.armed : 0]);
  setText(chipAlarm, b);
  setTextColor(chipAlarm, s.triggered ? C_ALARM : s.armed ? C_WARN : C_ON);
  setText(chipWifi, s.wifiOk ? "Wi-Fi: ok" : "Wi-Fi: sem rede");
  setTextColor(chipWifi, s.wifiOk ? C_ON : C_WARN);
  for (int t = 0; t < TABS; t++) setTextColor(tabLabel[t], tabLevel[t] == LVL_ALARM ? C_ALARM : tabLevel[t] == LVL_WARN ? C_WARN : C_TEXT);
}

static void updateLights(const UiState &s) {
  char b[48];
  for (int i = 0; i < UI_LIGHTS; i++) {
    lv_color_t bg = C_OFF_BG, bd = C_LINE, tc = C_OFF;
    const char *st = "Apagada";
    if (!s.lightKnown[i]) { bg = C_CARD; tc = C_WARN; st = "--"; snprintf(b, sizeof(b), "%s · sem retorno", s_cfg.lights[i].tag); }
    else {
      if (s.lightOn[i]) { bg = C_LAMP_BG; bd = C_LAMP; tc = C_LAMP; st = "Acesa"; }
      if (s.lightBlocked[i]) { bg = C_ALARM_BG; bd = C_ALARM; snprintf(b, sizeof(b), "bloqueada: gás"); }
      else if (s.lightPending[i]) { bd = C_ENERGY; snprintf(b, sizeof(b), "%s · aguarde...", s_cfg.lights[i].tag); }
      else snprintf(b, sizeof(b), "%s", s_cfg.lights[i].tag);
    }
    setBox(lTile[i], bg, bd);
    setText(lState[i], st);
    setTextColor(lState[i], tc);
    setText(lSub[i], b);
    setTextColor(lSub[i], s.lightBlocked[i] ? C_ALARM : s.lightPending[i] ? C_ENERGY : C_MUTED);
  }
}

static void updateRooms(const UiState &s) {
  char b[64];
  for (int r = 0; r < UI_ROOMS; r++) {
    const UiRoom &R = s_cfg.rooms[r];
    if (!R.hasClimate) { setText(rTemp[r], "--"); setTextColor(rTemp[r], C_MUTED); setText(rHum[r], "sem T/UR"); }
    else if (!s.climateOk[r]) { setText(rTemp[r], "--"); setTextColor(rTemp[r], C_WARN); setText(rHum[r], "sensor sem resposta"); }
    else {
      snprintf(b, sizeof(b), "%.1f °C", s.temp[r]); comma(b);
      setText(rTemp[r], b); setTextColor(rTemp[r], C_TEXT);
      snprintf(b, sizeof(b), "UR %.0f %%", s.hum[r]);
      setText(rHum[r], b);
    }
    if (R.fan >= 0 && R.fan < UI_FANS) { setText(rPres[r], "Exaustor:"); setTextColor(rPres[r], C_MUTED); }
    else if (!R.hasPresence) setText(rPres[r], "");
    else if (!s.presenceOk) { setText(rPres[r], "presença: --"); setTextColor(rPres[r], C_WARN); }
    else { setText(rPres[r], s.presence[r] ? "\xE2\x80\xA2 presença" : "vazio"); setTextColor(rPres[r], s.presence[r] ? C_ON : C_MUTED); }

    lv_color_t bg = C_CARD, bd = C_LINE, nc = C_MUTED;
    b[0] = 0;
    if (R.smoke >= 0 && s.smoke[r]) { bg = C_ALARM_BG; bd = C_ALARM; nc = C_ALARM; snprintf(b, sizeof(b), "%s", R.heat ? "CALOR!" : "FUMAÇA!"); }
    else if (R.hasDoor && s.doorOpen[r]) { bd = C_WARN; nc = C_WARN; snprintf(b, sizeof(b), "porta aberta"); }
    else if (R.fan >= 0 && R.fan < UI_FANS) {
      snprintf(b, sizeof(b), "%s\n%s", s.fanOn[R.fan] ? "ligado" : "desligado",
               s.fanBlocked[R.fan] ? "BLOQUEADO (gás)" : s.fanAuto[R.fan] ? "automático" : "manual (30 min)");
      if (s.fanBlocked[R.fan]) { bd = C_WARN; nc = C_WARN; }
      else if (s.fanOn[R.fan]) { bd = C_ENERGY; nc = C_ENERGY; }
    }
    setBox(rTile[r], bg, bd);
    setText(rNote[r], b);
    setTextColor(rNote[r], nc);
  }
}

static void updateGas(const UiState &s) {
  char b[96], v[16];
  for (int g = 0; g < UI_GAS; g++) {
    lv_color_t bd = C_LINE, c = C_ON;
    if (!s.gasOk[g]) {
      setText(gValue[g], "--");
      setTextColor(gValue[g], C_MUTED);
      lv_bar_set_value(gBar[g], 0, LV_ANIM_OFF);
      snprintf(b, sizeof(b), "Transmissor sem resposta (o corte por fio continua).");
      c = C_WARN; bd = C_WARN;
    } else {
      fmtLel(v, sizeof(v), s.gasLel[g]);
      setText(gValue[g], v);
      int pct = (int)(s.gasLel[g] + 0.5f);
      lv_bar_set_value(gBar[g], pct > 25 ? 25 : pct, LV_ANIM_OFF);
      if (s.gasTripped[g] || s.gasAl2[g]) { c = C_ALARM; bd = C_ALARM; snprintf(b, sizeof(b), "ALARME (AL2): válvula cortada, sirenes."); }
      else if (s.gasWarn[g]) { c = C_WARN; bd = C_WARN; snprintf(b, sizeof(b), "Pré-alarme (AL1): ventile, não acione nada."); }
      else snprintf(b, sizeof(b), "Normal · AL1 %.0f %% · AL2 %.0f %%", s_cfg.gasWarn, s_cfg.gasCut);
      setTextColor(gValue[g], c.full == C_ON.full ? C_TEXT : c);
    }
    setBarColor(gBar[g], c);
    setText(gStatus[g], b);
    setTextColor(gStatus[g], c.full == C_ON.full ? C_MUTED : c);
    setBox(gCard[g], c.full == C_ALARM.full ? C_ALARM_BG : C_CARD, bd);
  }

  // válvula
  if (!s.valveKnown) { setText(valveState, "--"); setTextColor(valveState, C_MUTED); }
  else { setText(valveState, s.valveOpen ? "ABERTA" : "FECHADA"); setTextColor(valveState, s.valveOpen ? C_ON : C_WARN); }
  if (s.gasLatched) snprintf(b, sizeof(b), "Corte LIGADO: alarme de gás travado até o rearme.");
  else if (s.valveCmdClosed) snprintf(b, sizeof(b), "Corte LIGADO: fechada pela tela/app.");
  else if (s.valveKnown && !s.valveOpen) snprintf(b, sizeof(b), "Corte desligado. Fechada: reabra na mão (ou botoeira/AL2 abertos).");
  else snprintf(b, sizeof(b), "Corte por software desligado.");
  setText(valveLine, b);
  setTextColor(valveLine, s.gasLatched ? C_ALARM : s.gasCut ? C_WARN : C_MUTED);
  setBox(valveCard, s.gasLatched ? C_ALARM_BG : C_CARD, s.gasLatched ? C_ALARM : C_LINE);
  setText(btnValveLbl, s.gasCut ? "Liberar válvula" : "Fechar válvula");
  setBox(btnValve, s.gasCut ? (s.gasLatched ? C_OFF_BG : C_BTN_GO) : C_BTN_STOP, s.gasCut ? (s.gasLatched ? C_OFF_BG : C_BTN_GO) : C_BTN_STOP);
  setText(rearmLbl, s.gasLatched ? "Segure 2 s: rearmar" : "Sem alarme travado");
  setBox(btnRearm, s.gasLatched ? C_BTN_STOP : C_OFF_BG, s.gasLatched ? C_ALARM : C_OFF_BG);
  setTextColor(rearmLbl, s.gasLatched ? C_TEXT : C_MUTED);

  // fumaça e fontes
  for (int k = 0; k < UI_SMOKE; k++) {
    int r = smokeRoom[k];
    if (r < 0 || !s.safetyOk) { setText(smokeState[k], "--"); setTextColor(smokeState[k], C_WARN); continue; }
    setText(smokeState[k], s.smoke[r] ? "DISPARADO" : "ok");
    setTextColor(smokeState[k], s.smoke[r] ? C_ALARM : C_ON);
  }
  if (!s.auxOk) {
    setText(panicLbl, "Pânico / fonte F2: módulo 91 sem resposta");
    setTextColor(panicLbl, C_WARN);
    setText(f2Lbl, ""); setText(battLbl, "");
  } else {
    setText(panicLbl, s.panic ? "Pânico: ACIONADO" : "Pânico: normal");
    setTextColor(panicLbl, s.panic ? C_ALARM : C_MUTED);
    setText(f2Lbl, s.acFail ? "Fonte F2: BATERIA (sem 220 V)" : "Fonte F2: rede 220 V");
    setTextColor(f2Lbl, s.acFail ? C_WARN : C_MUTED);
    setText(battLbl, s.battLow ? "Bateria F2: BAIXA" : "Bateria F2: ok");
    setTextColor(battLbl, s.battLow ? C_ALARM : C_MUTED);
  }
  setText(sirenLbl, s.sirens ? "Sirenes: TOCANDO" : "Sirenes: desligadas");
  setTextColor(sirenLbl, s.sirens ? C_ALARM : C_MUTED);
}

static void updateAlarm(const UiState &s) {
  char b[112];
  uint8_t m = s.armed <= 2 ? s.armed : 0;
  setText(aMode, s.triggered ? "DISPARADO" : ARM_LABEL[m]);
  setTextColor(aMode, s.triggered ? C_ALARM : m ? C_WARN : C_ON);
  if (s.triggered) snprintf(b, sizeof(b), "Disparou: %s. Desarme para limpar.", zoneName(s.trigZone));
  else if (s.entryLeftS) snprintf(b, sizeof(b), "Porta de entrada aberta: desarme em %u s.", s.entryLeftS);
  else if (s.exitLeftS) snprintf(b, sizeof(b), "Armando: %u s para sair.", s.exitLeftS);
  else if (m == 1) snprintf(b, sizeof(b), "Vigiando as portas.");
  else if (m == 2) snprintf(b, sizeof(b), "Vigiando as portas e a presença.");
  else snprintf(b, sizeof(b), "Toque num modo para armar (pede confirmação).");
  setText(aStatus, b);
  setTextColor(aStatus, s.triggered ? C_ALARM : (s.entryLeftS || s.exitLeftS) ? C_WARN : C_MUTED);
  for (int k = 0; k < 3; k++) setBox(aBtn[k], k == m ? C_TAB_ON : C_OFF_BG, k == m ? C_ENERGY : C_OFF_BG);

  int front = -1, service = -1;
  for (int r = 0; r < UI_ROOMS; r++) {
    if (!s_cfg.rooms[r].hasDoor) continue;
    if (front < 0) front = r; else if (service < 0) service = r;
  }
  lv_obj_t *zl[2] = { zoneFront, zoneService };
  int zr[2] = { front, service };
  for (int k = 0; k < 2; k++) {
    if (zr[k] < 0 || !s.safetyOk) { setText(zl[k], "--"); setTextColor(zl[k], C_WARN); continue; }
    bool open = s.doorOpen[zr[k]];
    setText(zl[k], open ? "ABERTA" : "fechada");
    setTextColor(zl[k], open ? C_WARN : C_ON);
  }
  for (int r = 0; r < UI_ROOMS; r++) {
    if (!zonePres[r]) continue;
    setTextColor(zonePres[r], !s.presenceOk ? C_WARN : s.presence[r] ? C_ON : C_MUTED);
  }
  setBox(btnSilence, s.sirens ? C_BTN_STOP : C_OFF_BG, s.sirens ? C_ALARM : C_OFF_BG);
  setTextColor(btnSilenceLbl, s.sirens ? C_TEXT : C_MUTED);
}

void ui_update(const UiState &s) {
  if (!lvgl_port_lock(50)) return;   // tela ocupada: tenta no próximo ciclo
  s_last = s;
  if (!s_haveState) s_noticeSeq = s.noticeSeq;   // aviso antigo (antes da tela) não aparece
  s_haveState = true;
  updateHeader(s);
  updateLights(s);
  updateRooms(s);
  updateGas(s);
  updateAlarm(s);
  if (s.noticeSeq != s_noticeSeq) {
    s_noticeSeq = s.noticeSeq;
    if (s.notice[0]) toast(s.notice);
  }
  if (toastOn && lv_tick_elaps(toastAt) > 4500) { toastOn = false; lv_obj_add_flag(toastBox, LV_OBJ_FLAG_HIDDEN); }
  lvgl_port_unlock();
}

// ============================================================
// NexusHome OS — Tela touch da Segurança (T3, SpotPear/Waveshare ESP32-S3-Touch-LCD-4.3B)
// 800×480, LVGL 8.4 + ESP32_Display_Panel 1.0.x. A lógica (Modbus, gás, alarme, luzes) fica no
// .ino; a tela só mostra o estado e envia PEDIDOS — nunca fala com o barramento diretamente.
// UiState também é o "retrato" que a tarefa de telemetria publica (com ou sem tela).
// ============================================================
#pragma once
#include <stdint.h>

#define UI_LIGHTS 10
#define UI_ROOMS  10
#define UI_GAS    2
#define UI_FANS   2
#define UI_SMOKE  6

// Dados fixos (vêm das tabelas do .ino)
struct UiLight { const char *name; const char *tag; };     // "Sala de Estar", "L01"
struct UiRoom {
  const char *name;
  bool hasClimate;      // XY-MD02
  bool hasPresence;
  int8_t smoke;         // índice do detector (0..5) ou -1
  bool heat;            // detector termovelocimétrico (cozinha)
  bool hasDoor;
  int8_t fan;           // exaustor deste cômodo (0..1) ou -1
};
struct UiConfig {
  const UiLight *lights;
  const UiRoom *rooms;
  const char *gasNames[UI_GAS];      // "Cozinha", "Lavanderia"
  const char *smokeNames[UI_SMOKE];
  float gasWarn, gasCut;             // limiares (% LEL)
  uint16_t exitDelayS, entryDelayS;
};

// Retrato atualizado pelo .ino a cada volta do loop
struct UiState {
  // luzes (estado REAL = retorno do relé KRn)
  bool lightOn[UI_LIGHTS], lightKnown[UI_LIGHTS], lightPending[UI_LIGHTS], lightBlocked[UI_LIGHTS];
  // cômodos
  float temp[UI_ROOMS], hum[UI_ROOMS];
  bool climateOk[UI_ROOMS];
  bool presence[UI_ROOMS], smoke[UI_ROOMS], doorOpen[UI_ROOMS];
  bool presenceOk, safetyOk;          // módulos 92 e 93 respondendo
  // gás
  float gasLel[UI_GAS];
  bool gasOk[UI_GAS], gasAl1[UI_GAS], gasAl2[UI_GAS], gasWarn[UI_GAS], gasTripped[UI_GAS];
  bool valveOpen, valveKnown, gasCut, gasLatched, valveCmdClosed;
  // exaustores
  bool fanOn[UI_FANS], fanAuto[UI_FANS];
  uint16_t fanManualLeftS[UI_FANS];
  // alarme
  uint8_t armed;                      // 0 desarmado · 1 em casa · 2 ausente
  bool triggered;
  uint8_t trigZone;                   // 1 porta de entrada · 2 porta de serviço · 4 presença
  uint16_t exitLeftS, entryLeftS;
  // fontes e sirenes
  bool sirens, panic, acFail, battLow, auxOk;
  // barramento e rede
  uint8_t modulesOk, modulesTotal;    // relés + entradas + gás respondendo
  bool wifiOk;
  // aviso curto para a tela ("rearme recusado: ainda há gás"...)
  char notice[112];
  uint16_t noticeSeq;
};

enum UiRequestType : uint8_t {
  UI_REQ_LIGHT = 1,     // idx = luz, on = estado pedido
  UI_REQ_ARM,           // value = 0 desarmar · 1 em casa · 2 ausente
  UI_REQ_SILENCE,       // silenciar sirenes
  UI_REQ_REARM,         // rearmar o alarme de gás travado
  UI_REQ_VALVE,         // on = true libera (abrir) · false fecha (liga o corte)
  UI_REQ_FAN,           // idx = exaustor, value = 0 desligar · 1 ligar (manual 30 min) · 2 automático
};
struct UiRequest { uint8_t type; int16_t idx; bool on; int8_t value; bool remote; };
typedef void (*UiRequestFn)(const UiRequest &req);

// inicia display, toque e LVGL e monta a tela
bool ui_begin(const UiConfig &cfg, UiRequestFn onRequest);
void ui_update(const UiState &s);   // chamar a cada ~300–400 ms (thread-safe)

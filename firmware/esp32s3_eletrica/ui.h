// ============================================================
// NexusHome OS — Tela touch do quadro elétrico (SpotPear/Waveshare ESP32-S3-Touch-LCD-4.3B)
// 800×480, LVGL 8.4 + ESP32_Display_Panel 1.0.x. A lógica (Modbus, proteção) fica no .ino;
// a tela só mostra o estado e envia PEDIDOS — nunca fala com o barramento diretamente.
// ============================================================
#pragma once
#include <stdint.h>

#define UI_MAX_CIRCUITS 48
#define UI_MAX_GROUPS   4

// Dados fixos de cada circuito (vêm da tabela CIRCUITS do .ino)
struct UiCircuit {
  const char *name;    // "Chuveiro — Banheiro 1" (o " — " vira quebra de linha no quadro)
  uint8_t group;       // subquadro (índice em groupNames)
  bool relay;          // tem relé/contator: pode ligar/desligar pela tela
  float breakerA;      // disjuntor do circuito
};

// Retrato atualizado pelo .ino a cada ~400 ms
struct UiState {
  float watts[UI_MAX_CIRCUITS], amps[UI_MAX_CIRCUITS], volts[UI_MAX_CIRCUITS];
  float kwh[UI_MAX_CIRCUITS], pf[UI_MAX_CIRCUITS];
  bool  meterOk[UI_MAX_CIRCUITS];
  bool  on[UI_MAX_CIRCUITS];      // o que o usuário quer (ligado)
  bool  shed[UI_MAX_CIRCUITS];    // cortado pela gestão de demanda
  bool  trip[UI_MAX_CIRCUITS];    // cortado por sobrecarga (travado)
  float totalW, totalKwh;
  float limitW;                   // limite de demanda (0 = gestão desligada)
  int   metersOk;
  bool  wifiOk, relaysOk;
};

enum UiRequestType : uint8_t { UI_REQ_SET = 1, UI_REQ_REARM = 2 };
struct UiRequest { uint8_t type; int16_t idx; bool on; bool remote; };
typedef void (*UiRequestFn)(const UiRequest &req);

// inicia display, toque e LVGL e monta a tela
bool ui_begin(const UiCircuit *circuits, int count, const char *const *groupNames, int groupCount, UiRequestFn onRequest);
void ui_update(const UiState &s);   // chamar a cada ~400 ms (thread-safe)

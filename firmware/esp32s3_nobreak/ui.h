// ============================================================
// NexusHome OS — Tela touch do nobreak (T4 do QAU · Waveshare ESP32-S3-Touch-LCD-4.3B)
// 800×480, LVGL 8.4 + ESP32_Display_Panel 1.0.x. A lógica (Modbus, SoC, alertas) fica no
// .ino; a tela só mostra o estado e envia PEDIDOS — nunca fala com o barramento.
// ============================================================
#pragma once
#include <stdint.h>

#define UI_METERS 3

// Dados fixos de cada medidor do barramento D (vêm da tabela do .ino)
struct UiMeter {
  const char *model;   // "PZEM-017"
  uint8_t addr;        // 41
  const char *role;    // "Banco 24 V"
};

// Retrato atualizado pelo .ino a cada ~400 ms
struct UiState {
  float soc;                 // %
  uint8_t socLevel;          // 0 normal · 1 baixa (≤ 20 %) · 2 crítica (≤ 10 %)
  bool  battOk;              // PZEM-017 respondendo
  float battV, battA, battW;
  bool  battLowV;            // tensão do banco ≤ 23,5 V
  bool  discharging;         // a bateria está alimentando a casa
  bool  gridMeterOk;         // PZEM-016 da entrada respondeu na última volta
  float gridV, gridW, gridHz;
  bool  outOk;
  float outV, outW;
  bool  gridFail;            // falta de energia confirmada (< 180 V por 5 s)
  float autonomyH;           // < 0 = sem estimativa
  float avgOutW;             // média da saída nos últimos 10 min (< 0 = sem dados)
  bool  meterOk[UI_METERS];
  int   metersOk;
  bool  wifiOk;
  float bankAh, bankV;       // 200 Ah · 25,6 V (só para o texto)
};

enum UiRequestType : uint8_t { UI_REQ_SET_SOC = 1 };
struct UiRequest { uint8_t type; float value; };
typedef void (*UiRequestFn)(const UiRequest &req);

// inicia display, toque e LVGL e monta a tela
bool ui_begin(const UiMeter *meters, int count, UiRequestFn onRequest);
void ui_update(const UiState &s);   // chamar a cada ~400 ms (thread-safe)

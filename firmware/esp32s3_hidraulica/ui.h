// ============================================================
// NexusHome OS — Tela touch da caixa d'água (SpotPear/Waveshare ESP32-S3-Touch-LCD-4.3B)
// 800×480, LVGL 8.4 + ESP32_Display_Panel 1.0.x. A lógica (Modbus, segurança) fica no .ino;
// a tela só mostra o estado e envia PEDIDOS — nunca fala com o barramento diretamente.
// ============================================================
#pragma once
#include <stdint.h>

struct UiState {
  float flowLpm[7];        // vazão por ramal (L/min); índice 6 = Área Externa
  float totalL;            // total medido desde que ligou
  float levelPct, volumeL; // reservatórios
  bool  sondaOk, countersOk, wifiOk;
  bool  relaysOk;          // última escrita dos relés aceita E confirmada lendo as bobinas (função 01)
  bool  valveOpen[8];      // 0–5 ramais, 6 geral, 7 área externa
  bool  blocked[8];        // travada por alarme/pânico (só reabre com "Rearmar")
  bool  alarmBurst, alarmExternal, panic;
};

enum UiRequestType : uint8_t { UI_REQ_SET_VALVE = 1, UI_REQ_PANIC = 2, UI_REQ_RESET = 3 };
struct UiRequest { uint8_t type; int8_t valve; bool open; bool remote; };
typedef void (*UiRequestFn)(const UiRequest &req);

bool ui_begin(UiRequestFn onRequest);   // inicia display, toque e LVGL e monta a tela
void ui_update(const UiState &s);       // chamar a cada ~300 ms (thread-safe)

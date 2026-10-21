// ============================================================
// NexusHome OS — Painel de parede (v2.16): interface LVGL
// ------------------------------------------------------------
// Corredor (ESP32-P4 10,1", 800×1280 retrato) e cômodos (ESP32-S3 7", 800×480).
// A tela só mostra o PModel e devolve pedidos (UiCmd) para a tarefa de rede —
// nunca faz HTTP diretamente.
// ============================================================
#pragma once
#include "painel_model.h"

typedef PCmd UiCmd;                    // id + ação + valor (painel_model.h)
typedef void (*UiCmdFn)(const UiCmd &cmd);

struct UiConn {
  bool wifi;          // Wi-Fi conectado
  bool online;        // última consulta ao servidor deu certo
  uint32_t ageS;      // segundos desde a última atualização
  char clock[8];      // "14:05" ("" = sem NTP)
  char date[24];      // "qua, 15 out"
};

// modoComodo = tela de 7" de um cômodo (nome em `comodo`); senão, corredor (casa toda)
bool ui_begin(bool modoComodo, const char *comodo, UiCmdFn onCmd);
void ui_set_model(const PModel &m);    // chamada pela tarefa de rede (copia; thread-safe)
void ui_set_plan(const PPlan &p);      // planta do app (corredor): copia; thread-safe
void ui_set_conn(const UiConn &c);     // idem
void ui_set_brightness(int pct);       // luz de fundo (P4: PWM; 7": liga/desliga)

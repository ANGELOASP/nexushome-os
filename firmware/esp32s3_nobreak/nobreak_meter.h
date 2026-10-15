// ============================================================
// NexusHome OS — Nobreak: estado de um medidor do barramento D
// (fica num .h porque o Arduino gera os protótipos das funções do .ino ANTES das
// structs declaradas nele — readPzem016(…, Meter&) não compilaria)
// ============================================================
#pragma once
#include <stdint.h>

struct Meter {
  uint8_t addr;
  bool dc;                 // true = PZEM-017
  const char* model;
  const char* role;
  bool ok;                 // respondendo (até METER_FAILS_OFF falhas seguidas)
  bool answered;           // respondeu na ÚLTIMA volta
  uint8_t fails;
  bool offAlerted;         // já avisou "sem resposta" neste episódio
  float v, a, w, kwh, hz, pf;
  bool hvAlarm, lvAlarm;   // só PZEM-017
};

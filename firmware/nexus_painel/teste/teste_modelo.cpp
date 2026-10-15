// Teste do modelo do painel (g++ no PC) — rodado por tests/painel-firmware.test.mjs
#include "../painel_model.h"
#include <cassert>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
static PModel m;
static const PDev* find(const char* tail) { for (int i = 0; i < m.nDevs; i++) { size_t L = strlen(m.devs[i].id), T = strlen(tail); if (L >= T && !strcmp(m.devs[i].id + L - T, tail)) return &m.devs[i]; } return nullptr; }
int main(int argc, char** argv) {
  if (argc < 2) { fprintf(stderr, "uso: teste snapshot.json\n"); return 2; }
  std::ifstream f(argv[1]); std::stringstream ss; ss << f.rdbuf(); std::string js = ss.str();
  assert(pm_parse(js.c_str(), js.size(), m));
  assert(m.h.watts == 1235); assert(m.h.water == 42); assert(m.h.level == 81); assert(m.h.soc == 63);
  assert(m.h.gridOk == 0); assert(m.h.health == HEALTH_CRIT); assert(m.nAlerts == 1); assert(m.alerts[0].sev == HEALTH_CRIT);
  assert(m.nDevs == 9);                      // medidor total sem relé fica fora
  const PDev* luz = find("0001"); assert(luz && luz->on == 1 && (luz->acts & ACT_POWER) && (luz->acts & ACT_BRI));
  char a[16], v[16], st[48], body[200]; bool conf;
  assert(pm_tap_command(*luz, a, sizeof a, v, sizeof v, &conf) && !strcmp(a, "power") && !strcmp(v, "false") && !conf);
  pm_command_body(body, sizeof body, luz->id, a, v);
  assert(!strcmp(body, "{\"device_id\":\"b3000000-0000-4000-8000-000000000001\",\"action\":\"power\",\"value\":false}"));
  const PDev* ger = find("0012"); assert(ger && ger->lock && ger->open == 0);
  assert(!pm_tap_command(*ger, a, sizeof a, v, sizeof v, &conf));   // travada: não reabre pelo painel
  const PDev* ram = find("0011"); assert(pm_tap_command(*ram, a, sizeof a, v, sizeof v, &conf) && !strcmp(a, "valve") && !strcmp(v, "false") && conf);
  const PDev* ch = find("0013"); assert(pm_tap_command(*ch, a, sizeof a, v, sizeof v, &conf) && conf);   // circuito: confirma
  pm_state_text(*ch, st, sizeof st); assert(!strcmp(st, "Ligado · 7,6 kW"));
  const PDev* ac = find("0014"); pm_state_text(*ac, st, sizeof st); assert(!strcmp(st, "Ligado · 22,0°C"));
  const PDev* al = find("0015"); assert(!pm_tap_command(*al, a, sizeof a, v, sizeof v, &conf)); pm_state_text(*al, st, sizeof st); assert(!strcmp(st, "Armado (ausente)"));
  assert(pm_active(*al));
  pm_command_body(body, sizeof body, al->id, "armed", "home"); assert(strstr(body, "\"value\":\"home\""));
  pm_command_body(body, sizeof body, al->id, "temp", "23"); assert(strstr(body, "\"value\":23}"));
  char w[16]; pm_fmt_watts(w, sizeof w, 850.4f); assert(!strcmp(w, "850 W")); pm_fmt_watts(w, sizeof w, 12345); assert(!strcmp(w, "12,3 kW"));
  pm_fmt_temp(w, sizeof w, -2.25f); assert(!strcmp(w, "-2,3°C") || !strcmp(w, "-2,2°C"));
  char u[64]; pm_urlencode(u, sizeof u, "Área Externa"); assert(!strcmp(u, "%C3%81rea%20Externa"));
  assert(!pm_parse("{lixo", 5, m)); assert(!pm_parse("{\"v\":2}", 7, m));
  // JSON maior que o limite de aparelhos: corta sem estourar
  std::string big = "{\"v\":1,\"house\":{},\"rooms\":[],\"alerts\":[],\"devices\":[";
  for (int i = 0; i < 150; i++) { big += (i ? "," : ""); big += "{\"id\":\"x\",\"n\":\"y\",\"t\":\"light\",\"act\":[\"power\"],\"on\":true}"; }
  big += "]}";
  assert(pm_parse(big.c_str(), big.size(), m) && m.nDevs == PANEL_MAX_DEVS);
  printf("OK modelo do painel: %d testes\n", 24);
}

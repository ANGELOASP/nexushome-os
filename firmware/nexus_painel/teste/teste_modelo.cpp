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
  if (argc < 2) { fprintf(stderr, "uso: teste snapshot.json [plan.json]\n"); return 2; }
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
  // ---- D9: circuito travado por sobrecarga (lock/trip) não oferece religar; travado e LIGADO pode desligar ----
  {
    static PModel t;
    const char *js = "{\"v\":1,\"house\":{},\"devices\":["
      "{\"id\":\"c1\",\"n\":\"Chuveiro\",\"t\":\"meter\",\"on\":false,\"lock\":true,\"act\":[\"power\"]},"
      "{\"id\":\"c2\",\"n\":\"Forno\",\"t\":\"meter\",\"on\":true,\"lock\":true,\"act\":[\"power\"]},"
      "{\"id\":\"c3\",\"n\":\"Tomada\",\"t\":\"plug\",\"on\":false,\"act\":[\"power\"]}]}";
    assert(pm_parse(js, strlen(js), t) && t.nDevs == 3 && t.devs[0].lock);
    assert(!pm_tap_command(t.devs[0], a, sizeof a, v, sizeof v, &conf));                     // desarmado: só no quadro
    assert(pm_tap_command(t.devs[1], a, sizeof a, v, sizeof v, &conf) && !strcmp(v, "false") && conf);   // travado ligado: desligar pode
    assert(pm_tap_command(t.devs[2], a, sizeof a, v, sizeof v, &conf) && !strcmp(v, "true") && !conf);
    pm_state_text(t.devs[0], st, sizeof st); assert(!strcmp(st, "TRAVADO"));
  }
  // ---- D3: janela de confirmação guarda id + ação + valor; no clique acha PELO ID no snapshot novo ----
  {
    static PModel a1, a2;
    const char *s1 = "{\"v\":1,\"house\":{},\"devices\":["
      "{\"id\":\"portao\",\"n\":\"Portão\",\"t\":\"gate\",\"open\":false,\"act\":[\"open\"]},"
      "{\"id\":\"agua\",\"n\":\"Água geral\",\"t\":\"valve\",\"open\":true,\"act\":[\"valve\"]},"
      "{\"id\":\"ckt\",\"n\":\"Circuito 4\",\"t\":\"meter\",\"on\":true,\"act\":[\"power\"]}]}";
    assert(pm_parse(s1, strlen(s1), a1) && a1.nDevs == 3);
    PCmd c; bool cf;
    assert(pm_tap_cmd(a1.devs[1], c, &cf) && cf);                    // "Fechar agora?" na válvula (índice 1)
    assert(!strcmp(c.id, "agua") && !strcmp(c.action, "valve") && !strcmp(c.value, "false"));
    // 3 s depois: lista reordenada (portão saiu da frente), válvula já fechada por outro lugar
    const char *s2 = "{\"v\":1,\"house\":{},\"devices\":["
      "{\"id\":\"ckt\",\"n\":\"Circuito 4\",\"t\":\"meter\",\"on\":true,\"act\":[\"power\"]},"
      "{\"id\":\"portao\",\"n\":\"Portão\",\"t\":\"gate\",\"open\":false,\"act\":[\"open\"]},"
      "{\"id\":\"agua\",\"n\":\"Água geral\",\"t\":\"valve\",\"open\":false,\"act\":[\"valve\"]}]}";
    assert(pm_parse(s2, strlen(s2), a2));
    assert(pm_find_dev(a2, "agua") == 2 && pm_find_dev(a2, "portao") == 1 && pm_find_dev(a2, "nada") == -1 && pm_find_dev(a2, "") == -1);
    assert(pm_cmd_target(a2, c) == 2);                               // mesmo aparelho, pelo id (não o índice 1 = portão)
    assert(!strcmp(c.value, "false"));                               // valor da abertura: fechar continua fechar (não vira abrir)
    pm_command_body(body, sizeof body, c.id, c.action, c.value);
    assert(!strcmp(body, "{\"device_id\":\"agua\",\"action\":\"valve\",\"value\":false}"));
    // aparelho sumiu da lista → não envia
    const char *s3 = "{\"v\":1,\"house\":{},\"devices\":[{\"id\":\"ckt\",\"n\":\"Circuito 4\",\"t\":\"meter\",\"on\":false,\"act\":[\"power\"]}]}";
    assert(pm_parse(s3, strlen(s3), a2) && pm_cmd_target(a2, c) == -1);
    // pedido de ligar um circuito que travou (sobrecarga) enquanto a janela estava aberta → não envia
    PCmd on; pm_cmd_set(on, "ckt", "power", "true");
    assert(pm_cmd_target(a2, on) == 0);
    a2.devs[0].lock = true;
    assert(pm_cmd_target(a2, on) == -1);
    PCmd off; pm_cmd_set(off, "ckt", "power", "false"); assert(pm_cmd_target(a2, off) == 0);   // desligar o travado pode
    PCmd arm; pm_cmd_set(arm, "ckt", "brightness", "40"); assert(pm_cmd_target(a2, arm) == 0);
    // campos cortados sem estourar
    PCmd lg; pm_cmd_set(lg, "0123456789012345678901234567890123456789", "brightness", "123456789012345");
    assert(strlen(lg.id) == 36 && !strcmp(lg.action, "brightness") && strlen(lg.value) == 11);
  }
  // ---- P3: cômodo comparado como o servidor (toLowerCase + trim), inclusive letras acentuadas ----
  assert(pm_same_room("Área Externa", "área externa"));
  assert(pm_same_room("  ÁREA EXTERNA ", "Área Externa"));
  assert(pm_same_room("SALA DE ESTAR", "sala de estar"));
  assert(pm_same_room("Cozinha", "cozinha\t"));
  assert(pm_same_room("ÇÃÕÉÊÍÓÔÚÀÂ", "çãõéêíóôúàâ"));
  assert(!pm_same_room("Area Externa", "Área Externa"));            // o servidor também não junta "A" com "Á"
  assert(!pm_same_room("Cozinha", "Cozinha 2"));
  assert(!pm_same_room("Cozinha 2", "Cozinha"));
  assert(!pm_same_room("Sala", ""));
  assert(pm_same_room("", "   "));
  assert(pm_same_room(nullptr, ""));
  assert(!pm_parse("{lixo", 5, m)); assert(!pm_parse("{\"v\":2}", 7, m));
  // JSON maior que o limite de aparelhos: corta sem estourar
  std::string big = "{\"v\":1,\"house\":{},\"rooms\":[],\"alerts\":[],\"devices\":[";
  for (int i = 0; i < 150; i++) { big += (i ? "," : ""); big += "{\"id\":\"x\",\"n\":\"y\",\"t\":\"light\",\"act\":[\"power\"],\"on\":true}"; }
  big += "]}";
  assert(pm_parse(big.c_str(), big.size(), m) && m.nDevs == PANEL_MAX_DEVS);
  // ---- planta (segundo argumento: plan.json gerado pelo servidor) ----
  if (argc >= 3) {
    static PPlan pl;
    std::ifstream fp(argv[2]); std::stringstream sp; sp << fp.rdbuf(); std::string pj = sp.str();
    assert(pm_parse_plan(pj.c_str(), pj.size(), pl));
    assert(pl.nRooms == 10 && pl.nWalls == 129);
    for (int i = 0; i < pl.nRooms; i++) {
      const PRoom &r = pl.rooms[i];
      float area = 0;
      for (int a = 0, b = r.n - 1; a < r.n; b = a++) area += r.x[b] * r.z[a] - r.x[a] * r.z[b];
      area = fabsf(area) / 2;
      uint8_t tri[3 * PLAN_MAX_PTS];
      int nt = pm_triangulate(r.x, r.z, r.n, tri, PLAN_MAX_PTS);
      float ta = pm_tri_area(r.x, r.z, tri, nt);
      if (fabsf(ta - area) > 0.02f * area + 0.01f) { fprintf(stderr, "%s: área %.3f × triângulos %.3f (%d)\n", r.name, area, ta, nt); return 1; }
      // um ponto dentro do primeiro triângulo tem de cair neste cômodo
      float px = (r.x[tri[0]] + r.x[tri[1]] + r.x[tri[2]]) / 3, pz = (r.z[tri[0]] + r.z[tri[1]] + r.z[tri[2]]) / 3;
      assert(pm_point_in_room(r, px, pz));
    }
    // retrato do P4 (área 768 × 560): a casa (≈13 × 17 m) cabe melhor girada
    PFit f = pm_plan_fit(pl, 768, 560, 12);
    assert(f.rot && f.s > 20);
    int x0, y0, x1, y1;
    pm_plan_px(f, pl.minX, pl.minZ, &x0, &y0); pm_plan_px(f, pl.maxX, pl.maxZ, &x1, &y1);
    assert(x0 >= 0 && x0 <= 768 && x1 >= 0 && x1 <= 768 && y0 >= 0 && y0 <= 560 && y1 >= 0 && y1 <= 560);
    float wx, wz; int qx, qy; pm_plan_px(f, 1.5f, 2.0f, &qx, &qy); pm_plan_world(f, qx, qy, &wx, &wz);
    assert(fabsf(wx - 1.5f) < 0.1f && fabsf(wz - 2.0f) < 0.1f);
    // toque no meio da cozinha (ponto interno) acha a Cozinha
    int k = -1; for (int i = 0; i < pl.nRooms; i++) if (!strcmp(pl.rooms[i].name, "Cozinha")) k = i;
    assert(k >= 0);
    uint8_t tri[3 * PLAN_MAX_PTS]; pm_triangulate(pl.rooms[k].x, pl.rooms[k].z, pl.rooms[k].n, tri, PLAN_MAX_PTS);
    const PRoom &kr = pl.rooms[k];
    int tx, ty; pm_plan_px(f, (kr.x[tri[0]] + kr.x[tri[1]] + kr.x[tri[2]]) / 3, (kr.z[tri[0]] + kr.z[tri[1]] + kr.z[tri[2]]) / 3, &tx, &ty);
    assert(pm_plan_room_at(pl, f, tx, ty) == k);
    assert(pm_plan_room_at(pl, f, 0, 0) == -1);
    assert(pm_hex_color("#fbbf24") == 0xFBBF24);
    // assinatura: o /panel com a mesma `ps` não pede a planta de novo; outra `ps` (planta editada no app) pede
    assert(strlen(pl.sig) == 8);
    std::string same = std::string("{\"v\":1,\"house\":{},\"devices\":[],\"ps\":\"") + pl.sig + "\"}";
    assert(pm_parse(same.c_str(), same.size(), m) && !pm_plan_changed(m, pl));
    const char *edited = "{\"v\":1,\"house\":{},\"devices\":[],\"ps\":\"0badf00d\"}";
    assert(pm_parse(edited, strlen(edited), m) && pm_plan_changed(m, pl));
    const char *noSig = "{\"v\":1,\"house\":{},\"devices\":[]}";
    assert(pm_parse(noSig, strlen(noSig), m) && !pm_plan_changed(m, pl));   // painel de cômodo: sem `ps`
    printf("OK planta: %d cômodos, %d paredes, escala %.1f px/m%s\n", pl.nRooms, pl.nWalls, f.s, f.rot ? " (girada)" : "");
  }
  // ---- terceiro argumento: circuitos desarmados por sobrecarga (trip) como o servidor manda ----
  if (argc >= 4) {
    std::ifstream ft(argv[3]); std::stringstream stt; stt << ft.rdbuf(); std::string tj = stt.str();
    assert(pm_parse(tj.c_str(), tj.size(), m));
    const PDev* off = find("0020"); const PDev* on = find("0021");
    assert(off && off->lock && off->on == 0 && (off->acts & ACT_POWER));
    assert(!pm_tap_command(*off, a, sizeof a, v, sizeof v, &conf));            // não oferece religar
    assert(on && on->lock && pm_tap_command(*on, a, sizeof a, v, sizeof v, &conf) && !strcmp(v, "false"));
    printf("OK trip: circuito travado não religa pelo painel\n");
  }
  printf("OK modelo do painel: %d testes\n", 56);
}

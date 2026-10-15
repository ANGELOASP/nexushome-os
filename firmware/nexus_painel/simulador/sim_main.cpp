// Simulador do painel: LVGL desenhando num framebuffer, dados do servidor (JSON).
#include "Arduino.h"
#include <lvgl.h>
#include "lvgl_v8_port.h"
#include "ui.h"
#include <fstream>
#include <sstream>
#include <string>
uint32_t sim_ms = 0;
static int W = 800, H = 1280;
static lv_color_t *fb;
static int touchX = -1, touchY = -1;
static void flush(lv_disp_drv_t *d, const lv_area_t *a, lv_color_t *px) {
  for (int y = a->y1; y <= a->y2; y++) for (int x = a->x1; x <= a->x2; x++) fb[y * W + x] = *px++;
  lv_disp_flush_ready(d);
}
static void touch(lv_indev_drv_t *, lv_indev_data_t *d) {
  static int lx = 0, ly = 0; if (touchX >= 0) { lx = touchX; ly = touchY; } d->point.x = lx; d->point.y = ly;
  d->state = touchX >= 0 ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}
bool lvgl_port_init(esp_panel::drivers::LCD*, esp_panel::drivers::Touch*) {
  static lv_disp_draw_buf_t db; static lv_disp_drv_t dd; static lv_indev_drv_t id;
  lv_color_t *buf = (lv_color_t*)malloc(sizeof(lv_color_t) * W * 100);
  lv_disp_draw_buf_init(&db, buf, nullptr, W * 100);
  lv_disp_drv_init(&dd); dd.hor_res = W; dd.ver_res = H; dd.flush_cb = flush; dd.draw_buf = &db; lv_disp_drv_register(&dd);
  lv_indev_drv_init(&id); id.type = LV_INDEV_TYPE_POINTER; id.read_cb = touch; lv_indev_drv_register(&id);
  return true;
}
static void run(int ms) { for (int t = 0; t < ms; t += 5) { sim_ms += 5; lv_tick_inc(5); lv_timer_handler(); } }
static void save(const char *path) {
  FILE *f = fopen(path, "wb"); fprintf(f, "P6\n%d %d\n255\n", W, H);
  for (int i = 0; i < W * H; i++) { lv_color_t c = fb[i]; uint8_t rgb[3] = { (uint8_t)(c.ch.red << 3), (uint8_t)(c.ch.green << 2), (uint8_t)(c.ch.blue << 3) }; fwrite(rgb, 1, 3, f); }
  fclose(f);
}
static std::string slurp(const char *p) { std::ifstream f(p); std::stringstream s; s << f.rdbuf(); return s.str(); }
static void cmd(const UiCmd &c) { printf("[cmd] %s %s=%s\n", c.id, c.action, c.value); }
int main(int argc, char **argv) {
  // uso: sim W H modo(corredor|comodo) comodo snap.json plan.json saida_prefixo [toqueX toqueY]
  W = atoi(argv[1]); H = atoi(argv[2]);
  bool room = !strcmp(argv[3], "comodo");
  fb = (lv_color_t*)calloc(W * H, sizeof(lv_color_t));
  lv_init();
  ui_begin(room, argv[4], cmd);
  static PModel m; std::string s = slurp(argv[5]);
  if (!pm_parse(s.c_str(), s.size(), m)) { fprintf(stderr, "snapshot inválido\n"); return 1; }
  static PPlan p; std::string pj = slurp(argv[6]);
  if (!pm_parse_plan(pj.c_str(), pj.size(), p)) { fprintf(stderr, "planta inválida\n"); return 1; }
  UiConn c = { true, true, 2, "14:05", "qua, 15 out" };
  ui_set_conn(c); ui_set_model(m); if (!room) ui_set_plan(p);
  run(1500);
  std::string out = argv[7];
  save((out + "-1.ppm").c_str());
  if (argc >= 10) {                                // toque (ex.: num cômodo da planta)
    touchX = atoi(argv[8]); touchY = atoi(argv[9]); run(120); touchX = touchY = -1; run(1200);
    save((out + "-2.ppm").c_str());
  }
  printf("ok\n");
  return 0;
}

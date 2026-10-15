#!/usr/bin/env bash
# Simulador da tela do painel de parede (sem placa): compila o LVGL 8.4 e o ui.cpp do
# firmware com g++, desenha num framebuffer e salva PNGs — a mesma interface que vai
# para o ESP32-P4 (10,1") e para o ESP32-S3 (7"), com a planta real da casa.
# uso: firmware/nexus_painel/simulador/rodar.sh [pasta-de-saída]
#      NEXUS_DEVICE_KEY=... rodar.sh   → inclui producao-1.png com a planta atual do app
# precisa: g++, node, python3 + Pillow, e as bibliotecas lvgl 8.4 e ArduinoJson 7
#   (LVGL_DIR e ARDUINOJSON_DIR; padrão: as do arduino-cli em ~/Arduino/libraries).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
FW="$(dirname "$AQUI")"
OUT="${1:-$AQUI/saida}"
LVGL_DIR="${LVGL_DIR:-$HOME/Arduino/libraries/lvgl}"
AJ_DIR="${ARDUINOJSON_DIR:-$HOME/Arduino/libraries/ArduinoJson}"
B="$OUT/build"; mkdir -p "$B/obj"
cp "$FW/lv_conf.h" "$B/" && sed -i 's/#define LV_USE_LOG 1/#define LV_USE_LOG 0/' "$B/lv_conf.h"
if [ ! -f "$B/liblvgl.a" ]; then
  echo "compilando o LVGL (uma vez)..."
  i=0; find "$LVGL_DIR/src" -name '*.c' | while read -r f; do
    i=$((i+1)); gcc -c -O1 -w -DLV_CONF_INCLUDE_SIMPLE -I"$B" -I"$LVGL_DIR" "$f" -o "$B/obj/$i.o"
  done
  ar rcs "$B/liblvgl.a" "$B"/obj/*.o
fi
for f in nh_font_16 nh_font_20 nh_font_24 nh_font_48; do
  gcc -c -O1 -w -DLV_CONF_INCLUDE_SIMPLE -DLV_LVGL_H_INCLUDE_SIMPLE -I"$B" -I"$LVGL_DIR" -I"$LVGL_DIR/src" "$FW/$f.c" -o "$B/$f.o"
done
cp "$FW/ui.cpp" "$B/ui_sim.cpp"            # ui.cpp + os stubs desta pasta (placa, porta LVGL, FreeRTOS)
cp "$AQUI"/Arduino.h "$AQUI"/esp_display_panel.hpp "$AQUI"/lvgl_v8_port.h "$B/"
g++ -std=c++17 -O1 -w -DLV_CONF_INCLUDE_SIMPLE -I"$B" -I"$FW" -I"$LVGL_DIR" -I"$AJ_DIR/src" \
  "$B/ui_sim.cpp" "$AQUI/sim_main.cpp" "$B"/nh_font_*.o "$B/liblvgl.a" -o "$B/sim"
node "$AQUI/gerar-dados.mjs" normal "$B" && node "$AQUI/gerar-dados.mjs" alarme "$B"
cd "$B"
./sim 800 1280 corredor "" snap-normal.json plan.json corredor 300 330
./sim 800 1280 corredor "" snap-alarme.json plan.json corredor-alarme
./sim 1280 800 corredor "" snap-normal.json plan.json corredor-deitado
./sim 800 480 comodo "Cozinha" snap-alarme.json plan.json comodo-cozinha
# com NEXUS_DEVICE_KEY no ambiente: também a planta e os aparelhos ATUAIS do NexusHome (produção)
if [ -n "${NEXUS_DEVICE_KEY:-}" ] && node "$AQUI/gerar-dados.mjs" producao "$B"; then
  ./sim 800 1280 corredor "" snap-producao.json plan-producao.json producao
fi
python3 - "$OUT" <<'PY'
import sys, glob, os
from PIL import Image
out = sys.argv[1]
for p in glob.glob('*.ppm'):
    Image.open(p).save(os.path.join(out, p[:-4] + '.png'))
print('PNGs em', out)
PY

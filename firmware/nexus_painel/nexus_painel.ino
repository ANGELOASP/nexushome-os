// ============================================================
// NexusHome OS — Painel de parede (v2.16)
// ------------------------------------------------------------
// Um firmware para as telas que NÃO ficam no quadro (docs/projeto-unificado.md §13):
//   · corredor: Waveshare ESP32-P4-NANO + 10.1-DSI-TOUCH-A (800×1280, PoE) — casa toda
//   · cômodos:  Waveshare ESP32-S3-Touch-LCD-7 (800×480)                     — um cômodo
// A placa sai do chip escolhido na IDE (esp_panel_board_supported_conf.h): P4 ou S3.
//
// O painel é um CLIENTE do NexusHome: lê GET /iot-gateway/panel a cada 3 s e manda os
// toques para POST /iot-gateway/panel/command. Nunca entra no RS-485 (quem manda nos
// barramentos são as telas 4,3" do quadro). Sem internet, mostra o último estado.
//
// Gravar: scripts/instalar-arduino.ps1 -Firmware painel -Placa p4|s3-7 -Porta COMx
// Bibliotecas: ESP32_Display_Panel 1.0.4, lvgl 8.4.0, ArduinoJson 7.4.2 · core esp32 3.3.12
//   P4:  esp32:esp32:esp32p4:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled
//   S3:  esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc
// ============================================================
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include "painel_model.h"
#include "ui.h"

// ---------------- Configuração (o instalador preserva estas linhas) ----------------
#define WIFI_SSID       "SUA_REDE_WIFI"
#define WIFI_PASSWORD   "SUA_SENHA_WIFI"
#define DEVICE_SECRET   "COLE_AQUI_O_IOT_DEVICE_SECRET"
#define PAINEL_MODO     PAINEL_MODO_CORREDOR   // PAINEL_MODO_CORREDOR (casa toda) ou PAINEL_MODO_COMODO
#define PAINEL_COMODO   "Cozinha"              // nome EXATO do cômodo no app (só no modo cômodo)

#define PAINEL_MODO_CORREDOR 0
#define PAINEL_MODO_COMODO   1

#define GATEWAY_BASE    "https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway"
#define POLL_MS         3000UL      // consulta ao servidor
#define POLL_FAIL_MS    10000UL     // depois de uma falha, espera mais
#define TZ_BRASIL       "<-03>3"     // horário de Brasília (sem horário de verão)
#define BRILHO_DIA      100          // % da luz de fundo
#define BRILHO_NOITE    25           // 22h–6h
#define USE_DISPLAY     1            // 0 = só rede/serial (teste sem tela)

static QueueHandle_t cmdQ;
static PModel netModel;              // grande: fica fora da pilha da tarefa
static char *httpBuf = nullptr;      // resposta do /panel
static const size_t HTTP_BUF = 48 * 1024;

static void onUiCmd(const UiCmd &c) {
  if (cmdQ) xQueueSend(cmdQ, &c, 0);
}

// ---------------- HTTP ----------------
static int postCommand(const UiCmd &c) {
  HTTPClient http;
  http.begin(GATEWAY_BASE "/panel/command");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(6000);
  char body[160];
  pm_command_body(body, sizeof(body), c.id, c.action, c.value);
  int code = http.POST((uint8_t *)body, strlen(body));
  if (code != 200) Serial.printf("[cmd] %s %s=%s → HTTP %d %s\n", c.id, c.action, c.value, code,
                                 code > 0 ? http.getString().c_str() : "");
  else Serial.printf("[cmd] %s %s=%s ok\n", c.id, c.action, c.value);
  http.end();
  return code;
}

// GET /panel → httpBuf; devolve o tamanho lido (<0 = erro)
static int fetchPanel() {
  char url[200];
  if (PAINEL_MODO == PAINEL_MODO_COMODO) {
    char room[96];
    pm_urlencode(room, sizeof(room), PAINEL_COMODO);
    snprintf(url, sizeof(url), GATEWAY_BASE "/panel?limit=%d&room=%s", PANEL_MAX_DEVS, room);
  } else {
    snprintf(url, sizeof(url), GATEWAY_BASE "/panel?limit=%d", PANEL_MAX_DEVS);
  }
  HTTPClient http;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(8000);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[panel] HTTP %d %s\n", code, code > 0 ? http.getString().c_str() : "");
    http.end();
    return -1;
  }
  WiFiClient *s = http.getStreamPtr();
  int len = http.getSize();                       // -1 = chunked
  size_t n = 0;
  unsigned long t0 = millis();
  while (http.connected() && (len < 0 || (int)n < len) && n < HTTP_BUF - 1 && millis() - t0 < 8000) {
    size_t avail = s->available();
    if (!avail) { delay(5); continue; }
    n += s->readBytes(httpBuf + n, min(avail, HTTP_BUF - 1 - n));
  }
  httpBuf[n] = 0;
  http.end();
  return (int)n;
}

// ---------------- relógio e brilho ----------------
static void fillConn(UiConn &c, bool online, uint32_t ageS) {
  c.wifi = WiFi.status() == WL_CONNECTED;
  c.online = online;
  c.ageS = ageS;
  c.clock[0] = c.date[0] = 0;
  time_t now = time(nullptr);
  if (now > 1700000000) {
    struct tm t; localtime_r(&now, &t);
    static const char *DIAS[] = { "dom", "seg", "ter", "qua", "qui", "sex", "sáb" };
    static const char *MESES[] = { "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez" };
    snprintf(c.clock, sizeof(c.clock), "%02d:%02d", t.tm_hour, t.tm_min);
    snprintf(c.date, sizeof(c.date), "%s, %d %s", DIAS[t.tm_wday], t.tm_mday, MESES[t.tm_mon]);
  }
}

static int brightnessNow() {
  time_t now = time(nullptr);
  if (now < 1700000000) return BRILHO_DIA;
  struct tm t; localtime_r(&now, &t);
  return (t.tm_hour >= 22 || t.tm_hour < 6) ? BRILHO_NOITE : BRILHO_DIA;
}

// ---------------- tarefa de rede ----------------
static void netTask(void *) {
  unsigned long lastOk = 0, nextPoll = 0;
  bool ntp = false, online = false;
  int lastBright = -1;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      online = false;
      UiConn c; fillConn(c, false, lastOk ? (millis() - lastOk) / 1000 : 0);
#if USE_DISPLAY
      ui_set_conn(c);
#endif
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    if (!ntp) { configTzTime(TZ_BRASIL, "pool.ntp.org", "time.google.com"); ntp = true; }

    UiCmd cmd;
    while (xQueueReceive(cmdQ, &cmd, 0) == pdTRUE) {
      postCommand(cmd);
      nextPoll = 0;                                // mostra o resultado logo
    }
    if (millis() >= nextPoll) {
      int n = fetchPanel();
      if (n > 0 && pm_parse(httpBuf, n, netModel)) {
        online = true;
        lastOk = millis();
#if USE_DISPLAY
        ui_set_model(netModel);
#endif
        nextPoll = millis() + POLL_MS;
      } else {
        online = false;
        if (n > 0) Serial.println("[panel] resposta inválida");
        nextPoll = millis() + POLL_FAIL_MS;
      }
      UiConn c; fillConn(c, online, lastOk ? (millis() - lastOk) / 1000 : 0);
#if USE_DISPLAY
      ui_set_conn(c);
      int b = brightnessNow();
      if (b != lastBright) { ui_set_brightness(b); lastBright = b; }
#endif
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ---------------- serial (bancada) ----------------
static void handleSerial() {
  static String line;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch != '\n' && ch != '\r') { line += ch; continue; }
    line.trim();
    if (line == "status") {
      Serial.printf("[status] Wi-Fi %s IP %s · modo %s %s · %d aparelhos · energia %ld W · saúde %d\n",
                    WiFi.status() == WL_CONNECTED ? "ok" : "desligado", WiFi.localIP().toString().c_str(),
                    PAINEL_MODO == PAINEL_MODO_COMODO ? "cômodo" : "corredor",
                    PAINEL_MODO == PAINEL_MODO_COMODO ? PAINEL_COMODO : "", netModel.nDevs,
                    (long)netModel.h.watts, netModel.h.health);
    } else if (line == "lista") {
      for (int i = 0; i < netModel.nDevs; i++) {
        char st[48]; pm_state_text(netModel.devs[i], st, sizeof(st));
        Serial.printf("  %2d %-36s %-28s %s\n", i, netModel.devs[i].id, netModel.devs[i].name, st);
      }
    } else if (line.startsWith("toque ")) {          // toque N: simula um toque no aparelho N da lista
      int i = line.substring(6).toInt();
      char a[16], v[16]; bool conf;
      if (i >= 0 && i < netModel.nDevs && pm_tap_command(netModel.devs[i], a, sizeof(a), v, sizeof(v), &conf)) {
        UiCmd c; pm_copy(c.id, sizeof(c.id), netModel.devs[i].id); pm_copy(c.action, sizeof(c.action), a); pm_copy(c.value, sizeof(c.value), v);
        onUiCmd(c);
      } else Serial.println("[toque] nada a fazer nesse aparelho");
    } else if (line.length()) {
      Serial.println("comandos: status · lista · toque N");
    }
    line = "";
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n[NexusHome] painel de parede v2.16 — %s\n",
                PAINEL_MODO == PAINEL_MODO_COMODO ? "cômodo: " PAINEL_COMODO : "corredor (casa toda)");
  httpBuf = (char *)ps_malloc(HTTP_BUF);
  if (!httpBuf) httpBuf = (char *)malloc(HTTP_BUF);
  memset(&netModel, 0, sizeof(netModel));
  cmdQ = xQueueCreate(8, sizeof(UiCmd));
#if USE_DISPLAY
  if (!ui_begin(PAINEL_MODO == PAINEL_MODO_COMODO, PAINEL_COMODO, onUiCmd))
    Serial.println("[tela] falha ao iniciar o display");
#endif
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  handleSerial();
  delay(20);
}

// ============================================================
// nh_tls.h — HTTPS com certificado verificado + watchdog (NexusHome OS)
// ------------------------------------------------------------
// CÓPIA IDÊNTICA nas 5 pastas de firmware (esp32s3_hidraulica, esp32s3_eletrica, esp32s3_seguranca,
// esp32s3_nobreak e nexus_painel): o Arduino só compila os arquivos da pasta do sketch.
// tests/firmware-tls-wdt.test.mjs confere que as cópias são iguais — mude todas juntas.
//
// HTTPS VERIFICADO
//   No core esp32 3.3.12, http.begin(url) sem certificado faz o HTTPClient chamar setInsecure()
//   (HTTPClient.cpp, TLSTraits::verify): o TLS aceitava QUALQUER certificado, e o x-device-key podia
//   ser capturado por um AP falso ou ARP spoof. Agora todo pedido passa por nhHttpsBegin(), que usa um
//   NetworkClientSecure com o PACOTE DE CAs RAIZ que o próprio core embute
//   (useBuiltinCACertBundle → esp_crt_bundle_attach; sdkconfig do core: CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y,
//   pacote completo da Mozilla). O pacote sobrevive à troca de emissor do *.supabase.co
//   (out/2026: WE1 → GTS Root R4; também tem ISRG Root X1/X2, GlobalSign, DigiCert, Baltimore...).
//   Datas: o core vem com CONFIG_MBEDTLS_HAVE_TIME_DATE desligado → o mbedTLS não confere a validade,
//   então o HTTPS NÃO depende do relógio (NTP) — confere a cadeia, a assinatura e o nome do servidor.
//
//   Diagnóstico: se a verificação falhar, a serial mostra "TLS: certificado recusado".
//   NEXUS_TLS_INSEGURO 1 volta ao comportamento antigo (sem verificar) — SÓ para diagnóstico, nunca
//   em uso normal. Para ligar, ponha  #define NEXUS_TLS_INSEGURO 1  no .ino ANTES de
//   #include "nh_tls.h" (não edite esta cópia: as 5 têm de continuar iguais).
//
// WATCHDOG
//   nhWdtInicia() no fim do setup(): põe a tarefa do loop() no watchdog de tarefas do ESP-IDF
//   (esp_task_wdt_reconfigure + esp_task_wdt_add) com NEXUS_WDT_TIMEOUT_S; o loop() chama
//   nhWdtAlimenta() a cada volta e o Modbus também (em mbSend: cada transação dura no máx. ~1 s,
//   mas uma volta com escravos mudos pode somar dezenas de segundos). Travou por mais de
//   NEXUS_WDT_TIMEOUT_S → reinício; o setup() devolve o estado gravado na NVS antes de comandar relés.
//   A tarefa de rede NÃO entra no watchdog de 15 s: um único HTTPS pode legitimamente passar disso
//   (DNS + conexão 5 s + handshake até NEXUS_TLS_HANDSHAKE_S + resposta 5–8 s) dentro da biblioteca,
//   onde não dá para alimentar. Ela dá "batidas" (nhRedeBatida, também em cada nhHttpsBegin) e o
//   loop() confere com nhRedeConfere(): sem batida por NEXUS_REDE_TRAVADA_MS, avisa na serial
//   (e, no painel de parede, reinicia).
// ============================================================
#pragma once
#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <esp_task_wdt.h>
#if __has_include(<mbedtls/x509.h>)
#include <mbedtls/x509.h>
#endif
#ifndef MBEDTLS_ERR_X509_CERT_VERIFY_FAILED
#define MBEDTLS_ERR_X509_CERT_VERIFY_FAILED -0x2700
#endif

#ifndef NEXUS_TLS_INSEGURO
#define NEXUS_TLS_INSEGURO 0          // 1 = HTTPS SEM verificar o certificado (só diagnóstico)
#endif
#define NEXUS_TLS_HANDSHAKE_S  15     // limite do handshake TLS (o padrão do core é 120 s)
#define NEXUS_WDT_TIMEOUT_S    15     // watchdog do loop(): maior que qualquer transação Modbus (≤ ~2,3 s)
#define NEXUS_REDE_TRAVADA_MS  180000UL   // tarefa de rede sem sinal por 3 min = travada (1 HTTPS ≤ ~1 min)

// ---------------- HTTPS ----------------
static volatile uint32_t nhRedeUltima = 0;     // millis() da última batida da tarefa de rede (0 = nenhuma)
static inline void nhRedeBatida() { nhRedeUltima = millis(); }

// Prepara o cliente seguro (pacote de CAs do core) — exposto para quem precisar de um cliente TLS avulso.
static inline void nhTlsPrepara(NetworkClientSecure &tls) {
#if NEXUS_TLS_INSEGURO
  tls.setInsecure();
#else
  tls.useBuiltinCACertBundle();
#endif
  tls.setHandshakeTimeout(NEXUS_TLS_HANDSHAKE_S);
}

// Substitui http.begin(url). Declare o NetworkClientSecure ANTES do HTTPClient (o HTTPClient é
// destruído primeiro e ainda fecha a conexão do cliente). Os timeouts (setTimeout) seguem no chamador.
static inline bool nhHttpsBegin(HTTPClient &http, NetworkClientSecure &tls, const String &url) {
  nhRedeBatida();
  nhTlsPrepara(tls);
  return http.begin(tls, url);
}

// Depois do GET/POST: se não houve resposta HTTP (código < 0), diz na serial se foi o TLS.
static inline void nhTlsConfere(NetworkClientSecure &tls, int httpCode, const char *tag) {
  if (httpCode >= 0) return;                   // o servidor respondeu: o TLS passou
  char msg[100];
  int e = tls.lastError(msg, sizeof(msg));
  if (e == 0) return;                          // caiu antes do TLS (Wi-Fi, DNS, TCP): o código HTTP já diz
  static uint32_t ultimo = 0;                  // no máx. 1 mensagem a cada 10 s (cada ciclo faz vários pedidos)
  if (ultimo && millis() - ultimo < 10000) return;
  ultimo = millis();
  if (e == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED)
    Serial.printf("[%s] TLS: certificado recusado (%s) — a rede pode estar interceptando o HTTPS (AP falso?) "
                  "ou o servidor trocou para uma CA fora do pacote do core. Diagnóstico: NEXUS_TLS_INSEGURO 1 (ver nh_tls.h)\n",
                  tag, msg);
  else
    Serial.printf("[%s] TLS: falha no handshake (%d: %s)\n", tag, e, msg);
}

// ---------------- Watchdog ----------------
// Chamada no fim do setup() (roda na tarefa do loop): 15 s para todos os inscritos (o core já vigia o
// IDLE do núcleo 0 com 5 s; a máscara mantém o que o sdkconfig pede) e inscreve a tarefa atual.
static inline void nhWdtInicia() {
  uint32_t idle = 0;
#if CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU0
  idle |= 1u << 0;
#endif
#if CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU1
  idle |= 1u << 1;
#endif
  esp_task_wdt_config_t cfg = { NEXUS_WDT_TIMEOUT_S * 1000u, idle, true };
  esp_err_t e = esp_task_wdt_reconfigure(&cfg);
  if (e == ESP_ERR_INVALID_STATE) e = esp_task_wdt_init(&cfg);   // core sem TWDT iniciado no boot
  if (e == ESP_OK && esp_task_wdt_status(NULL) != ESP_OK) e = esp_task_wdt_add(NULL);
  if (e == ESP_OK) Serial.printf("[wdt] watchdog do loop ligado (%d s)\n", NEXUS_WDT_TIMEOUT_S);
  else Serial.printf("[wdt] FALHA ao ligar o watchdog (erro %d)\n", (int)e);
#if NEXUS_TLS_INSEGURO
  Serial.println("[tls] ATENÇÃO: NEXUS_TLS_INSEGURO=1 — HTTPS SEM verificar o certificado (só diagnóstico)");
#else
  Serial.println("[tls] HTTPS com certificado verificado (pacote de CAs do core)");
#endif
}

// A cada volta do loop() e a cada transação Modbus. Fora de uma tarefa inscrita (ex.: no setup(),
// antes de nhWdtInicia) não faz nada.
static inline void nhWdtAlimenta() {
  if (esp_task_wdt_status(NULL) == ESP_OK) esp_task_wdt_reset();
}

// No loop(): a tarefa de rede está sem dar sinal há NEXUS_REDE_TRAVADA_MS? Avisa uma vez na serial;
// com reinicia = true (painel de parede, onde a rede é a função inteira) reinicia a placa.
static inline void nhRedeConfere(bool reinicia) {
  static bool avisou = false;
  uint32_t u = nhRedeUltima;
  if (!u || millis() - u <= NEXUS_REDE_TRAVADA_MS) { avisou = false; return; }
  if (!avisou) {
    Serial.printf("[wdt] tarefa de rede sem sinal há %lu s%s\n", (unsigned long)((millis() - u) / 1000),
                  reinicia ? " — reiniciando" : " — a proteção local continua; reinicie a placa se a telemetria não voltar");
    avisou = true;
  }
  if (reinicia) { delay(200); esp_restart(); }
}

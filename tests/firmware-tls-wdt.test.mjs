// HTTPS verificado + watchdog nos 5 firmwares (auditoria, fase 7: D10 e D7).
// Verificações de texto: nh_tls.h igual nas 5 pastas, nenhum http.begin() sem o cliente verificado
// (o HTTPClient do core 3.3.12 chama setInsecure() quando não recebe certificado) e todo loop()
// alimentando o watchdog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const src = (p) => readFileSync(join(root, p), 'utf8');
const FW = ['esp32s3_hidraulica', 'esp32s3_eletrica', 'esp32s3_seguranca', 'esp32s3_nobreak', 'nexus_painel'];
const QUADRO = FW.filter((f) => f.startsWith('esp32s3_'));
const ino = (f) => src(`firmware/${f}/${f}.ino`);
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// corpo da função (do "{" de `assinatura` até a chave que fecha)
function corpo(s, assinatura) {
  const i = s.indexOf(assinatura);
  assert.ok(i >= 0, `não achei ${assinatura}`);
  const a = s.indexOf('{', i);
  let d = 0;
  for (let k = a; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}' && --d === 0) return s.slice(a + 1, k);
  }
  throw new Error(`chaves desbalanceadas em ${assinatura}`);
}

test('nh_tls.h: uma cópia idêntica em cada pasta de sketch, incluída pelo .ino', () => {
  const base = src('firmware/esp32s3_hidraulica/nh_tls.h');
  for (const f of FW) {
    assert.equal(src(`firmware/${f}/nh_tls.h`), base, `${f}/nh_tls.h difere da cópia da hidráulica`);
    assert.match(ino(f), /^#include "nh_tls\.h"/m, `${f}.ino não inclui nh_tls.h`);
  }
});

test('nh_tls.h: pacote de CAs do core, modo inseguro desligado e diagnóstico na serial', () => {
  const h = src('firmware/esp32s3_hidraulica/nh_tls.h');
  assert.match(h, /#ifndef NEXUS_TLS_INSEGURO\s+#define NEXUS_TLS_INSEGURO 0\b/);
  assert.match(h, /#if NEXUS_TLS_INSEGURO\s+tls\.setInsecure\(\);\s+#else\s+tls\.useBuiltinCACertBundle\(\);/);
  assert.match(h, /return http\.begin\(tls, url\);/);
  assert.match(h, /TLS: certificado recusado/);
  assert.match(h, /MBEDTLS_ERR_X509_CERT_VERIFY_FAILED/);
  assert.match(h, /#define NEXUS_WDT_TIMEOUT_S\s+15\b/);
  assert.match(h, /esp_task_wdt_reconfigure\(&cfg\)/);
  assert.match(h, /esp_task_wdt_add\(NULL\)/);
  assert.match(h, /esp_task_wdt_reset\(\)/);
  // nenhum firmware liga o modo inseguro (só o comentário de diagnóstico pode existir)
  for (const f of FW) assert.doesNotMatch(semComentarios(ino(f)), /#define\s+NEXUS_TLS_INSEGURO\s+1/, f);
});

test('nenhum http.begin() sem o cliente verificado; cada pedido confere o TLS', () => {
  for (const f of FW) {
    const s = semComentarios(ino(f));
    assert.doesNotMatch(s, /\bhttp\.begin\s*\(/, `${f}: http.begin direto (TLS sem verificar)`);
    assert.doesNotMatch(s, /setInsecure/, f);
    const clientes = s.match(/HTTPClient\s+http\s*;/g) || [];
    assert.ok(clientes.length > 0, f);
    // o NetworkClientSecure vem logo antes (o http é destruído primeiro e ainda fecha a conexão)
    assert.equal((s.match(/NetworkClientSecure\s+tls\s*;\s*HTTPClient\s+http\s*;/g) || []).length, clientes.length, f);
    assert.equal((s.match(/nhHttpsBegin\(http, tls, /g) || []).length, clientes.length, f);
    const pedidos = (s.match(/int code = http\.(GET|POST)\([^;]*\);/g) || []).length;
    assert.equal(pedidos, clientes.length, `${f}: um GET/POST por cliente`);
    assert.equal((s.match(/int code = http\.(GET|POST)\([^;]*\);\s*nhTlsConfere\(tls, code, "[a-z]+"\);/g) || []).length,
      pedidos, `${f}: todo GET/POST passa por nhTlsConfere`);
  }
});

test('watchdog: setup() liga, loop() alimenta a cada volta, Modbus alimenta a cada transação', () => {
  for (const f of FW) {
    const s = semComentarios(ino(f));
    assert.match(corpo(s, 'void setup()'), /nhWdtInicia\(\);\s*$/, `${f}: nhWdtInicia() no fim do setup()`);
    assert.match(corpo(s, 'void loop()'), /^\s*nhWdtAlimenta\(\);/, `${f}: loop() começa alimentando o watchdog`);
    assert.match(corpo(s, 'void loop()'), /nhRedeConfere\((true|false)\);/, f);
  }
  for (const f of QUADRO) {
    const s = semComentarios(ino(f));
    assert.match(corpo(s, 'void mbSend('), /^\s*nhWdtAlimenta\(\);/, `${f}: mbSend alimenta o watchdog`);
    // uma transação Modbus (resposta + reconexão ao gateway) fica muito abaixo dos 15 s
    for (const m of s.matchAll(/#define MB_TIMEOUT(?:_TCP)?_MS\s+(\d+)/g)) assert.ok(Number(m[1]) + 1500 < 15000, `${f}: ${m[0]}`);
  }
  assert.match(corpo(semComentarios(ino('nexus_painel')), 'void loop()'), /nhRedeConfere\(true\);/);
});

test('tarefas de rede dão sinal de vida a cada volta', () => {
  for (const [f, tarefa] of [...QUADRO.map((q) => [q, 'void telemetryTask(']), ['nexus_painel', 'static void netTask(']]) {
    const t = corpo(semComentarios(ino(f)), tarefa);
    assert.match(t, /for \(;;\) \{[^}]*?nhRedeBatida\(\);/, `${f}: ${tarefa} sem nhRedeBatida()`);
  }
});

test('T1: reinício pelo watchdog não reabre a água (NVS restaurada antes do primeiro applyValves)', () => {
  const setup = corpo(semComentarios(ino('esp32s3_hidraulica')), 'void setup()');
  const iPrefs = setup.indexOf('prefs.begin("hidraulica", false);');
  const iLoad = setup.indexOf('loadState();');
  const iApply = setup.indexOf('applyValves();');
  const iWdt = setup.indexOf('nhWdtInicia();');
  assert.ok(iPrefs >= 0 && iPrefs < iLoad, 'namespace hidraulica aberto antes de loadState');
  assert.ok(iLoad < iApply, 'loadState() antes do primeiro applyValves()');
  assert.ok(iApply < iWdt, 'watchdog só depois do estado aplicado');
});

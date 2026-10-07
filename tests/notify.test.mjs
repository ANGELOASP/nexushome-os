import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, formatMessage, escapeHtml, safeEqual } from '../supabase/functions/notify-alert/format.ts';

test('shouldNotify: padrão só critical', () => {
  assert.equal(shouldNotify('critical'), true);
  assert.equal(shouldNotify('warning'), false);
  assert.equal(shouldNotify('info'), false);
});
test('shouldNotify: respeita o mínimo configurado', () => {
  assert.equal(shouldNotify('warning', 'warning'), true);
  assert.equal(shouldNotify('info', 'warning'), false);
  assert.equal(shouldNotify('info', 'info'), true);
  assert.equal(shouldNotify('critical', 'valor-invalido'), true); // mínimo inválido → critical
  assert.equal(shouldNotify('warning', 'valor-invalido'), false);
});
test('shouldNotify: severidade desconhecida ou ausente nunca notifica', () => {
  assert.equal(shouldNotify(undefined), false);
  assert.equal(shouldNotify('qualquer'), false);
});
test('formatMessage escapa HTML (parse_mode HTML do Telegram)', () => {
  const t = formatMessage({ severity: 'critical', message: 'Vazamento <b>&</b>', source_module: 'tuya' });
  assert.match(t, /CRÍTICO/);
  assert.match(t, /Vazamento &lt;b&gt;&amp;&lt;\/b&gt;/);
  assert.match(t, /tuya/);
});
test('formatMessage tolera campos ausentes', () => {
  assert.match(formatMessage({}), /sem mensagem/);
});
test('escapeHtml e safeEqual', () => {
  assert.equal(escapeHtml('a<b>&'), 'a&lt;b&gt;&amp;');
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

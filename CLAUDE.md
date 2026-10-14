# NexusHome OS — contexto para o Claude Code

Casa inteligente em tempo real (projeto sem fins lucrativos). O elemento principal é a **planta 3D**: o
painel controla e mostra dispositivos sobre ela. Versão atual: ver `package.json` (selo `vX` na barra superior).

## Como trabalhar com o dono do projeto

- **Responda sempre em português.**
- Ao terminar uma tarefa que precise de PR, **abra o PR sem pedir confirmação** (contra `main`).
- **Merge, SQL no Supabase e ações destrutivas ficam com o usuário.** Entregue o SQL pronto para ele colar no
  SQL Editor; nunca rode SQL no banco dele.
- Nunca faça force-push. Nunca peça para colar segredos (ex.: `IOT_DEVICE_SECRET`) no chat.
- Supabase: só o projeto **NexusHome** (`gfjxcsvxhaojbtuixpjh`).
- Toda migração nova = arquivo numerado em `supabase/migrations/` (idempotente, termina com
  `notify pgrst, 'reload schema';`) **e** o app deve continuar funcionando sem ela (gravar sem a coluna nova e
  avisar com um toast "execute a migração NNN").
- A cada versão: subir `version` em `package.json` e `VERSION` em `public/sw.js` (`nh-X.Y.Z`), e um bullet no README.

## Pilha

- SPA em JavaScript puro (módulos ES) + **Vite**; Tailwind via CDN; **Three.js r128** (CDN) para o 3D.
- **Supabase**: Postgres + RLS + Realtime + Edge Functions (`supabase/functions`: `iot-gateway`,
  `notify-alert`, `smartthings-proxy`, `tuya-proxy`).
- **Vercel**: deploy automático de `main` (preview por PR). Produção: https://nexushome-os.vercel.app
- **Firmware ESP32-S3** em `firmware/` (Arduino): `esp32s3_hidraulica` (válvulas/vazão/nível) e `esp32s3_eletrica`
  (33 PZEM-016 + relés dos subquadros, v2.11 — ver `docs/automacao-eletrica.md`); instalador em
  `scripts/instalar-arduino.ps1` (`-Firmware eletrica`).
- PWA (`public/sw.js`, manifest) com notificações push de alertas críticos.

## Mapa do código

| Arquivo | Papel |
|---|---|
| `js/app.js` | inicialização, login, realtime, trilhos de painéis |
| `js/state.js` | estado global + `on`/`emit` (eventos: `devices-changed`, `room-selected`, `rooms-changed`, `room-panel`, `editor-open`...) |
| `js/supabase-client.js` | cliente real ou **mock de demonstração** (dados em `localStorage`) |
| `js/scene3d.js` | cena 3D: cômodos, paredes, móveis, marcadores de dispositivos, câmera (entrar/fixar cômodo, voo) |
| `js/scene-furniture.js` / `js/furniture.js` | modelos 3D dos móveis / catálogo (medidas em m; `furnitureDims()` aplica tamanho personalizado) |
| `js/scene-devices.js` / `js/device-catalog.js` / `js/device-mount.js` | modelos 3D dos aparelhos / biblioteca de dispositivos / fixação automática (parede, acima da janela, sobre móvel, porta...) |
| `js/floorplan.js` | Editor de Planta 2D (cômodos, polígonos, paredes, portas/janelas, móveis, dispositivos, importação DXF) |
| `js/panels/*.js` | painéis: dispositivos, cenas, automações, cartão do cômodo, SmartThings, Tuya |
| `js/energy.js` | total de energia da casa (soma dos medidores; `in_total` nos circuitos do quadro elétrico) |
| `js/device-actions.js` | ações por tipo (automações/cenas/cartão do cômodo) — espelha as ações do `run_automations` (024) |
| `js/scene-devices-extra.js` | modelos 3D da biblioteca ampliada (v2.13: áudio, vídeo, computadores, eletrodomésticos...) |

Convenções: medidas em **metros**; giro em graus, frente do objeto = `(-sin rot, cos rot)`; no 3D
`rotation.y = -rot` e a escala é `METER = 1.9` unidades de cena por metro.

## Rodar e testar

```bash
npm install
npm run dev        # http://127.0.0.1:5173 — sem Supabase configurado entra no modo demonstração
npm test           # node --test tests/*.test.mjs
npm run build
```

- Login de demonstração: `demo@nexushome.local` / `demo1234`.
- Ganchos de teste (só em dev): `window.__fp` (editor), `window.__nh = { state, selectRoom }`,
  `window.__three = { renderer, scene }`.
- SQL: `tests/sql/run.sh` e `tests/sql/run_isolation.sh` (Postgres local).
- Navegador headless no contêiner: Playwright com Chromium em `/opt/pw-browsers` (`--use-gl=swiftshader`).

## Estado do banco (out/2026)

Migrações **001 a 023 aplicadas** pelo usuário no Supabase, **incluindo a 018** (isolamento por dono: tabelas com
`owner_id`). Seeds rodados: `supabase/seeds/eletrica.sql` (34 dispositivos `b2000000-…`, out/2026).

## Pendências conhecidas (do lado do usuário)

- Edge Functions publicadas pelo conector em 14/out/2026: `iot-gateway` v10 (comandos, fila offline, lote) e
  `notify-alert` v7 (Telegram + push). O push só sai com as chaves VAPID configuradas nos secrets.
- Reinstalar o firmware com `scripts/instalar-arduino.ps1` para ativar a fila offline do ESP32.
- v2.13 (biblioteca ampliada): rodar `024_device_library.sql` (tipos novos + ações volume/source/armed/open/vacuum).
- v2.11 (automação elétrica): 023 e seed já rodados; falta gravar o firmware quando a 2ª placa 4.3B chegar
  (`instalar-arduino.ps1 -Firmware eletrica -Porta COMx`). A tabela de circuitos é provisória até o usuário
  mandar o quadro de cargas. Decisão: interruptores das luzes em paralelo (three-way)
  com os relés; v2.12 trouxe a tela touch elétrica (uma placa 4.3B para a água, outra para a energia).

## Desempenho (lições)

- Luzes pontuais **sem sombra** (`castShadow = false`): cada uma custava 6 renderizações extras por quadro.
- Não reconstrua a cena/HTML a cada leitura de telemetria; compare assinatura/HTML antes de redesenhar.
- O voo da câmera só é cancelado por arrasto real ou roda do mouse (um clique parado não cancela).

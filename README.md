# NexusHome OS

Sistema operacional de casa inteligente em tempo real — SPA com visualização 3D isométrica, telemetria de recursos (energia/água), automações IFTTT e ponte IoT para ESP32. **Projeto sem fins lucrativos.**

![stack](https://img.shields.io/badge/stack-HTML5%20%C2%B7%20Tailwind%20CDN%20%C2%B7%20Vanilla%20JS%20%C2%B7%20Three.js%20r128%20%C2%B7%20Supabase-6366f1)

## Visão geral

- **Casa 3D interativa** (Three.js): 4 cômodos clicáveis — Sala de Estar, Quarto Principal, Cozinha e Área Externa — que reagem visualmente ao estado dos dispositivos (brilho/cor da luz, tonalidade fria do AC, válvula, medidor).
- **Telemetria em tempo real**: energia (W) e fluxo de água (L/h) com sparklines, badge de saúde (Seguro/Atenção/Crítico) e feed de alertas.
- **Segurança hídrica**: detecção de vazamento (fluxo > 0 por mais de 30 s com tudo desligado) e botão de emergência **FECHAR VÁLVULA DE ÁGUA GERAL**.
- **Automações IFTTT**: crie regras `SE métrica (operador) limiar ENTÃO ação no dispositivo`, com avaliador client-side (edge-trigger + cooldown).
- **Modo Demonstração**: sem backend? Sem problema — o app simula tudo no navegador.

## Início rápido (Modo Demonstração)

```bash
npm install
npm run dev
# abra http://localhost:5173
```

Sem nenhuma configuração, o app entra em **Modo Demonstração** (badge âmbar `● Demo`): um cliente Supabase simulado no navegador alimenta os 4 dispositivos, telemetria a cada 3–5 s, alertas e todas as funcionalidades da UI.

## Conectando ao Supabase (badge verde `● Supabase Live`)

1. Crie um projeto gratuito em [supabase.com](https://supabase.com).
2. **SQL Editor** → cole todo o conteúdo de [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) → **Run**. Isso cria as tabelas (`devices`, `automations`, `telemetry_logs`, `alerts`), políticas RLS permissivas, publicação realtime e os 4 dispositivos de exemplo.
3. Copie [`js/config.example.js`](js/config.example.js) para `js/config.js` e preencha:

   ```js
   window.NEXUSHOME_CONFIG = {
     SUPABASE_URL: "https://SEU_PROJETO.supabase.co",
     SUPABASE_ANON_KEY: "SUA_ANON_KEY",
   };
   ```

   *(Alternativa: `localStorage.setItem('nh_supabase_url', ...)` / `nh_supabase_anon_key` no console do navegador — tem prioridade sobre o arquivo.)*
4. Recarregue a página. Se a conexão falhar, o app volta sozinho ao Modo Demonstração.

## Ponte IoT (ESP32 → Supabase)

### Edge Function

```bash
supabase login
supabase link --project-ref SEU_PROJETO
supabase secrets set IOT_DEVICE_SECRET="um-segredo-forte"
supabase functions deploy iot-gateway
```

Teste:

```bash
curl -X POST "https://SEU_PROJETO.supabase.co/functions/v1/iot-gateway" \
  -H "Content-Type: application/json" \
  -H "x-device-key: um-segredo-forte" \
  -d '{"device_id":"a4444444-4444-4444-8444-444444444444","metric_type":"energy_watts","value":1234,"status":{"watts":1234}}'
```

### Firmware ESP32

1. Abra [`firmware/esp32_nexushome/esp32_nexushome.ino`](firmware/esp32_nexushome/esp32_nexushome.ino) na Arduino IDE (com o core ESP32 instalado).
2. Preencha `WIFI_SSID`, `WIFI_PASSWORD`, `GATEWAY_URL` e `DEVICE_SECRET`.
3. Com `SIMULATE_SENSORS true` funciona sem hardware; para sensores reais, mude para `false` e ligue SCT-013 (energia), YF-S201 (fluxo) e DHT22 (clima) nos pinos indicados.
4. Grave na placa (ESP32 DevKit, 115200 baud).

## Deploy na Vercel

```bash
npm i -g vercel
vercel        # o vercel.json já configura a SPA estática
```

> Lembre-se de criar `js/config.js` como variável de ambiente/arquivo de build, ou configurar as credenciais via `localStorage` no navegador de produção.

## Estrutura

```
nexushome-os/
├── index.html                  # SPA (CDN: Tailwind, Three r128, supabase-js v2)
├── css/styles.css              # glassmorphism, switches, sliders, toasts, modal
├── js/
│   ├── app.js                  # bootstrap, relógio, badge de conexão
│   ├── config.js               # (gitignored) credenciais locais
│   ├── config.example.js       # modelo versionado
│   ├── supabase-client.js      # fábrica: Supabase real OU mock demo
│   ├── state.js                # store + pub/sub
│   ├── scene3d.js              # casa 3D isométrica (Three.js)
│   ├── charts.js               # sparklines em canvas
│   ├── toasts.js               # notificações
│   └── panels/
│       ├── devices.js          # controles por cômodo
│       ├── monitor.js          # telemetria, alertas, emergência
│       └── automations.js      # regras IFTTT + avaliador
├── supabase/
│   ├── migrations/001_init.sql # esquema + RLS + realtime + seeds
│   └── functions/iot-gateway/  # Edge Function (Deno)
└── firmware/esp32_nexushome/   # firmware Arduino/ESP32
```

## Limites de segurança (projeto demonstrativo)

- As políticas RLS são **propositalmente permissivas** (`using (true)`) para demo pública sem login. Para produção, ative autenticação e restrinja por usuário.
- O segredo `IOT_DEVICE_SECRET` é uma proteção mínima para a Edge Function; considere mTLS ou assinatura HMAC por dispositivo em cenários reais.

## Licença

MIT — uso livre, sem fins lucrativos.

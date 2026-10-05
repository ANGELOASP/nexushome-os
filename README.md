# NexusHome OS

Sistema operacional de casa inteligente em tempo real — SPA com visualização 3D isométrica, telemetria de recursos (energia/água), automações IFTTT e ponte IoT para ESP32. **Projeto sem fins lucrativos.**

![stack](https://img.shields.io/badge/stack-HTML5%20%C2%B7%20Tailwind%20CDN%20%C2%B7%20Vanilla%20JS%20%C2%B7%20Three.js%20r128%20%C2%B7%20Supabase-6366f1)

## Visão geral

- **Casa 3D interativa** (Three.js): 4 cômodos clicáveis — Sala de Estar, Quarto Principal, Cozinha e Área Externa — que reagem visualmente ao estado dos dispositivos (brilho/cor da luz, tonalidade fria do AC, válvula, medidor).
- **Login obrigatório** (Supabase Auth e-mail/senha): todo o app fica bloqueado atrás de uma tela de login; no Modo Demonstração um banner âmbar avisa que qualquer credencial entra.
- **Telemetria em tempo real**: energia (W) e fluxo de água (L/h) com sparklines, badge de saúde (Seguro/Atenção/Crítico) e feed de alertas.
- **Segurança hídrica**: detecção de vazamento (fluxo > 0 por mais de 30 s com tudo desligado) e botão de emergência **FECHAR VÁLVULA DE ÁGUA GERAL**.
- **Automações IFTTT**: crie regras `SE métrica (operador) limiar ENTÃO ação no dispositivo`, com avaliador client-side (edge-trigger + cooldown).
- **Modo Demonstração**: sem backend? Sem problema — o app simula tudo no navegador (inclusive a autenticação).

## Início rápido (Modo Demonstração)

```bash
npm install
npm run dev
# abra http://localhost:5173
```

Sem nenhuma configuração, o app entra em **Modo Demonstração**: um cliente Supabase simulado no navegador alimenta os 4 dispositivos, telemetria a cada 3–5 s, alertas e todas as funcionalidades da UI. A tela de login aparece mesmo assim — com o banner âmbar `Modo Demonstração`, **qualquer e-mail/senha entra** (a sessão falsa fica em `sessionStorage`).

## Conectando ao Supabase (badge verde `● Supabase Live`)

1. Crie um projeto gratuito em [supabase.com](https://supabase.com).
2. **SQL Editor** → execute as migrações **em ordem**:
   1. [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) — cria as tabelas (`devices`, `automations`, `telemetry_logs`, `alerts`), realtime e seeds.
   2. [`supabase/migrations/002_auth_rls.sql`](supabase/migrations/002_auth_rls.sql) — **endurece o RLS**: revoga o acesso anônimo e restringe as 4 tabelas a usuários autenticados.
3. Copie [`js/config.example.js`](js/config.example.js) para `js/config.js` e preencha:

   ```js
   window.NEXUSHOME_CONFIG = {
     SUPABASE_URL: "https://SEU_PROJETO.supabase.co",
     SUPABASE_ANON_KEY: "SUA_ANON_KEY",
   };
   ```

   *(Alternativa: `localStorage.setItem('nh_supabase_url', ...)` / `nh_supabase_anon_key` no console do navegador — tem prioridade sobre o arquivo.)*
4. Recarregue a página. Se a conexão falhar, o app volta sozinho ao Modo Demonstração.
5. **Crie o primeiro usuário** na aba "Criar conta" da tela de login (veja a seção abaixo).

## Segurança e Login

O app exige autenticação por e-mail/senha via **Supabase Auth** (`signInWithPassword` / `signUp` / `signOut`), com sessão persistida (ao recarregar, entra direto) e botão **Sair** no chip do usuário na barra superior. Toda a interface — cena 3D e painéis — permanece oculta e inerte até o login, e a simulação de telemetria só inicia depois da autenticação.

- **Primeiro usuário**: use a aba **Criar conta** da tela de login. O provedor de e-mail já vem ativado no Supabase Auth. Para login imediato sem confirmação, desative **Confirm email** em *Authentication → Providers → Email* (opcional; se ativo, o app avisa para confirmar o e-mail).
- **Recuperação de senha**: o link **Esqueci minha senha** (aba Entrar) abre a view de recuperação, que chama `resetPasswordForEmail` com `redirectTo` dinâmico (origem atual — funciona em `localhost` e na Vercel sem alterar código). A confirmação é neutra de propósito ("Se o e-mail estiver cadastrado, você receberá um link…") para não permitir enumeração de usuários, e erros HTTP 429 de rate limit viram "Muitas tentativas. Aguarde alguns minutos e tente novamente.". Ao clicar no link do e-mail, o app detecta o evento `PASSWORD_RECOVERY` (ou o hash `#type=recovery`) e abre a view **Definir nova senha** em vez da central; após `updateUser({ password })`, o hash é limpo da URL e o usuário entra autenticado.
  - **Configuração obrigatória no dashboard Supabase**: em *Authentication → URL Configuration*, adicione às **Redirect URLs** tanto `http://localhost:7100/` (desenvolvimento) quanto a URL de produção (ex.: `https://<projeto>.vercel.app/`); a **Site URL** deve ser a URL de produção. O template de e-mail **Reset Password** pode ser personalizado em *Authentication → Email Templates*.
- **RLS endurecido**: a migração `002_auth_rls.sql` remove as políticas anônimas permissivas da `001` e cria políticas `for all to authenticated`. Sem login, a chave anon não lê nem escreve nada.
- **Modo Demonstração**: sem credenciais Supabase configuradas, o login é simulado — um **banner âmbar visível** avisa que qualquer e-mail/senha entra e que os dados são locais. A recuperação de senha também é simulada (nenhum e-mail é enviado; a view de recuperação exibe uma **nota âmbar** explicando isso). A segurança real vale assim que o Supabase é conectado.
- **service_role key**: a Edge Function `iot-gateway` usa `SUPABASE_SERVICE_ROLE_KEY`, que **ignora o RLS por design** (é o que mantém a ingestão do ESP32 funcionando). Essa chave **nunca** deve aparecer no frontend nem ser commitada. A autenticação dos dispositivos IoT é o header `x-device-key` (segredo `IOT_DEVICE_SECRET`).

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
│   ├── app.js                  # bootstrap + gate de autenticação
│   ├── auth.js                 # tela de login: entrar/criar conta + recuperação de senha (Supabase Auth / demo)
│   ├── config.js               # (gitignored) credenciais locais
│   ├── config.example.js       # modelo versionado
│   ├── supabase-client.js      # fábrica: Supabase real OU mock demo (inclui auth mock)
│   ├── state.js                # store + pub/sub
│   ├── scene3d.js              # casa 3D isométrica (Three.js)
│   ├── charts.js               # sparklines em canvas
│   ├── toasts.js               # notificações
│   └── panels/
│       ├── devices.js          # controles por cômodo
│       ├── monitor.js          # telemetria, alertas, emergência
│       └── automations.js      # regras IFTTT + avaliador
├── supabase/
│   ├── migrations/001_init.sql # esquema + RLS inicial + realtime + seeds
│   ├── migrations/002_auth_rls.sql # RLS apenas para usuários autenticados
│   └── functions/iot-gateway/  # Edge Function (Deno)
└── firmware/esp32_nexushome/   # firmware Arduino/ESP32
```

## Limites de segurança (projeto demonstrativo)

- O acesso aos dados exige login (RLS `authenticated-only` após a migração 002). Ainda assim, **qualquer usuário autenticado lê/escreve tudo** (single-tenant); isolamento por usuário (políticas com `auth.uid()`) é o próximo passo natural para multi-residência.
- O segredo `IOT_DEVICE_SECRET` é uma proteção mínima para a Edge Function; considere mTLS ou assinatura HMAC por dispositivo em cenários reais.
- A `service_role` key jamais deve ser exposta ao frontend — ela bypassa o RLS.

## Licença

MIT — uso livre, sem fins lucrativos.

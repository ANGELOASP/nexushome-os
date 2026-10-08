# NexusHome OS

Sistema operacional de casa inteligente em tempo real — SPA com visualização 3D isométrica, telemetria de recursos (energia/água), automações IFTTT e ponte IoT para ESP32. **Projeto sem fins lucrativos.**

![stack](https://img.shields.io/badge/stack-HTML5%20%C2%B7%20Tailwind%20CDN%20%C2%B7%20Vanilla%20JS%20%C2%B7%20Three.js%20r128%20%C2%B7%20Supabase-6366f1)

## Visão geral

- **Casa 3D interativa** (Three.js): cômodos clicáveis que reagem visualmente ao estado dos dispositivos (brilho/cor da luz, tonalidade fria do AC, válvula, medidor). A casa **não é fixa no código** — ela é construída a partir da planta salva no Supabase.
- **Editor de Planta 2.0** (novo na v1.6.0): botão **Planta** na barra superior abre um editor 2D top-down completo — **15 tipos de cômodo predefinidos** (sala, suíte, garagem, varanda…), **andares** (térreo + até 2 andares empilhados no 3D), **desfazer/refazer**, **zoom e pan**, **guias de alinhamento** magnéticas, painel de precisão com área em m² e atalhos de teclado. A planta sincroniza na hora com a cena 3D e o painel de dispositivos.
- **Login obrigatório** (Supabase Auth e-mail/senha): todo o app fica bloqueado atrás de uma tela de login; no Modo Demonstração um banner âmbar avisa que qualquer credencial entra.
- **Telemetria em tempo real**: energia (W) e fluxo de água (L/h) com sparklines, badge de saúde (Seguro/Atenção/Crítico) e feed de alertas.
- **Segurança hídrica**: detecção de vazamento (fluxo > 0 por mais de 30 s com tudo desligado) e botão de emergência **FECHAR VÁLVULA DE ÁGUA GERAL**.
- **Automações IFTTT**: crie regras `SE métrica (operador) limiar ENTÃO ação no dispositivo`, com avaliador client-side (edge-trigger + cooldown). Desde a v1.5.0, sensores e comandos **SmartThings** também servem de gatilho e de ação. **Desde a v1.10.0, as regras de métricas nativas (energia, água, temperatura, umidade) rodam no servidor** — funcionam com o navegador fechado (migração 007; edge-trigger + cooldown de 20 s; cada execução registra um alerta `automacao`). Regras SmartThings seguem no navegador, pois o token Samsung fica só no seu `localStorage`. No Modo Demonstração o avaliador continua no navegador.
- **Integração Samsung SmartThings** (novo na v1.4.0): controle **TVs** (power, volume, mudo, canal) e **ares-condicionados** (power, temperatura 16–30 °C, modo) reais direto do painel, com vínculo a cômodos da planta e reação visual na cena 3D. Veja a seção dedicada abaixo.
- **Integração Tuya Smart Life — hidráulica** (novo na v1.7.0): painel **Água — Smart Life (Tuya)** para **válvulas Wi-Fi** (setoriais e geral), **válvula-medidora ultrassônica** na entrada, **monitores de nível ME201W** e **sensores de vazamento**, via Tuya Cloud com proxy assinado (HMAC-SHA256) — a vazão real alimenta o dashboard, o nível vira métrica `water_level_pct` e vazamento vira **alerta crítico**. Veja a seção dedicada abaixo.
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
   3. [`supabase/migrations/003_rooms.sql`](supabase/migrations/003_rooms.sql) — **planta da residência**: tabela `rooms` (nome, posição, tamanho, cor), RLS autenticado, realtime e os 4 cômodos padrão como seeds. Sem ela, o app carrega a planta padrão embutida e o salvamento falha.
   4. [`supabase/migrations/004_rooms_floor_kind.sql`](supabase/migrations/004_rooms_floor_kind.sql) — **Editor de Planta 2.0**: colunas `floor` (andar: 0 = térreo) e `kind` (tipo do cômodo) + backfill dos 4 seeds. Idempotente. Sem ela, o salvamento da planta falha com "column does not exist".
   5. [`supabase/migrations/005_water_level_metric.sql`](supabase/migrations/005_water_level_metric.sql) — **integração Tuya**: aceita a métrica `water_level_pct` (nível da caixa d'água) em `telemetry_logs`. Idempotente. Sem ela, as leituras de nível dos monitores Tuya falham ao gravar.
   6. [`supabase/migrations/006_walls.sql`](supabase/migrations/006_walls.sql) — paredes vetoriais da planta (tabela `walls`).
   7. [`supabase/migrations/007_server_automations.sql`](supabase/migrations/007_server_automations.sql) — **automações no servidor** (v1.10.0): trigger em `telemetry_logs` que avalia as regras IFTTT de métricas nativas no Postgres. Idempotente. Sem ela, no modo live as regras nativas **deixam de rodar** (o navegador não as avalia mais).
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

O app exige autenticação por e-mail/senha via **Supabase Auth** (`signInWithPassword` / `signUp` / `signOut`), com a sessão guardada só na aba/janela (recarregar a página entra direto; **fechar o navegador encerra o login**) e botão **Sair** no chip do usuário na barra superior. Toda a interface — cena 3D e painéis — permanece oculta e inerte até o login, e a simulação de telemetria só inicia depois da autenticação.

- **Primeiro usuário**: use a aba **Criar conta** da tela de login. O provedor de e-mail já vem ativado no Supabase Auth. Para login imediato sem confirmação, desative **Confirm email** em *Authentication → Providers → Email* (opcional; se ativo, o app avisa para confirmar o e-mail).
- **Recuperação de senha**: o link **Esqueci minha senha** (aba Entrar) abre a view de recuperação, que chama `resetPasswordForEmail` com `redirectTo` dinâmico (origem atual — funciona em `localhost` e na Vercel sem alterar código). A confirmação é neutra de propósito ("Se o e-mail estiver cadastrado, você receberá um link…") para não permitir enumeração de usuários, e erros HTTP 429 de rate limit viram "Muitas tentativas. Aguarde alguns minutos e tente novamente.". Ao clicar no link do e-mail, o app detecta o evento `PASSWORD_RECOVERY` (ou o hash `#type=recovery`) e abre a view **Definir nova senha** em vez da central; após `updateUser({ password })`, o hash é limpo da URL e o usuário entra autenticado.
  - **Configuração obrigatória no dashboard Supabase**: em *Authentication → URL Configuration*, adicione às **Redirect URLs** tanto `http://localhost:7100/` (desenvolvimento) quanto a URL de produção (ex.: `https://<projeto>.vercel.app/`); a **Site URL** deve ser a URL de produção. O template de e-mail **Reset Password** pode ser personalizado em *Authentication → Email Templates*.
- **RLS endurecido**: a migração `002_auth_rls.sql` remove as políticas anônimas permissivas da `001` e cria políticas `for all to authenticated`. Sem login, a chave anon não lê nem escreve nada.
- **Modo Demonstração**: sem credenciais Supabase configuradas, o login é simulado — um **banner âmbar visível** avisa que qualquer e-mail/senha entra e que os dados são locais. A recuperação de senha também é simulada (nenhum e-mail é enviado; a view de recuperação exibe uma **nota âmbar** explicando isso). A segurança real vale assim que o Supabase é conectado.
- **service_role key**: a Edge Function `iot-gateway` usa `SUPABASE_SERVICE_ROLE_KEY`, que **ignora o RLS por design** (é o que mantém a ingestão do ESP32 funcionando). Essa chave **nunca** deve aparecer no frontend nem ser commitada. A autenticação dos dispositivos IoT é o header `x-device-key` (segredo `IOT_DEVICE_SECRET`).

## Editor de Planta 2.0

A casa 3D é gerada a partir da tabela `rooms` (migrações 003 + 004) — posições e tamanhos em **metros** (no 3D, 1 m = 1,9 unidade de cena; cada andar mede 3,0 unidades de altura). O botão **Planta** na barra superior abre o editor 2D:

- **Tipos de cômodo (presets)**: **Adicionar cômodo** abre uma paleta com 15 tipos — Sala de Estar, Sala de Jantar, Quarto, Suíte, Banheiro, Cozinha, Lavanderia, Escritório, Varanda, Garagem, Corredor, Área Externa, Closet, Despensa e Personalizado — cada um com **nome, cor, ícone e tamanho padrão** (editáveis depois). O tipo (`kind`) orienta o **mobiliário temático da cena 3D**: cama em quarto/suíte, sofá + TV na sala, mesa com cadeiras no jantar, carro na garagem, lavadora na lavanderia, painel solar na área externa etc.
- **Andares**: abas **Térreo / 1º Andar / + Novo andar** (máx. 3). Cada cômodo pertence a um andar (o formulário lateral move o cômodo de andar). A cena 3D **empilha os andares** sobre lajes e ganha um **filtro de andar** (topo da cena): **Todos** mostra a pilha com os andares superiores semitransparentes; um andar específico o isola (os demais somem, inclusive do clique).
- **Desfazer/Refazer**: Ctrl+Z / Ctrl+Shift+Z (ou os botões da barra) com histórico de 50 passos.
- **Zoom e pan**: roda do mouse dá zoom ancorado no cursor; arrastar o espaço vazio (ou o botão do meio) move a vista; **Ajustar** enquadra o andar atual.
- **Guias de alinhamento**: ao arrastar/redimensionar, bordas e centros dos outros cômodos do mesmo andar **atraem** com linhas ciano (raio de ~6 px). O snap na grade de 0,5 m continua disponível e pode ser desligado no checkbox **Snap**.
- **Painel de precisão**: com um cômodo selecionado, edite **X, Y, Largura e Profundidade** em passos de 0,1 m, com **área em m² ao vivo**; a barra do editor mostra a **área total por andar**.
- **Duplicar** (Ctrl+D ou botão) cria uma cópia deslocada; as **setas** movem o cômodo selecionado em 0,5 m (Shift = 0,1 m).
- **Sobreposição é bloqueada** dentro do mesmo andar: a posição/tamanho volta atrás com um flash vermelho (cômodos em andares diferentes podem se sobrepor livremente).
- Borda de 2 px mais escura que o preenchimento, para ler os limites como **paredes**.
- **Salvar planta** persiste no Supabase (ou no `localStorage` no Modo Demonstração) e **reconstrói a cena 3D e o painel de dispositivos na hora**, sem recarregar. Mudanças feitas em outra aba chegam via realtime.
- Renomear ou excluir um cômodo **não move os dispositivos** automaticamente — eles aparecem num grupo próprio no painel e um toast avisa quais ficaram com o cômodo antigo.
- Plantas salvas antes da v1.6.0 carregam normalmente: ganham `floor 0` e o tipo é **inferido pelo nome** (ex.: "Suíte Master" → suíte).
- **Restaurar padrão** volta aos 4 cômodos originais, todos no térreo.

### Atalhos do editor

| Atalho | Ação |
| --- | --- |
| `Ctrl+Z` / `Ctrl+Shift+Z` (ou `Ctrl+Y`) | Desfazer / Refazer |
| `Ctrl+D` | Duplicar cômodo selecionado |
| Setas | Mover 0,5 m (com `Shift`: 0,1 m) |
| `Delete` / `Backspace` | Excluir cômodo selecionado (com confirmação) |
| Roda do mouse | Zoom ancorado no cursor |
| Arrastar espaço vazio / botão do meio | Mover a vista (pan) |
| Duplo-clique | Abrir o formulário do cômodo |
| `Esc` | Fechar painéis / editor |

## Integração Samsung SmartThings

O painel **SmartThings** (canto inferior direito) controla aparelhos reais da sua conta Samsung — hoje **TVs** e **ares-condicionados** — sem sair do NexusHome.

### 1. Crie um token de acesso pessoal (PAT)

1. Acesse [account.smartthings.com/tokens](https://account.smartthings.com/tokens) e clique em **Generate new token**.
2. Dê um nome (ex.: `NexusHome`) e marque os escopos **Devices: Read** (list all devices / read status) e **Devices: Execute** (send commands).
3. Copie o token gerado e cole no painel SmartThings do app.

### 2. Modelo de segurança

- O token fica **somente no seu navegador** (`localStorage` chave `nh_smartthings_links` guarda apenas o vínculo aparelho↔cômodo; o token em si fica em `nh_smartthings_token`). Nada é salvo no banco.
- As chamadas à API passam pela Edge Function [`smartthings-proxy`](supabase/functions/smartthings-proxy/index.ts), que apenas repassa a requisição para `api.smartthings.com` com o token vindo do header `x-smartthings-token` — o proxy **não persiste, não loga e não devolve** o token (evita CORS e mantém a chave fora do código-fonte).
- Por segurança, o proxy só aceita métodos `GET`/`POST` e caminhos começando com `/devices`.
- **Exige login (v1.10.0)**: faça o deploy **sem** `--no-verify-jwt` (`supabase functions deploy smartthings-proxy`). A plataforma valida o JWT e a função rejeita a chave anon — só usuários autenticados usam o proxy. O mesmo vale para `tuya-proxy`. O frontend não muda: `functions.invoke` já envia o token da sessão.

### 3. Controles disponíveis

| Tipo | Controles |
| --- | --- |
| **TV** | Liga/Desliga, volume ±5, mudo, canal ± |
| **Ar-Condicionado** | Liga/Desliga, temperatura (slider 16–30 °C, `setCoolingSetpoint`), modo (cool/heat/auto/fan/dry) |

Cada aparelho pode ser **vinculado a um cômodo** da planta (o vínculo fica no `localStorage`). Aparelhos vinculados aparecem como **dispositivos virtuais** na cena 3D — a TV acende um brilho azul-claro no teto do cômodo e o AC ativa o brilho frio azul quando ligados.

### 4. Polling e limites

O status é atualizado a cada **30 s** (a API da SmartThings tem rate-limit agressivo; evite encurtar) e o polling é encerrado ao sair da sessão. O botão **Atualizar** força uma leitura imediata.

### 5. Automações com aparelhos Samsung (v1.5.0)

Com o painel conectado, o motor IFTTT passa a enxergar os aparelhos Samsung **dos dois lados da regra**:

- **Gatilho por sensor**: as leituras ambientais reportadas pelos próprios aparelhos (`temperatureMeasurement`, `relativeHumidityMeasurement`) viram gatilhos no modal de criação (optgroup *Aparelhos Samsung*). A regra usa **edge trigger** — dispara só na transição, o que funciona como histerese e evita repetição enquanto a condição valer.
- **Ação por comando**: o alvo da ação pode ser um aparelho Samsung (optgroup *Samsung SmartThings*), com construtor compacto de comandos — AC: ligar/desligar + modo + temperatura (16–30 °C); TV: ligar/desligar + mudo. Os comandos são enviados pela Edge Function `smartthings-proxy` com o token do navegador.
- **Cooldown de 5 minutos em ações de AC** para não estressar o compressor com liga/desliga em sequência; os demais alvos seguem o cooldown padrão de 20 s.
- Se o SmartThings estiver **desconectado** (sem token), as regras Samsung exibem o badge `⏸ SmartThings offline` e são puladas até a reconexão.
- O avaliador das regras **SmartThings** roda **no navegador, enquanto o app estiver aberto** — essas regras não disparam com a aba fechada (as de métricas nativas rodam no servidor desde a v1.10.0).

### 6. Modo Demonstração

Sem token, o app simula **2 aparelhos** (uma TV e um ar-condicionado) com badge âmbar `Demo`: todos os botões funcionam localmente e nenhuma chamada de rede é feita — ideal para testar a UX antes de conectar a conta real. As leituras de temperatura dos simulados **passeiam entre 22–31 °C** a cada 5 s, então regras de exemplo (ex.: `> 26 °C`) cruzam a borda e disparam de verdade; as ações Samsung no demo apenas atualizam o estado local e exibem o toast.

## Integração Tuya Smart Life (hidráulica)

O painel **Água — Smart Life (Tuya)** (canto inferior direito, ao lado do SmartThings — os dois dividem o mesmo slot: o Tuya começa recolhido e, ao expandir, ocupa o lugar) integra os dispositivos Tuya/Smart Life de **água** da casa — hoje voltados a **válvulas Wi-Fi** (setoriais e geral), **válvula-medidora ultrassônica** na entrada principal, **monitores de nível ultrassônicos ME201W** e **sensores de vazamento Wi-Fi**.

### 1. Crie o projeto Tuya IoT e vincule o Smart Life

1. Acesse [iot.tuya.com](https://iot.tuya.com), crie uma conta e vá em **Cloud → Development → Create Cloud Project** (a versão gratuita atende ao uso residencial).
2. No projeto, em **Devices → Link App Account**, vincule a conta do app **Smart Life** (escaneie o QR code com o app) — os dispositivos cadastrados no app aparecem no projeto.
3. Copie o **UID** da conta vinculada (coluna da lista de app accounts), o **Client ID** (Access ID) e o **Client Secret** (Access Secret) em *Overview/Authorization* do projeto.
4. No painel do NexusHome, cole as três credenciais e escolha a **região** — contas Smart Life do Brasil normalmente funcionam no cluster **Américas (us)** (padrão); use eu/cn/in se a sua conta foi criada nesses clusters. O botão **Conectar** valida tudo buscando o token e a lista de dispositivos.

### 2. Modelo de segurança

- As credenciais ficam **somente no seu navegador** (`localStorage` chave `nh_tuya_creds`; os vínculos em `nh_tuya_links`). Nada é salvo no banco.
- A Tuya Cloud exige **assinatura HMAC-SHA256** por requisição, o que não pode ser feito no navegador sem expor o Client Secret — por isso as chamadas passam pela Edge Function [`tuya-proxy`](supabase/functions/tuya-proxy/index.ts): ela recebe as credenciais no corpo de cada requisição, obtém/renova o `access_token` (vida ~2 h, cache em memória), assina (`client_id + [access_token] + t + stringToSign`) e repassa para `openapi.tuya<região>.com`. O proxy **não persiste, não loga e não devolve** segredos ou tokens (loga apenas método/caminho/status), e só aceita caminhos `/v1.0/users/...` e `/v1.0/devices/...` — não é um túnel genérico.

### 3. Descoberta dinâmica de datapoints

Dispositivos Tuya não têm "capabilities" padronizadas como os Samsung: cada produto expõe **datapoints por código** (`switch`, `flow_rate`, `liquid_level_percent`, `watersensor_state`…), que variam entre fabricantes. O painel **descobre os datapoints de cada dispositivo** via `/status` e os mapeia com um dicionário de melhor-esforço (válvula: `switch`/`switch_valve`; vazão: `flow_rate`/`water_flow`; consumo: `water_consumed`/`total_flow`; nível: `liquid_level_percent`/`liquid_depth`; vazamento: `watersensor_state`/`water_leak`). **Códigos desconhecidos nunca quebram o card** — aparecem numa seção expansível *Dados brutos*, útil para ajustar o dicionário ao seu modelo exato. Os cards são agrupados pelo tipo detectado: **Válvula/Medidor** (botão abrir/fechar + vazão + consumo + temperatura), **Nível** (barra de percentual + profundidade), **Vazamento** (badge Normal/ALERTA) e **Outros**.

> **Unidade de vazão**: as válvulas ultrassônicas Tuya costumam reportar em **L/min**; o painel converte ×60 para a métrica nativa `water_flow_lph`. Se o seu produto já reportar L/h, ajuste a constante `FLOW_TO_LPH` no topo de `js/panels/tuya.js`.

### 4. Vínculos e o que eles ativam

Cada dispositivo pode ser vinculado (select no card) a um **cômodo da planta** — entra como dispositivo virtual no estado global — ou à **Válvula de Água Geral (nativa)**:

- **Válvula-medidora → válvula nativa**: a cada poll (30 s), a vazão real é gravada em `telemetry_logs` como `water_flow_lph`, chegando ao **Monitor de Recursos pelo mesmo canal realtime de sempre** (postgres_changes no live, evento do mock no demo) — o sparkline de água e a detecção de vazamento por fluxo passam a usar dados reais, sem caminho paralelo. A gravação via cliente Supabase mantém demo e live idênticos.
- **Botão de emergência integrado**: o **FECHAR VÁLVULA DE ÁGUA GERAL** também envia o comando de fechar à válvula Tuya vinculada (e a reabertura restaura) — o painel espelha o estado da válvula nativa por edge-trigger no evento `device-changed`, sem loop.
- **Monitor de nível vinculado**: grava `water_level_pct` (métrica criada pela migração 005) ancorado no `device_id` da válvula geral — o contexto hídrico da casa (a FK de `telemetry_logs` exige um device existente).
- **Sensor de vazamento em alarme**: insere um **alerta crítico** pelo pipeline existente (`insertAlert`) — aparece no feed do Monitor de Recursos, derruba o badge de saúde para Crítico e emite toast; ao normalizar, registra um alerta informativo.

### 5. Modo Demonstração

Sem credenciais, o app simula **3 dispositivos** (válvula-medidora, monitor de nível ME201W e sensor de vazamento) com badge âmbar `Demo`: a vazão oscila em rajadas, o nível passeia entre 60–95 % e há um **evento raro de vazamento** (~2 % por ciclo, dura ~10 s) para exercitar o alerta crítico — tudo local, nenhuma chamada de rede. Vincular a válvula-medidora demo à válvula nativa alimenta o dashboard da mesma forma que no live.

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
2. Preencha `WIFI_SSID`, `WIFI_PASSWORD` e `DEVICE_SECRET` (a `GATEWAY_URL` já vem configurada para este projeto).
3. Com `SIMULATE_SENSORS true` funciona sem hardware; para sensores reais, mude para `false` e ligue SCT-013 (energia) e YF-S201 (fluxo) nos pinos indicados.
4. **DHT22/AM2302 (opcional, clima real)**: ligue VCC→3.3V, DATA→GPIO4 (pull-up de 10kΩ para 3.3V — muitos módulos já incluem) e GND→GND; instale **"DHT sensor library" (Adafruit)** + **"Adafruit Unified Sensor"** pela Library Manager e deixe `HAS_DHT22 true` no topo do sketch. Com `HAS_DHT22 false`, temperatura/umidade seguem simuladas e nenhum código DHT é compilado. Leituras falhas são logadas no Serial e a métrica é pulada naquele ciclo; o clima é publicado no dispositivo **Ar-Condicionado** e também faz merge em `devices.status` (`ambient_temperature`/`ambient_humidity`).
5. Grave na placa (ESP32 DevKit, 115200 baud).

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
│   ├── scene3d.js              # casa 3D isométrica (Three.js), construída da planta
│   ├── floorplan.js            # Editor de Planta 2D (canvas): desenha/edita a planta
│   ├── charts.js               # sparklines em canvas
│   ├── toasts.js               # notificações
│   └── panels/
│       ├── devices.js          # controles por cômodo
│       ├── monitor.js          # telemetria, alertas, emergência
│       ├── automations.js      # regras IFTTT + avaliador
│       ├── smartthings.js      # integração Samsung SmartThings (TV + AC)
│       └── tuya.js             # integração Tuya Smart Life (válvulas, nível, vazamento)
├── supabase/
│   ├── migrations/001_init.sql # esquema + RLS inicial + realtime + seeds
│   ├── migrations/002_auth_rls.sql # RLS apenas para usuários autenticados
│   ├── migrations/003_rooms.sql  # planta da residência (tabela rooms + seeds)
│   ├── migrations/004_rooms_floor_kind.sql # andares + tipos de cômodo (v1.6.0)
│   ├── migrations/005_water_level_metric.sql # métrica water_level_pct (v1.7.0)
│   ├── migrations/006_walls.sql # paredes da planta
│   ├── migrations/007_server_automations.sql # automações no servidor (v1.10.0)
│   └── functions/
│       ├── iot-gateway/        # Edge Function (Deno) — ingestão IoT
│       ├── smartthings-proxy/  # Edge Function (Deno) — proxy seguro p/ SmartThings
│       ├── tuya-proxy/         # Edge Function (Deno) — proxy assinado p/ Tuya Cloud
│       └── notify-alert/       # Edge Function (Deno) — alertas → Telegram (v1.11.0)
└── firmware/esp32_nexushome/   # firmware Arduino/ESP32
```

## Limites de segurança (projeto demonstrativo)

- O acesso aos dados exige login (RLS `authenticated-only` após a migração 002). Ainda assim, **qualquer usuário autenticado lê/escreve tudo** (single-tenant); isolamento por usuário (políticas com `auth.uid()`) é o próximo passo natural para multi-residência.
- O segredo `IOT_DEVICE_SECRET` é uma proteção mínima para a Edge Function; considere mTLS ou assinatura HMAC por dispositivo em cenários reais.
- A `service_role` key jamais deve ser exposta ao frontend — ela bypassa o RLS.

## Notificações no Telegram (v1.11.0)

Alertas **críticos** (vazamento detectado pelo sensor Tuya, consumo crítico, válvula geral fechada…) chegam no seu Telegram pela Edge Function [`notify-alert`](supabase/functions/notify-alert/index.ts), chamada por um **Database Webhook** a cada `INSERT` em `alerts` — o envio acontece no servidor, não depende de a aba estar aberta.

1. No Telegram, fale com **@BotFather** → `/newbot` → copie o **token**.
2. Mande uma mensagem qualquer ao seu bot e abra `https://api.telegram.org/bot<TOKEN>/getUpdates` → copie o `chat.id`.
3. Configure os segredos e faça o deploy:

   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN="..." TELEGRAM_CHAT_ID="..." NOTIFY_WEBHOOK_SECRET="um-segredo-forte"
   # opcional: NOTIFY_MIN_SEVERITY=warning   (padrão: critical; info nunca incomoda por padrão)
   supabase functions deploy notify-alert --no-verify-jwt
   ```

4. No dashboard: **Database → Webhooks → Create a new hook** — tabela `alerts`, evento **Insert**, tipo **Supabase Edge Functions** → `notify-alert`, e adicione o header HTTP `x-webhook-secret` com o **mesmo** segredo.

Fail-closed: sem os três segredos a função responde 503; sem o header correto, 401. O token do bot nunca é logado.

> **Limite conhecido**: a *geração* de alguns alertas ainda acontece no navegador (consumo elevado, vazamento por fluxo contínuo e o polling do sensor Tuya). A notificação em si é no servidor, mas esses alertas só existem enquanto o app estiver aberto em algum dispositivo. As regras de automação (migração 007) já rodam 100% no servidor.

## Testes

```bash
npm test                      # lógica das regras (js/rules.js) — node:test, sem dependências
DATABASE_URL=postgres://... tests/sql/run.sh   # trigger de automações (migração 007)
```

O teste SQL aplica as migrações 001, 005 e 007 e exercita o trigger (limiar, edge-trigger, cooldown, regra inativa, regra inválida, regras SmartThings). **Use um banco de teste VAZIO** — nunca o de produção: o script cria tabelas e insere dados.

## Licença

MIT — uso livre, sem fins lucrativos.

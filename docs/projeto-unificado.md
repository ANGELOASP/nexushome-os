# Projeto de Automação Unificado — NexusHome OS (v2.16)

> **Para quem é este documento:** para o eletricista ou montador que vai fabricar o **Quadro de Automação
> Unificado (QAU)** e a sala técnica, e para quem vai gravar os firmwares. Ele junta e corrige os cinco
> documentos anteriores e o que já existe neste repositório:
> - Memorial Descritivo de Automação;
> - Memorial Técnico Completo;
> - Nobreak e Inversor;
> - Segurança, Sensores e IHM;
> - código ESPHome.
>
> **Status:** projeto executivo de automação. Tudo marcado com **(verificar)** é dado de fabricante que precisa
> ser conferido no datasheet do produto comprado antes da montagem. **Não substitui** o projeto elétrico de
> potência (quadro de cargas, unifilar, ART), que continua obrigatório pela NBR 5410 e deve ser feito por um
> profissional habilitado (NR-10).

Desenhos (pasta [`docs/img/unificado/`](img/unificado/)):

| # | Desenho | Arquivo |
|---|---|---|
| 1 | Arquitetura geral (quem fala com quem) | `01-arquitetura.svg` |
| 2 | Planta da sala técnica (QDG, QDC, QAU, rack, banco + inversor) | `02-sala-tecnica.svg` |
| 3 | Tampa do QAU com as quatro telas de 4,3" | `03-qau-tampa.svg` |
| 4 | Interior do QAU: posicionamento dos módulos | `04-qau-interior.svg` |
| 5 | Alimentação 220 V / 24 V (unifilar do QAU) | `05-alimentacao.svg` |
| 6 | Barramentos RS-485 A, B, C e D (endereços e terminação) | `06-barramentos-rs485.svg` |
| 7 | Ligação da luz em three-way com relé e retorno | `07-three-way.svg` |
| 8 | Gás: intertravamento por fio (válvula NF e sirene) | `08-gas-intertravamento.svg` |
| 9 | Réguas de bornes X0–X9 (borne a borne, cor do fio) | `09-reguas-bornes.svg` |
| 10 | Banco de baterias, inversor e QDC | `10-nobreak.svg` |
| 11 | Rede: rack, telas, servidor e IPs | `11-rede.svg` |

---

## 1. Decisões principais (resumo de uma página)

1. **Uma sala técnica com quatro conjuntos:**
   - **QDG**: quadro de distribuição com os disjuntores da casa, os PZEM-016 e os contatores.
   - **QDC**: quadro de cargas críticas, alimentado pelo inversor.
   - **QAU**: Quadro de Automação Unificado, com controladoras, fontes, módulos de relé e de entradas, réguas de bornes e as telas na tampa.
   - **Rack 19"** de rede, mais o **banco de baterias LiFePO4 com o inversor híbrido**.
2. **Quatro barramentos RS-485 separados**, cada um com **um único mestre** (a regra do Modbus RTU).
   - **A: Energia.** Mestre: tela 4,3" "Energia".
   - **B: Segurança e Iluminação.** Mestre: tela 4,3" "Segurança".
   - **C: Água.** Mestre: tela 4,3" "Água".
   - **D: Nobreak.** Mestre: tela 4,3" "Nobreak".

   Cada barramento tem seus próprios aparelhos. Os endereços são **únicos na casa toda** (tabela no §5.2), então dá para juntar barramentos no futuro sem conflito.
3. **Quatro telas ESP32-S3-Touch-LCD-4.3B na tampa do QAU.** Cada tela é a controladora do seu barramento:
   - lê os aparelhos;
   - aplica a proteção local, que funciona **sem internet**;
   - publica no NexusHome OS pelo `iot-gateway`.
4. **ESP32-P4 de 10,1" no corredor** e **uma tela de 7" por cômodo**.
   - São **clientes** do NexusHome: leem e comandam pela internet (`/iot-gateway/panel`). **Nunca** entram no RS-485.
   - Mesmo firmware para todas: `firmware/nexus_painel`.
5. **Monitor do servidor:** mostra o NexusHome OS em tela cheia (quiosque). Use o script `scripts/quiosque-nexushome.ps1`.
6. **Interruptores de parede continuam funcionando.**
   - Cada ponto de luz é um **three-way**: o interruptor de parede é um lado e o **contato reversível do relé** é o outro.
   - Se a automação morrer, o interruptor continua acendendo e apagando.
   - Um **relé de retorno** (bobina 230 V) informa se a lâmpada está acesa de verdade.
7. **Segurança de vida por fio, não por software.**
   - O transmissor de gás corta a válvula de gás NF e liga a sirene **pelos próprios contatos**.
   - A automação só supervisiona.
   - **Com gás, nada é ligado na área** (exaustor ou luz são fonte de ignição).
8. **Fail-safe:** cargas de potência ficam no contato **NF** do relé (relé desligado = carga ligada). Se a automação falhar, a casa continua com energia.
9. **Energia da automação:**
   - **24 V** em todo o QAU.
   - Fonte principal Mean Well **SDR-120-24**.
   - Fonte de segurança Mean Well **DRC-100B**, com 2 baterias VRLA 12 V 7 Ah. Ela mantém a segurança viva mesmo com o inversor desligado para manutenção.
   - O QAU é alimentado pelo **QDC**, ou seja, pela saída do inversor.
10. **Banco de baterias corrigido:** o inversor ANENJI de 4 kW em 24 V puxa cerca de 170 A, e um pack de 100 A não aguenta. Agora são **dois packs LiFePO4 24 V 100 Ah em paralelo** (200 Ah, 5,12 kWh), cada um com seu fusível, ou um único pack com BMS de 200 A.

---

## 2. Inconsistências encontradas e como ficaram

| # | Onde | Problema | Como ficou neste projeto |
|---|---|---|---|
| 1 | Nobreak / Memorial completo | Inversor ANJ-4000W-24V puxa ~170 A (4000 W ÷ 25,6 V ÷ 0,92), mas o BMS corta em 100 A: só ~2,3 kW úteis | 2 × LiFePO4 24 V 100 Ah em paralelo (BMS 2 × 100 A = 200 A), ou 1 pack com BMS ≥ 200 A. Limitar a carga do inversor a ≤ 0,5 C (§4) |
| 2 | Nobreak | "4,2 kW nominal" contra o modelo "4000W" | Usar o valor contínuo da placa do aparelho **(verificar)**. Dimensionado para 4000 W |
| 3 | Todos | "0 ms" vale para a fonte DC, não para a saída CA do inversor (~10 ms em modo UPS) | Rack e servidor no QDC com o inversor em modo **UPS (APL)**. A automação usa a DRC-100B (0 ms, bateria própria) |
| 4 | Nobreak | Bateria da DRC-100A não especificada; a DRC é para chumbo-ácido, não LiFePO4 | DRC-**100B** (27,6 V) + 2 × VRLA 12 V 7 Ah em série (§4.3) |
| 5 | Memorial 1 | "12 V da fonte nos bornes do PZEM": errado, o PZEM-016 se alimenta da tensão que mede | O PZEM-016 recebe só a tensão do circuito (F-N, ou F-F em carga 220 V bifásica). A 24 V vai só para a eletrônica |
| 6 | Memorial 1 × 2 | Duas fontes diferentes (Cloweit 12 V 150 W × Mean Well 12 V) | Padrão único em **24 V** Mean Well (relés Waveshare e telas aceitam 7–36 V) |
| 7 | Todos | Vários mestres no mesmo RS-485 (ESP32-S3, P4, gateway, Home Assistant) | Um mestre por barramento (a tela 4,3"). P4, 7" e servidor leem pelo NexusHome. O gateway Waveshare fica só para diagnóstico (§5.4) |
| 8 | Todos × repo | Endereços conflitantes (PZEM 1–8, relés 10–12, WS230 20–28 colidindo com a hidráulica 1–4 e a energia 5–40) | Tabela única (§5.2). Hidráulica e energia mantêm os endereços já gravados no firmware |
| 9 | Memorial 1 / Segurança | Mais de 32 nós num segmento (37 só na energia; ~65 com tudo) | 4 barramentos. A energia passa por **hub RS-485 isolado** com três ramos |
| 10 | Memorial completo / Segurança | Gás lido "a cada 2 s" e corte "< 500 ms" num RS-485 de 9600 baud com dezenas de nós: impossível | Corte por fio (contato AL2 do transmissor em série com a válvula NF). O software só supervisiona (§10) |
| 11 | Memorial completo / Nobreak / Segurança | Ligar exaustor e luz de emergência no vazamento de gás: fonte de ignição | Com gás, **nenhuma carga da área é comutada**. Só fecha a válvula e toca a sirene (fora da zona) |
| 12 | Segurança | CH4 × GLP: gases e alturas de instalação diferentes | Comprar o transmissor calibrado para o gás **realmente usado**. GLP fica a 30 cm do piso; gás natural (CH4), a 30 cm do teto |
| 13 | Memorial completo × Segurança | Limiares de gás diferentes (15 % × 20 % LEL) | AL1 = 10 % LEL (pré-alarme); AL2 = 20 % LEL (corte, retido, rearme manual) |
| 14 | Segurança | WS230/WS231 sem fabricante; detector de fumaça óptico na cozinha dá falso alarme | **Detector de fumaça autônomo com saída a relé** nos quartos e salas, **termovelocimétrico** na cozinha, ambos na entrada digital. Temperatura e umidade pelo **XY-MD02** (Modbus, registradores conhecidos) |
| 15 | Segurança | Regra "umidade > 75 % liga exaustor" sem sensor nos banheiros | XY-MD02 em cada banheiro (endereços 85 e 86) |
| 16 | Memorial completo | Interruptor de parede na entrada digital (toggle) e lâmpada no NA: se a automação cair, a luz não acende | Three-way com o contato reversível do relé. A parede funciona sempre (§9) |
| 17 | Memorial 1 | "Contator auxiliar 25–50 A" para chuveiro de 7800 W (35,5 A) | Contator de **potência** 40 A AC-1, 2 polos; bobina 230 V CA com supressor RC |
| 18 | repo (tabela provisória) | Tomada de 20 A com disjuntor de 25 A | Tomada 20 A com disjuntor de **20 A** e cabo ≥ 2,5 mm² (corrigir no quadro de cargas real) |
| 19 | repo | Circuitos 25 e 32 (iluminação) com relé direto, contra a decisão "iluminação em three-way" | O liga/desliga das luzes passa para o barramento B (three-way). Na energia, esses circuitos viram "só medição" (firmware atualizado) |
| 20 | YAML ESPHome | GPIO17/18 são dados do LCD na 4.3B; GPIO19 é o USB D−; `flow_control_pin` não é usado (a direção é automática) | RS-485 nativo da 4.3B em **GPIO43/44**, sem pino DE (firmwares do repo) |
| 21 | YAML ESPHome | Senhas em texto plano, chave de API inválida, `ota:` em formato antigo, sem `modbus_controller` (não compila), placa errada | ESPHome descartado. Firmware Arduino do repo; segredos só no `.ino` local (o instalador preserva) e no Supabase |
| 22 | Nobreak / YAML | PZEM-017 em 8N2 × PZEM-016 em 8N1 no mesmo UART **(verificar)** | Barramento D em **8N2** (o PZEM-016 aceita ouvir 2 stop bits). Se falhar, tela Nobreak com `NOBREAK_STOPBITS 1` e PZEM-017 em porta própria |
| 23 | Nobreak | SoC pela tensão do LiFePO4 (curva plana) e shunt de 100 A saturando | Shunt **300 A / 75 mV** no negativo. SoC estimado por contagem de Ah com recalibração em 100 %/10 %. Quando houver BMS com RS-485, o SoC passa a vir dele |
| 24 | Segurança | "ESP32-P4 com Wi-Fi/Ethernet/RS485": o P4 não tem rádio; o Wi-Fi vem do ESP32-C6 | P4 de 10,1" = Waveshare **ESP32-P4-NANO + 10.1-DSI-TOUCH-A** (Ethernet com PoE + Wi-Fi 6 pelo C6). Cliente de rede, sem RS-485 |
| 25 | repo | Hidráulica: seed sem dono (com a 018 fica invisível) e alarmes sem push | Seed corrigido; o firmware passa a mandar os alarmes para a tabela `alerts` (push e Telegram) |
| 26 | repo | Card "Água" mostra só a última leitura (pula entre os ramais) | Painel soma a vazão por ramal (app e `/panel`) |
| 27 | Todos | Home Assistant como "servidor" | O servidor é o **NexusHome OS** (Supabase). O HA, se existir, lê o NexusHome; nunca é mestre de barramento |
| 28 | Todos | Nenhuma norma, bitola, proteção ou cor citada | §6, §7 e §8 deste documento |

---

## 3. Arquitetura geral

```
                    INTERNET ── ONU/roteador ── switch PoE (rack) ── servidor NexusHome + monitor (quiosque)
                                                   │  │  │
            Wi-Fi/Ethernet ────────────────────────┘  │  └── P4 10,1" do corredor (PoE)
                                                       └──── telas 7" dos cômodos (Wi-Fi, fonte local)
                           NexusHome OS na nuvem (Supabase: banco, realtime, iot-gateway, push)
                                    ▲  HTTPS (x-device-key)
   ┌────────────────── QAU (tampa: 4 telas ESP32-S3 4,3") ──────────────────┐
   │  T1 Água ── RS-485 C ── contadoras, sonda, relés 8CH (válvulas)          │
   │  T2 Energia ─ RS-485 A ─ hub isolado ─ relés 32/16/32CH + 33 PZEM-016    │
   │  T3 Segurança ─ RS-485 B ─ hub ─ Relay(D) luzes, IO 8CH, XY-MD02, gás     │
   │  T4 Nobreak ─ RS-485 D ─ PZEM-017 (banco) + PZEM-016 (rede, saída)       │
   └─────────────────────────────────────────────────────────────────────────┘
```

**Quem decide o quê:**
- **Proteção** (sobrecarga, demanda, rompimento de cano, gás, alarme): a tela 4,3" do barramento, localmente, sem depender da internet.
- **Comandos do usuário** (app, P4, 7"): o NexusHome grava em `devices.status`. O gatilho `queue_device_command` cria o comando, e a tela do barramento busca a cada 5 s (`/iot-gateway/commands`).
- **Exibição:** todas as telas e o app leem o mesmo banco. O P4 e as 7" usam `/iot-gateway/panel`, um resumo compacto feito para o ESP32.

---

## 4. Energia: banco de baterias, inversor e alimentação da automação

### 4.1 Banco e inversor (corrigido)

| Item | Especificação |
|---|---|
| Inversor híbrido | ANENJI ANJ-4000W-24V-WiFi, 4000 W contínuos, saída 220 V senoidal, entrada DC 24 V **(verificar placa e manual)** |
| Banco | **2 × LiFePO4 24 V (25,6 V) 100 Ah, BMS 100 A cada**, em paralelo = 200 Ah, 5,12 kWh. Alternativa: 1 pack 24 V 200 Ah com BMS ≥ 200 A |
| Corrente máxima DC | 4000 W ÷ (24 V × 0,92) ≈ **181 A** (bateria baixa) |
| Cabo pack → barramento DC | 35 mm² flexível (classe 5), vermelho (+) e preto (−), **mesmo comprimento** nos dois packs (≤ 1 m) |
| Cabo barramento → inversor | **50 mm²** flexível, ≤ 1,5 m. O manual pode pedir 2 × 35 mm²: vale o maior **(verificar)** |
| Proteção por pack | Fusível **classe T 150 A** (ou MEGA 150 A) no positivo, a menos de 20 cm do borne |
| Seccionamento | Chave seccionadora DC 250 A (ou disjuntor DC 250 A) entre o barramento e o inversor |
| Medição | Shunt 300 A / 75 mV no **negativo**, entre o barramento negativo e o inversor (PZEM-017, endereço 41) |
| Parametrização | Bateria "LiFePO4"/"USER": tensão de carga 28,4 V, flutuação 27,6 V, corte 24,0 V, retorno 25,6 V; corrente de carga máx. 50 A (0,25 C do banco de 200 Ah) **(verificar no manual)** |
| Modo de saída | **UPS** (transferência ~10 ms) para o rack não reiniciar; prioridade SBU (solar, bateria, rede) ou SUB, conforme houver painéis FV |
| Ambiente | Ventilado, 10–35 °C, longe do QAU (≥ 0,5 m), sem material combustível. Extintor CO₂ 6 kg na porta da sala |
| Energia útil e autonomia | 5,12 kWh × 0,9 (profundidade) × 0,92 (inversor) ≈ **4,2 kWh**. Exemplo: com iluminação 250 W + rack 80 W + automação 60 W + autoconsumo 40 W (≈ 430 W), a autonomia é de ≈ **9,8 h** |

### 4.2 Quadros de potência

- **QDG** (distribuição da casa): recebe a concessionária. Tem os disjuntores dos circuitos, DR 30 mA (banheiros, cozinha, lavanderia, área externa, tomadas), **DPS classe II** (275 V, 20 kA) e os **PZEM-016 + contatores** dos circuitos com relé (§5.3). O QDG fornece também a entrada CA do inversor.
- **QDC** (cargas críticas): recebe a **saída do inversor**, passando por uma **chave reversora 1-0-2** (1 = inversor, 2 = rede direta, para tirar o inversor em manutenção sem apagar a casa). Circuitos do QDC:
  - iluminação da casa (todos os circuitos de luz);
  - rack de rede;
  - QAU;
  - geladeira (opcional).
  - Tem também DPS classe II e o PZEM-016 de saída (endereço 43).
- **Aterramento:** siga o manual do inversor para a ligação N-PE na saída (geralmente o inversor não faz o vínculo; o QDC usa o PE da casa, esquema TN-S). Confirme que o DR do QDC não desarma ao comutar **(verificar)**.

### 4.3 Alimentação do QAU

| Ref. | Equipamento | Saída | Alimenta | Proteção na saída |
|---|---|---|---|---|
| Q1 | Disjuntor 1P+N 10 A curva C (no QDC, circuito "Automação") | 220 V | QAU | — |
| Q2 | Disjuntor 2P 6 A curva C (entrada do QAU) | 220 V | F1, F2, tomada de serviço | — |
| DPS1 | DPS classe II 275 V 20 kA, F-N + N-PE | — | entrada do QAU | fusível/disjuntor de retaguarda conforme o fabricante |
| F1 | **Mean Well SDR-120-24** (24 V, 5 A, DIN) | +24 V "geral" | telas Água, Energia e Nobreak; relés de energia e hidráulica; hubs; gateway | bornes-fusível FU1–FU10 |
| F2 | **Mean Well DRC-100B** (27,6 V, 100 W, carregador) + 2 × VRLA 12 V 7 Ah em série | +24 V "segurança" | tela Segurança, módulos do barramento B, transmissores de gás, detectores, sirenes, válvula de gás | bornes-fusível FU11–FU18 |
| BAT | 2 × bateria VRLA 12 V 7 Ah (série = 24 V) | — | reserva da F2 (≈ 3 h com 38 W) | fusível 5 A no positivo da bateria (FU-BAT) |
| TS | Tomada DIN 2P+T 10 A | 220 V | notebook de manutenção | — |

**Orçamento de 24 V (pior caso)**

| Grupo | F1 (W) | F2 (W) |
|---|---|---|
| Telas ESP32-S3 4,3" (≈ 3 W cada) | 9 (3 telas) | 3 |
| Relés de energia 32 + 16 + 32 canais (todos energizados) | 33 | — |
| Relé 8CH da hidráulica + válvulas em movimento | 3 + 12 | — |
| Hubs RS-485 isolados (2) e gateway | 5 | — |
| Relay (D) 8CH × 2 (luzes e saídas) | — | 8 |
| IO 8CH × 2 (entradas) | — | 2 |
| XY-MD02 × 8 | — | 2 |
| Transmissores de gás × 2 | — | 6 |
| Detectores de fumaça × 6 + sensores de presença × 8 | — | 9 |
| Válvula de gás NF energizada | — | 10 |
| Sirenes × 2 (em alarme) | — | 20 |
| **Total** | **≈ 62 W** (52 % de 120 W) | **≈ 60 W** em alarme, 40 W normal (60 % de 100 W) |

---

## 5. Barramentos RS-485

### 5.1 Regras para todos os barramentos

- **Um mestre por barramento** (a tela 4,3"). Nenhum outro aparelho pergunta nada ao barramento.
- **Cabo:** F/UTP Cat.6 blindado, 4 pares 23–24 AWG, ou Belden 3106A/9842 (120 Ω). Uso dos pares:
  - **par azul:** A (+) no azul, B (−) no branco-azul;
  - **par laranja:** GND de referência (laranja + branco-laranja juntos);
  - **par marrom:** +24 V (marrom) / 0 V (branco-marrom), só para sensores de baixo consumo (XY-MD02);
  - **par verde:** reserva.
- **Terminação 120 Ω nas DUAS pontas** de cada ramo: jumper "120R" na tela (início) e resistor de 120 Ω ¼ W entre A e B no último aparelho (ou jumper do aparelho). Mais que duas terminações num ramo = erro.
- **Polarização:** a tela 4.3B já polariza o barramento **(verificar)**. Se a varredura falhar com o barramento parado, use resistores de 680 Ω de A ao +5 V e de B ao GND, só no mestre.
- **Blindagem:** dreno ligado ao **PE em um único ponto** (no borne SH do QAU). Na ponta de campo, a blindagem fica isolada com fita.
- **Topologia:** daisy-chain (entra e sai de cada aparelho). Derivação máxima de 30 cm. Onde a casa obriga a uma "estrela", use o **hub isolado**: cada porta é um ramo novo, com terminação própria.
- **Separação:** o cabo de dados nunca corre no mesmo eletroduto que o 220 V sem isolação para a maior tensão (NBR 5410). No QAU, use canaletas diferentes.
- **Velocidade:** 9600 baud em todos (o PZEM-016 só fala 9600). Barramento D em **8N2**; os demais em **8N1**.
- **Endereçamento:** todo aparelho sai de fábrica com o endereço 1. Grave o endereço **ligando um aparelho por vez** (script `scripts/enderecar-modbus.ps1` ou comandos `pzemaddr` / `reladdr` na serial).

### 5.2 Tabela única de endereços

| Barramento | Endereço | Aparelho | Local | Função |
|---|---|---|---|---|
| **C Água** (T1, 8N1) | 1 | Contadora de pulsos FT-PFC-04 nº 1 | QAU | ramais 1–4 |
| C | 2 | Contadora FT-PFC-04 nº 2 | QAU | ramais 5–7 |
| C | 3 | Sonda hidrostática QDY30A | reservatório | nível |
| C | 4 | Waveshare Modbus RTU Relay **8CH** | QAU | 8 válvulas motorizadas |
| **A Energia** (T2, 8N1) | 5 | Waveshare Relay **32CH** | QAU | contatores do grupo Íntimo |
| A | 6 | Waveshare Relay **16CH** | QAU | contatores do grupo Social |
| A | 7–16 | PZEM-016 × 10 | QDG fileira 1 | circuitos 1–10 |
| A | 17–21 | PZEM-016 × 5 | QDG fileira 2 | circuitos 11–15 |
| A | 22 | Waveshare Relay **32CH** | QAU | contatores do grupo Serviços |
| A | 23–40 | PZEM-016 × 18 | QDG fileira 3 | circuitos 16–33 |
| **D Nobreak** (T4, **8N2**) | 41 | PZEM-017 + shunt 300 A | sala técnica | banco 24 V |
| D | 42 | PZEM-016 (TC 100 A) | QDG | entrada da rede para o inversor |
| D | 43 | PZEM-016 (TC 100 A) | QDC | saída do inversor (consumo crítico) |
| D | 44–49 | reservado | — | BMS / inversor (RS-485), futuro |
| **B Segurança** (T3, 8N1) | 50 | Transmissor de gás (Modbus) | Cozinha | % LEL, saídas AL1/AL2 |
| B | 51 | Transmissor de gás (Modbus) | Lavanderia | % LEL, saídas AL1/AL2 |
| B | 80–87 | XY-MD02 (temperatura/umidade) × 8 | cômodos (§10.4) | T e UR |
| B | 90 | Waveshare Modbus RTU **Relay (D)** 8CH + 8DI | QAU | luzes 1–8 (three-way) + retornos |
| B | 91 | Waveshare Modbus RTU **Relay (D)** 8CH + 8DI | QAU | luzes 9–10, exaustores, sirenes, corte de gás + entradas |
| B | 92 | Waveshare Modbus RTU **IO 8CH** | QAU | presença × 8 |
| B | 93 | Waveshare Modbus RTU **IO 8CH** | QAU | fumaça/térmico × 6 + portas × 2 |
| — | 200 (IP) | Waveshare RS485 TO WIFI/ETH | QAU | **só diagnóstico** (§5.4) |

Nós por barramento: A = 36 + mestre (dividido em 3 ramos pelo hub); B = 14 + mestre; C = 4 + mestre; D = 3 + mestre.

### 5.3 Topologia física de cada barramento

- **A (Energia):**
  - T2 → borne X5-A → **hub RS-485 isolado 4 portas** (HUB-A).
  - P1: relés 5, 6 e 22 dentro do QAU.
  - P2: QDG fileiras 1 e 2 (PZEM 7–21).
  - P3: QDG fileira 3 (PZEM 23–40).
  - P4: reserva.
  - Terminação: na tela e em cada porta do hub (jumper). O trecho tela → entrada do hub também é um barramento: se o hub tiver jumper na entrada, ligue-o; trechos internos curtos (< 2 m) funcionam sem. Depois, e no **último PZEM de cada ramo**: PZEM 21 no P2 (as fileiras 1 e 2 ficam em série, o PZEM 16 **não** leva resistor) e PZEM 40 no P3.
- **B (Segurança):** T3 → X5-B → **HUB-B**.
  - P1: módulos 90–93 no QAU.
  - P2: ala íntima: XY-MD02 82, 83, 84, 85, 86.
  - P3: ala social e cozinha: 80, 81 e o transmissor de gás 50.
  - P4: serviço: 87 e o gás 51.
- **C (Água):** T1 → X5-C:
  - contadoras 1 e 2 e relé 4 no QAU;
  - sai para a sonda 3 no reservatório (cabo F/UTP; DPS de sinal RS-485 se passar pela área externa).
- **D (Nobreak):** T4 → X5-D → PZEM-043 (QDC) → PZEM-042 (QDG) → PZEM-017 (junto ao banco). Trecho curto, dentro da sala.

### 5.4 Gateway Waveshare RS485 TO WIFI/ETH

Fica no QAU, desligado do barramento no dia a dia. Para diagnosticar pelo PC, o procedimento é este:
1. Desligue a tela do barramento. Ela é o mestre e não pode haver dois.
2. Ligue o gateway nos bornes do barramento.
3. Rode `scripts/testar-modbus.ps1 -Ip 192.168.1.200 -Slave 7`.

Se você **quiser** o gateway como mestre permanente da energia, para a tela poder ficar longe do quadro, use o modo `BUS_VIA_GATEWAY 1` do firmware de energia (§8A de `docs/automacao-eletrica.md`). Nesse caso a proteção depende da rede local.

---

## 6. Quadro de Automação Unificado (QAU)

### 6.1 Caixa

| Item | Especificação |
|---|---|
| Caixa | Quadro de comando em aço carbono, pintura epóxi, **IP54**, **1200 × 800 × 300 mm** (A × L × P), porta única com fecho de lingueta e chave, **placa de montagem** galvanizada (≈ 1140 × 740 mm). São ~250 bornes: precisam de **dois trilhos de réguas** (R5 e R6) |
| Recortes na porta | 4 janelas para as telas 4,3": recorte de **108 × 70 mm** cada, com moldura/escudo impresso em 3D ou de acrílico **(verificar no desenho mecânico da placa comprada)** |
| Ventilação | 2 grelhas com filtro 120 × 120 mm **nas laterais** (entrada embaixo na lateral esquerda, saída em cima na lateral direita: a porta fica livre para as telas). Ventilador 24 V 120 mm opcional, com termostato DIN a 35 °C |
| Entrada de cabos | Base com flange removível e prensa-cabos PG/M (M25 para Cat.6, M32 para multivias, M40 para chicotes de 220 V) |
| Montagem | Base do quadro a 0,50 m do piso, **centro das telas a 1,50 m** do piso, espaço livre de 1,0 m à frente (NR-10) |
| Aterramento | Barra de PE de cobre 12 furos; cordoalha de 6 mm² entre porta e caixa |
| Identificação | Plaqueta "QAU — Automação — 220 V / 24 V", diagrama dentro do bolso da porta |

### 6.2 Posicionamento dentro do QAU (placa de montagem, de cima para baixo)

Coordenada **y** = distância do topo da placa de montagem até o eixo do trilho DIN.

| Fileira | y (mm) | Trilho / canaleta | Conteúdo, da esquerda para a direita |
|---|---|---|---|
| C1 | 40 | Canaleta 60 × 60 (cinza) | entrada de cabos de cima, 220 V à esquerda e dados à direita |
| **R1 — Alimentação** | 120 | Trilho TS35 | Q2 (2P 6 A) · DPS1 · tomada DIN TS · **F1 SDR-120-24** · **F2 DRC-100B** · bornes-fusível FU1–FU18 · borne FU-BAT |
| C2 | 210 | Canaleta 40 × 60 | 24 V e comando |
| **R2 — Comunicação e barramento B** | 290 | Trilho TS35 | HUB-A · HUB-B · gateway (opcional) · **Relay (D) 90** · **Relay (D) 91** · **IO 8CH 92** · **IO 8CH 93** |
| C3 | 380 | Canaleta 40 × 60 | dados RS-485 (exclusiva) |
| **R3 — Relés de energia e água** | 470 | Trilho TS35 | **Relay 32CH (5)** · **Relay 16CH (6)** · **Relay 32CH (22)** · **Relay 8CH (4)** · contadoras FT-PFC-04 (1, 2) |
| C4 | 560 | Canaleta 60 × 80 | comando 220 V das bobinas e paralelos das luzes (**exclusiva 220 V**) |
| **R4 — Interface 220 V** | 640 | Trilho TS35 com barreira | 10 × relé de retorno Finder 38.51 230 V CA (KR1–KR10) · 2 × relé de interface dos exaustores Finder 38.51 24 V CC (KE1, KE2) |
| C5 | 720 | Canaleta 60 × 80 com divisória | fios de R4/R5 para cima: **220 V à esquerda** (X0, X3, X4, KR, KE) e **24 V à direita** (X1/X2) — a divisória continua a barreira |
| **R5 — Réguas de bornes (força e 24 V)** | 800 | Trilho TS35 | **X0** (entrada CA) · **X3** (comando dos contatores) · **X4** (luzes) · barreira · **X1/X2** (24 V) |
| C6 | 870 | Canaleta 60 × 80 (só SELV) | fios de campo de X5–X9 (RS-485, entradas, válvulas, sirenes) e chicotes da porta; nada de 220 V |
| **R6 — Réguas de bornes (campo)** | 950 | Trilho TS35 | **X5** (RS-485) · **X6** (entradas de campo) · **X7** (água) · **X8** (saídas de segurança) · **X9** (nobreak). São 148 bornes: **push-in 1,5 mm² com no máximo 4,2 mm de largura** (148 × 4,2 ≈ 622 mm + tampas e batentes ≈ 650 mm, cabe nos ≈ 720 mm úteis). A **barra PE** sai do trilho e vai parafusada na placa, logo abaixo do R6 (y ≈ 1000), à direita |
| Fundo | 1020–1130 | Prateleira/suporte | 2 × VRLA 12 V 7 Ah (esquerda) · reserva |

**Zonas.** A metade esquerda das fileiras R4–R5 (X0, X3, X4, KR, KE) é a **zona 220 V**, separada da zona SELV (24 V e dados) por uma **barreira isolante** e por canaletas próprias (C4). Nenhum fio de 24 V passa na canaleta do 220 V.

**Ligações da porta (telas):** um **chicote flexível** por tela (malha no SH). O RS-485 da 4.3B é isolado, então o GND de referência do barramento é um condutor próprio: o chicote leva **6 vias** (PP blindado 6 × 0,5 mm²: +24 V marrom, 0 V azul, A preto, B branco, **GND do RS-485 cinza**, reserva verde). Os chicotes passam por um **laço de dobradiça** de 300 mm do lado das dobradiças e terminam no borne X5 do barramento da tela e em X1/X2 (alimentação).

### 6.3 Tampa (porta) com quatro telas

Quatro telas lado a lado na altura dos olhos, da esquerda para a direita: **T1 Água · T2 Energia · T3 Segurança · T4 Nobreak**.
- Eixo das telas a 1,50 m do piso.
- Espaçamento de 180 mm entre centros.
- Plaquetas acima de cada tela.
- Embaixo, sinaleiros 22 mm (verde "24 V OK", vermelho "Alarme") e botoeira de emergência "CORTE DE GÁS" (cogumelo, NF), em série com a válvula (§10).

---

## 7. Padrão de cores, bitolas e identificação

### 7.1 Cores dos condutores

| Circuito | Cor | Bitola | Observação |
|---|---|---|---|
| Fase L1 (220 V) | **preto** | conforme o circuito | NBR 5410 não fixa a cor da fase, mas proíbe azul-claro e verde-amarelo |
| Fase L2 (220 V F-F) | **branco** | conforme o circuito | |
| Neutro | **azul-claro** | = fase | obrigatório (NBR 5410) |
| Proteção (PE) | **verde-amarelo** | = fase até 16 mm² | obrigatório (NBR 5410) |
| Retorno da lâmpada | **cinza** | 1,5 mm² | |
| Paralelos do three-way (P1/P2) | **laranja** | 1,5 mm² | anilhas P1/P2 |
| Comando 230 V CA (bobina do contator) | **vermelho** | 1,0 mm² | NBR IEC 60204-1: comando CA vermelho |
| +24 V CC | **marrom** | 1,0 mm² (tronco 1,5 mm²) | código de cores M12/IEC 60947-5-2 |
| 0 V CC | **azul-escuro** | 1,0 mm² (tronco 1,5 mm²) | não confundir com o neutro (azul-claro): anilha "0V" sempre |
| Sinal de entrada digital (24 V) | **preto** fino (0,5 mm²) | 0,5 mm² | só dentro do QAU; anilha com o tag do sensor |
| RS-485 A / B / GND | Cat.6: azul / branco-azul / laranja | 23–24 AWG | dentro do QAU, mantenha o par trançado até o borne |
| Bateria DC (+ / −) | **vermelho / preto** | 35–50 mm² | só na sala técnica, isolação 1 kV |

### 7.2 Terminais e identificação

- **Todo fio flexível leva terminal tubular (ilhós) isolado DIN 46228-4**, crimpado com alicate de catraca quadrado.
  - Cores do ilhós por bitola: 0,5 mm² branco · 0,75 cinza · 1,0 vermelho · 1,5 preto · 2,5 azul · 4 cinza · 6 amarelo.
  - Dois fios num borne: ilhós **duplo**.
- **Anilhas** nas duas pontas de cada fio, no formato `régua.borne`. Exemplo: o fio que sai de X4.32 leva "X4.32" na ponta do QAU e "L03-P2" na ponta da caixa de parede (X4.n1…n4: o ponto L03 usa X4.31–X4.34).
- Cabos de bateria: **terminal de compressão de cobre estanhado** (olhal M8) e termo-retrátil vermelho/preto.
- Bornes: **push-in (mola)**, com tampa final e pontes. R5 (força e 24 V): 2,5 mm² e 4 mm² (entradas CA). R6 (campo): **1,5 mm², largura ≤ 4,2 mm** (os sinais de campo chegam em 0,5–1,5 mm²). Bornes-fusível 5 × 20 com LED. Bornes de terra verde-amarelo.

---

## 8. Réguas de bornes (borne a borne)

> O desenho [`09-reguas-bornes.svg`](img/unificado/09-reguas-bornes.svg) mostra as mesmas réguas. Lado "QAU" = o que liga por dentro do quadro; lado "campo" = o cabo que sai.

### X0 — entrada CA (zona 220 V)

| Borne | Dentro | Campo (vem do QDC) | Cor |
|---|---|---|---|
| X0.1 | Q2 entrada L | fase do circuito "Automação" (QDC, Q1 10 A) | preto 2,5 mm² |
| X0.2 | Q2 entrada N | neutro | azul-claro 2,5 mm² |
| X0.PE | barra PE | PE | verde-amarelo 2,5 mm² |

Depois de Q2: L/N para DPS1, F1 (L, N), F2 (L, N) e TS, em fio de 1,5 mm².

### X1 — +24 V geral (F1) e X2 — +24 V segurança (F2)

| Borne | Fusível | Destino | Corrente máx. |
|---|---|---|---|
| X1.1 / X1.2 | FU1 1 A | T1 Água (+24 / 0 V) | 0,3 A |
| X1.3 / X1.4 | FU2 1 A | T2 Energia | 0,3 A |
| X1.5 / X1.6 | FU3 1 A | T4 Nobreak | 0,3 A |
| X1.7 / X1.8 | FU4 2 A | Relay 32CH (5) | 0,6 A |
| X1.9 / X1.10 | FU5 2 A | Relay 16CH (6) | 0,3 A |
| X1.11 / X1.12 | FU6 2 A | Relay 32CH (22) | 0,6 A |
| X1.13 / X1.14 | FU7 1 A | Relay 8CH (4) + contadoras 1 e 2 | 0,3 A |
| X1.15 / X1.16 | FU8 2 A | alimentação das válvulas (via contatos do relé 4) | 1,0 A |
| X1.17 / X1.18 | FU9 1 A | HUB-A + gateway | 0,3 A |
| X1.19 / X1.20 | FU10 1 A | sonda QDY30A (+24 V pelo cabo) | 0,1 A |
| X2.1 / X2.2 | FU11 1 A | T3 Segurança | 0,3 A |
| X2.3 / X2.4 | FU12 2 A | Relay (D) 90 e 91 + IO 92 e 93 + HUB-B | 0,6 A |
| X2.5 / X2.6 | FU13 1 A | transmissor de gás 50 (Cozinha) | 0,2 A |
| X2.7 / X2.8 | FU14 1 A | transmissor de gás 51 (Lavanderia) | 0,2 A |
| X2.9 / X2.10 | FU15 2 A | detectores de fumaça + sensores de presença (comum) | 0,6 A |
| X2.11 / X2.12 | FU16 1 A | XY-MD02 (alimentação pelo par marrom do Cat.6) | 0,1 A |
| X2.13 / X2.14 | FU17 2 A | válvula de gás NF (via cadeia de corte, §10) | 0,5 A |
| X2.15 / X2.16 | FU18 2 A | sirenes (via AL2 e Relay 91) | 0,8 A |

Bornes ímpares = +24 V (fio **marrom**); bornes pares = 0 V (fio **azul-escuro**).

### X3 — comando dos contatores (230 V CA, zona 220 V)

Um borne por circuito com relé. A fase de comando vem do QDG (disjuntor de comando 1P 2 A, fio vermelho 1,0 mm²), passa pelo **contato NF** do canal do relé e volta para a bobina A1 do contator no QDG. O A2 de todas as bobinas vai ao neutro no QDG.

| Borne | Relé (endereço / canal) | Circuito (tabela do firmware de energia) |
|---|---|---|
| X3.0 | — | fase de comando do QDG (comum: entra nos COM de todos os canais usados) |
| X3.1 | 5 / 1 | 1 Chuveiro — Banheiro 1 (contator 40 A) |
| X3.2 | 5 / 2 | 2 Chuveiro — Banheiro 2 (contator 40 A) |
| X3.3 | 5 / 3 | 3 Ar-condicionado — Quarto Principal |
| X3.4 | 5 / 4 | 4 Ar-condicionado — Quarto 2 |
| X3.5 | 5 / 5 | 5 Ar-condicionado — Quarto 3 |
| X3.6 | 5 / 6 | 6 Tomadas — Quarto Principal |
| X3.7 | 5 / 7 | 7 Tomadas — Quartos 2 e 3 |
| X3.8 | 5 / 8 | 8 Tomadas — Banheiros |
| X3.11 | 6 / 1 | 11 Tomadas — Sala de Estar |
| X3.12 | 6 / 2 | 12 Tomadas — Sala de TV |
| X3.13 | 6 / 3 | 13 Tomadas — Copa |
| X3.16 | 22 / 1 | 16 Tomadas 20 A — Cozinha |
| X3.17 | 22 / 2 | 17 Tomadas — Cozinha (bancada) |
| X3.19 | 22 / 3 | 19 Lava-louças |
| X3.21 | 22 / 4 | 21 Máquina de lavar |
| X3.22 | 22 / 5 | 22 Tomadas — Lavanderia |
| X3.24 | 22 / 6 | 24 Tomadas — Área Externa |
| X3.27 | 22 / 8 | 27 Bomba / pressurizador |
| X3.28 | 22 / 9 | 28 Tomadas 20 A — Oficina (bancada 1) |
| X3.29 | 22 / 10 | 29 Tomadas 20 A — Oficina (bancada 2) |
| X3.30 | 22 / 11 | 30 Compressor — Oficina |
| X3.31 | 22 / 12 | 31 Tomadas — Oficina |

> **Todos os circuitos com relé passam por contator de potência** (o contato do relé só comanda a bobina). Cada bobina leva **supressor RC** (snubber 230 V) em paralelo, no QDG. Os circuitos 25 e 32 (iluminação) **saíram** do barramento A: agora são three-way no barramento B. A tabela de circuitos ainda é provisória até o quadro de cargas real.

### X4 — iluminação three-way (230 V, zona 220 V)

Para cada ponto de luz **Ln** (n = 1…10), há quatro bornes:

| Borne | Liga dentro do QAU | Sai para | Cor |
|---|---|---|---|
| X4.n1 (P1) | NA do canal do Relay (D) | paralelo 1 até o interruptor three-way da parede | laranja, anilha "Ln-P1" |
| X4.n2 (P2) | NF do canal do Relay (D) | paralelo 2 até o interruptor three-way da parede | laranja, anilha "Ln-P2" |
| X4.n3 (R) | COM do canal + bobina A1 do relé de retorno KRn | retorno até a lâmpada | cinza |
| X4.n4 (N) | bobina A2 do KRn | neutro do circuito de iluminação (QDG) | azul-claro |

| Ponto | Cômodo | Relé (endereço / canal) | Retorno KRn → entrada digital |
|---|---|---|---|
| L01 | Sala de Estar | 90 / 1 | KR1 → 90 / DI1 |
| L02 | Sala de TV | 90 / 2 | KR2 → 90 / DI2 |
| L03 | Cozinha | 90 / 3 | KR3 → 90 / DI3 |
| L04 | Quarto Principal | 90 / 4 | KR4 → 90 / DI4 |
| L05 | Quarto 2 | 90 / 5 | KR5 → 90 / DI5 |
| L06 | Quarto 3 | 90 / 6 | KR6 → 90 / DI6 |
| L07 | Banheiro 1 | 90 / 7 | KR7 → 90 / DI7 |
| L08 | Banheiro 2 | 90 / 8 | KR8 → 90 / DI8 |
| L09 | Lavanderia | 91 / 1 | KR9 → 91 / DI1 |
| L10 | Área Externa | 91 / 2 | KR10 → 91 / DI2 |

O contato **NA** de cada KRn fecha o **+24 V segurança** (X2) na entrada DIn do módulo (fio preto 0,5 mm²). O comum das entradas do módulo vai ao 0 V **(verificar no manual do Relay (D) se a entrada é "fonte" ou "dreno")**. Se a leitura sair invertida, o firmware de segurança corrige com `DI_INVERT_90…93`, sem mexer na fiação.

### X5 — RS-485

Cada barramento tem um grupo de bornes **A · B · GND · SH**.

| Grupo | Lado da tela (porta) | Lado do campo |
|---|---|---|
| X5-A1…A4 | T2 Energia → HUB-A entrada | — |
| X5-A5…A8 | HUB-A porta 2 | QDG fileiras 1 e 2 (PZEM 7–21) |
| X5-A9…A12 | HUB-A porta 3 | QDG fileira 3 (PZEM 23–40) |
| X5-B1…B4 | T3 Segurança → HUB-B entrada | — |
| X5-B5…B8 | HUB-B porta 2 | ala íntima (82, 83, 84, 85, 86) |
| X5-B9…B12 | HUB-B porta 3 | social e cozinha (80, 81, gás 50) |
| X5-B13…B16 | HUB-B porta 4 | serviço (87, gás 51) |
| X5-C1…C4 | T1 Água | contadoras, relé 4, sonda 3 |
| X5-D1…D4 | T4 Nobreak | PZEM 43 → 42 → 41 |

- O **SH** de todos os grupos vai para a barra PE (é o único ponto de aterramento da blindagem).
- **A = azul**, **B = branco-azul**, **GND = laranja + branco-laranja**.

### X6 — entradas de campo (24 V segurança)

Cada sensor tem três bornes:
- **+24** (marrom), que alimenta o sensor;
- **0 V** (azul-escuro);
- **S**, o sinal: contato NA/NF do sensor fechando o +24 V, que vai à entrada do módulo.

| Bornes | Sensor | Entrada (endereço / DI) | Contato |
|---|---|---|---|
| X6.1–3 | Presença — Sala de Estar | 92 / DI1 | NA (fecha com presença) |
| X6.4–6 | Presença — Sala de TV | 92 / DI2 | NA |
| X6.7–9 | Presença — Cozinha | 92 / DI3 | NA |
| X6.10–12 | Presença — Quarto Principal | 92 / DI4 | NA |
| X6.13–15 | Presença — Quarto 2 | 92 / DI5 | NA |
| X6.16–18 | Presença — Quarto 3 | 92 / DI6 | NA |
| X6.19–21 | Presença — Lavanderia | 92 / DI7 | NA |
| X6.22–24 | Presença — Área Externa | 92 / DI8 | NA |
| X6.25–27 | Fumaça — Sala de Estar | 93 / DI1 | NA (fecha em alarme) |
| X6.28–30 | Fumaça — Sala de TV | 93 / DI2 | NA |
| X6.31–33 | Térmico — Cozinha | 93 / DI3 | NA |
| X6.34–36 | Fumaça — Quarto Principal | 93 / DI4 | NA |
| X6.37–39 | Fumaça — Quarto 2 | 93 / DI5 | NA |
| X6.40–42 | Fumaça — Quarto 3 | 93 / DI6 | NA |
| X6.43–44 | Porta de entrada (magnético) | 93 / DI7 | NF (abre com a porta) |
| X6.45–46 | Porta da cozinha/serviço (magnético) | 93 / DI8 | NF |
| X6.47–48 | Botão de pânico (cozinha/corredor) | 91 / DI7 | NA |

**Mapa completo do módulo 91** (Relay (D): saídas CH e entradas DI):

| Canal | Saída (relé) | Entrada (DI) |
|---|---|---|
| 1 | L09 Lavanderia (three-way) | retorno KR9 (L09 acesa) |
| 2 | L10 Área Externa (three-way) | retorno KR10 (L10 acesa) |
| 3 | exaustor Banheiro 1 (via relé de interface 24 V) | **válvula de gás energizada** (o +24 V da bobina, depois da cadeia de corte, chega aqui: 1 = aberta) |
| 4 | exaustor Banheiro 2 (via relé de interface 24 V) | **DRC-100B "AC fail"** (contato de alarme da F2: 1 = sem 220 V, segurança na bateria) |
| 5 | sirene interna (NA) | **DRC-100B "bateria baixa"** |
| 6 | sirene externa com strobe (NA) | reserva |
| 7 | **corte de gás** (o NF fica na cadeia da válvula: relé ligado = gás cortado) | botão de pânico (NA) |
| 8 | reserva | reserva |

Os transmissores de gás são lidos pelo Modbus (% LEL e estado AL1/AL2). O corte em si é feito pelos contatos AL2 na cadeia da válvula (§10.1).

Cabo de cada cômodo até o QAU: **Cat.6 U/UTP em home-run**.
- par marrom: +24 / 0 V;
- par azul: presença (azul = S);
- par laranja: fumaça (laranja = S);
- par verde: porta ou reserva.

### X7 — água (24 V)

| Bornes | Ligação |
|---|---|
| X7.1–X7.24 | 8 válvulas × 3 fios, **válvula n no canal n do relé 4** (1–6 ramais, 7 geral, 8 externa, a mesma ordem do firmware). **Vermelho = ABRE** (vai ao **NF** do canal do relé 4), **azul = FECHA** (vai ao **NA**), **preto = 0 V**. COM de cada canal = +24 V (X1.15, via FU8). Relé desligado = válvula aberta |
| X7.25–X7.45 | 7 medidores de vazão BT01/K24: +24 (marrom), 0 V (azul), pulso (preto) → DI1–DI4 da contadora 1 e DI1–DI3 da contadora 2 **(verificar a tensão do sensor; se for 5 V, use DC-DC)** |

### X8 — saídas de segurança (24 V segurança)

| Borne | Ligação |
|---|---|
| X8.1 | +24 V (FU17) → botoeira **CORTE DE GÁS** (NF) na porta do QAU |
| X8.2 | → AL2 do transmissor 50 (NF, abre a 20 % LEL) |
| X8.3 | → AL2 do transmissor 51 (NF) |
| X8.4 | → NF do Relay 91 / CH7 (corte por software) |
| X8.5 | → bobina da **válvula de gás NF** (+); o (−) vai a X2.14 (0 V) |
| X8.6 | +24 V (FU18) → COM do Relay 91 / CH5; o NA vai à sirene interna (+) |
| X8.7 | +24 V (FU18) → COM do Relay 91 / CH6; o NA vai à sirene externa (+) |
| X8.8 | AL2 dos transmissores em paralelo (NA) → sirene interna (+). A sirene toca mesmo com a automação desligada |
| X8.11 | +24 V (FU18) → comum dos contatos AL2 NA em paralelo (alimenta o X8.8) |
| X2.16 | 0 V das duas sirenes (−) |
| X8.9 / X8.10 | Relay 91 / CH3 e CH4: comando dos exaustores dos banheiros. O contato NA comanda um **relé de interface 24 V** na zona 220 V, que liga a fase do exaustor |

### X9 — nobreak

| Borne | Ligação |
|---|---|
| X9.1 / X9.2 | shunt 300 A / 75 mV: S+ e S− para o PZEM-017 (par trançado 0,5 mm², ≤ 1 m) |
| X9.3 / X9.4 | tensão do banco (+ / −) para o PZEM-017, por **fusível 1 A** no + junto ao barramento DC |
| X9.5–X9.8 | TC 100 A dos PZEM-016 42 (entrada da rede) e 43 (saída do inversor); tensão F-N pelos bornes dos próprios PZEM (fusível 1 A) |

---

## 9. Iluminação: three-way com relé e retorno

```
 Interruptor three-way (parede)            QAU (Relay D, canal n)              Lâmpada
   C ─── fase do circuito de luz (QDG)
   P1 ═══════ laranja ════════════════════ NA ┐
   P2 ═══════ laranja ════════════════════ NF ┤
                                             COM ──── cinza (retorno) ──────── (X) ── azul-claro (N, QDG)
                                              │
                                              └── KRn bobina 230 V (A1) ─ A2 ─ N    → contato KRn: +24 V → DIn
```

- **Com a automação desligada**, o canal do relé fica parado (NF). O interruptor da parede alterna entre P1 e P2 e acende e apaga a lâmpada normalmente.
- **Comando pelo app ou pelas telas:** o firmware de segurança lê o retorno (DIn = lâmpada acesa). Se o estado pedido for diferente, ele **inverte** o canal (three-way). Por isso o app mostra o estado **real**, mesmo quando alguém usou o interruptor.
- Com mais de um interruptor de parede no mesmo ponto, coloque um **intermediário (four-way)** entre os paralelos.
- O retorno cinza sai do QAU: a lâmpada recebe a fase **através** do relé ou do interruptor. Os fios P1, P2 e R do mesmo ponto vão juntos no mesmo eletroduto (NBR 5410: condutores do mesmo circuito juntos).
- **Contato do Relay (D):** 10 A 250 V CA **(verificar)**. Para pontos com mais de 1000 W de LED, use um contator de iluminação comandado pelo relé.

---

## 10. Segurança

### 10.1 Gás: intertravamento por fio

- **Transmissores:** 2 × transmissor de gás com display, **saída RS-485 Modbus RTU** e **dois relés de alarme (AL1/AL2)**, alimentação 24 V, calibrados para o gás **real** da casa:
  - GLP (botijão): sensor a 30 cm do piso;
  - gás natural (CH4): sensor a 30 cm do teto.
- **Válvula:** **solenoide de gás NF com rearme manual**, 24 V CC, certificada para gás (NBR 15526 / NBR 13103). Ela **fecha quando falta energia** e só reabre na mão.
- **Cadeia de corte, em série no +24 V da bobina:** botoeira de emergência na porta do QAU (NF) → AL2 Cozinha (NF) → AL2 Lavanderia (NF) → Relay 91 CH7 (NF) → bobina. **Qualquer elo aberto fecha a válvula.**
- **Sirene:** os contatos AL2 (NA) em paralelo ligam a sirene direto, e o firmware também liga pelo Relay 91 CH5/CH6.
- **Firmware de segurança (supervisão):**
  - AL1 ou leitura ≥ 10 % LEL: alerta *warning* em todas as telas e no celular.
  - AL2 ou leitura ≥ 20 % LEL: alerta *critical* (push), abre o CH7, liga as sirenes e **trava** até o rearme na tela.
  - **Não liga exaustor nem luz.**

### 10.2 Fumaça e calor

- **Detectores autônomos** com bateria e sirene próprias e saída a relé (NA), alimentação 12–24 V **(verificar)**:
  - fumaça óptica nas salas e quartos;
  - **termovelocimétrico** na cozinha.
- Disparo: o firmware gera alerta *critical*, liga as sirenes e mantém a iluminação. Nada é cortado (a rota de fuga precisa de luz).

### 10.3 Alarme de intrusão

- Dispositivo "Alarme da casa" com três modos (`armed`):
  - `off`: desarmado;
  - `home`: só as portas;
  - `away`: portas e presença.
- Disparo: depois de **30 s** de atraso na porta de entrada (para desarmar), liga as sirenes por **3 min** e gera alerta *critical*.
- Arma e desarma pelo app, pelo P4, pela tela de 7" ou pela T3.
- **Botão de pânico:** alerta *critical* imediato e sirenes, mesmo com o alarme desarmado.

### 10.4 Clima e exaustores

| Endereço | XY-MD02 | Cômodo |
|---|---|---|
| 80 | Sala de Estar | |
| 81 | Sala de TV | |
| 82 | Quarto Principal | |
| 83 | Quarto 2 | |
| 84 | Quarto 3 | |
| 85 | Banheiro 1 | liga o exaustor 1 (91 / CH3) com UR > 75 %, desliga com < 60 % (mín. 5 min, máx. 60 min) |
| 86 | Banheiro 2 | liga o exaustor 2 (91 / CH4) |
| 87 | Lavanderia | |

**XY-MD02 (Modbus):**
- função 04;
- registrador 0x0001 = temperatura × 0,1 °C;
- registrador 0x0002 = umidade × 0,1 %;
- endereço no holding 0x0101;
- 9600 8N1 de fábrica.

**(verificar)** no manual do lote comprado.

---

## 11. Hidráulica

Não muda: as regras de segurança (rompimento, vazamento externo, pânico) e a tela continuam as do `docs/automacao-hidraulica.md`.

Correções deste projeto:
- O relé de 8 canais e as contadoras ficam no QAU. As válvulas e os medidores chegam pelas réguas X7.
- Os alarmes de rompimento, vazamento externo e pânico **viram alertas** (push e Telegram).
- O seed da hidráulica atribui o dono (migração 018).

---

## 12. Nobreak (tela T4, barramento D)

| Grandeza | Origem | Uso |
|---|---|---|
| Tensão, corrente e potência do banco | PZEM-017 (41) | % de carga, autonomia estimada |
| Tensão da rede e potência de entrada | PZEM-016 (42) | **falta de energia** (rede < 180 V por 5 s): alerta *critical* "casa no inversor" |
| Potência de saída do inversor | PZEM-016 (43) | consumo das cargas críticas |
| SoC (%) | contagem de Ah: descarrega quando a rede falta, recarrega quando ela volta. Recalibra em 100 % (≥ 27,6 V e < 5 A por 10 min) e em 10 % (≤ 24,0 V) | tela, P4 e app |
| Autonomia (h) | energia restante ÷ potência média dos últimos 10 min | tela, P4 |

- **Bateria a 20 %:** alerta *warning*.
- **Bateria a 10 %:** alerta *critical* e, se configurado, desliga cargas não essenciais do QDC (futuro).

---

## 13. Telas

| Tela | Modelo | Onde | Função | Alimentação | Firmware |
|---|---|---|---|---|---|
| T1–T4 | Waveshare **ESP32-S3-Touch-LCD-4.3B** (800 × 480, RS-485 isolado, 7–36 V) | tampa do QAU | mestre de cada barramento, proteção local | 24 V do QAU | `esp32s3_hidraulica`, `esp32s3_eletrica`, `esp32s3_seguranca`, `esp32s3_nobreak` |
| Corredor | Waveshare **ESP32-P4-NANO** + **10.1-DSI-TOUCH-A** (800 × 1280, retrato) **ou** ESP32-P4 10,1" de tela integrada com o mesmo painel JD9365 | corredor central, a 1,50 m | casa toda: energia, água, bateria, alertas, cômodos, liga/desliga, alarme | **PoE** 802.3af do switch do rack (módulo PoE do P4-NANO) | `nexus_painel` (`PAINEL_MODO_CORREDOR`) |
| Cômodos | Waveshare **ESP32-S3-Touch-LCD-7** (800 × 480) | cada cômodo, ao lado da porta, a 1,30 m | aparelhos do cômodo + resumo da casa | fonte 5 V 2 A de embutir (caixa 4 × 4) ou USB-C | `nexus_painel` (`PAINEL_MODO_COMODO`, `PAINEL_COMODO "Cozinha"`) |
| Servidor | monitor HDMI 21"–24" | sala técnica ou escritório | NexusHome OS em tela cheia | — | `scripts/quiosque-nexushome.ps1` |

**Tela do corredor:** a parte de cima mostra a **planta da casa que está no NexusHome** (a mesma do app, desenhada no Editor de Planta ou importada do DXF). Cada cômodo é colorido pelo estado: âmbar com luz ou aparelho ligado, vermelho com alarme. Cada aparelho aparece como um ponto, e tocar num cômodo filtra a lista de aparelhos embaixo. Capturas: [`docs/img/painel-p4-planta.png`](img/painel-p4-planta.png), [`painel-p4-alarme.png`](img/painel-p4-alarme.png), [`painel-p4-deitado.png`](img/painel-p4-deitado.png) e [`painel-7-cozinha.png`](img/painel-7-cozinha.png); dá para refazer no PC com `firmware/nexus_painel/simulador/rodar.sh`.

As telas de corredor e de cômodo **não** ficam no RS-485. Elas falam com o NexusHome pela rede. Sem internet, mostram "sem conexão" e o último estado conhecido; a proteção continua nas telas do QAU.

---

## 14. Rede (rack 19")

| Item | Especificação |
|---|---|
| Rack | Rack de parede 19" **12U**, 570 mm de profundidade, porta de vidro, ventilação superior |
| Roteador / ONU | da operadora, mais o roteador Wi-Fi 6 (modo mesh, se necessário) |
| Switch | Gerenciável, **8–16 portas Gigabit, 4+ portas PoE 802.3af/at** (P4 do corredor e câmeras) |
| Servidor | Mini PC (Windows 11 ou Linux), SSD, saída HDMI para o monitor do quiosque |
| Patch panel | 24 portas Cat.6 + organizador |
| Alimentação | Régua do rack com DPS, no QDC (saída do inversor, modo UPS) |

**Plano de IPs** (DHCP reservado no roteador, rede 192.168.1.0/24):

| IP | Equipamento |
|---|---|
| .1 | roteador |
| .2 | switch |
| .10 | servidor NexusHome |
| .20 | P4 corredor |
| .21–.30 | telas 7" (uma por cômodo) |
| .40 | T1 Água |
| .41 | T2 Energia |
| .42 | T3 Segurança |
| .43 | T4 Nobreak |
| .50 | inversor (Wi-Fi) |
| .200 | gateway RS-485 (diagnóstico) |

**Recomendado:** uma VLAN "IoT" para as telas, sem acesso à rede dos computadores.

---

## 15. Integração com o NexusHome OS

### 15.1 UUIDs dos dispositivos

| Faixa | Barramento | Dispositivos |
|---|---|---|
| `b1000000-0000-4000-8000-0000000000NN` | C Água | 01–07 ramais, 08 reservatório. Válvula geral = `a3333333-3333-4333-8333-333333333333` |
| `b2000000-0000-4000-8000-0000000000NN` | A Energia | 00 total, 01–33 circuitos |
| `b3000000-0000-4000-8000-0000000000NN` | B Segurança | 01–10 luzes L01–L10; 21–30 sensores por cômodo; 31–32 gás; 33 válvula de gás; 41–42 exaustores; 50 alarme |
| `b4000000-0000-4000-8000-0000000000NN` | D Nobreak | 01 "Nobreak — banco LiFePO4" |

**Dispositivos do barramento B** (seed `supabase/seeds/unificado.sql`):

| UUID final | Nome | Tipo | Cômodo |
|---|---|---|---|
| 01–10 | Luz — <cômodo> (L01–L10 do §8 X4) | `light` | idem |
| 21 | Sensores — Sala de Estar | `sensor` | Sala de Estar |
| 22 | Sensores — Sala de TV | `sensor` | Sala de TV |
| 23 | Sensores — Cozinha | `sensor` | Cozinha |
| 24 | Sensores — Quarto Principal | `sensor` | Quarto Principal |
| 25 | Sensores — Quarto 2 | `sensor` | Quarto 2 |
| 26 | Sensores — Quarto 3 | `sensor` | Quarto 3 |
| 27 | Sensores — Banheiro 1 | `sensor` | Banheiro 1 |
| 28 | Sensores — Banheiro 2 | `sensor` | Banheiro 2 |
| 29 | Sensores — Lavanderia | `sensor` | Lavanderia |
| 30 | Sensores — Área Externa | `sensor` | Área Externa |
| 31 | Gás — Cozinha | `sensor` | Cozinha |
| 32 | Gás — Lavanderia | `sensor` | Lavanderia |
| 33 | Válvula de gás | `valve` | Cozinha |
| 41 | Exaustor — Banheiro 1 | `fan` | Banheiro 1 |
| 42 | Exaustor — Banheiro 2 | `fan` | Banheiro 2 |
| 50 | Alarme da casa | `alarm` | Sala de Estar |

Status publicado pelos sensores (chaves): `temp`, `hum`, `presence`, `smoke`, `heat`, `door` (`true` = porta **aberta**), `gas_lel`, `gas_al1`, `gas_al2`. Os alarmes ativos aparecem como `smoke: true`, `leak`/`gas: true` etc.; o app e as telas pintam de vermelho.

### 15.2 Servidor (iot-gateway v11, migração 025)

- `GET /iot-gateway/panel?room=&limit=&plan=0`: resumo da casa para P4 e 7". Com `plan=0` (P4 do corredor) vem também `ps`, a assinatura da planta do andar.
- `GET /iot-gateway/panel/plan?floor=0`: a planta do app (cômodos com polígonos, paredes e a posição de cada aparelho) para o P4 desenhar. A resposta traz `sig`. **A planta do P4 é sempre a da última versão do app**: não há planta gravada no firmware; o P4 baixa a planta ao ligar e, a cada consulta (3 s), compara `ps` com a assinatura da planta que está desenhando. Mudou um cômodo, parede ou aparelho no Editor de Planta (ou um DXF novo) → baixa e redesenha em poucos segundos, sem regravar nada. Por garantia, também baixa a cada 30 min.
- `POST /iot-gateway/panel/command {device_id, action, value}`: liga e desliga, brilho, temperatura, abrir e fechar, armar o alarme. Para aparelhos com `hw`, o comando vai para a fila da tela do barramento.
- Lote com `"source": "seguranca" | "agua" | "nobreak" | "eletrica"`: o alerta sai com o módulo certo.
- **Migração 025:** novas métricas de histórico: `battery_soc`, `battery_voltage`, `gas_lel`, `grid_voltage`, `power_backup_w`. **Sem a 025** o gateway grava o status (painel ao vivo) e responde "execute a migração 025" para o histórico novo.

---

## 16. Lista de compras (especificações)

### 16.1 Quadro e montagem

| Qtd | Item | Especificação mínima |
|---|---|---|
| 1 | Quadro de comando (QAU) | aço, IP54, 1200 × 800 × 300 mm, placa de montagem, porta com chave |
| 6 m | Trilho DIN TS35 | perfurado, 35 × 7,5 mm (R1–R6) |
| 7 m | Canaleta recortada | PVC cinza, 40 × 60 mm (3 m), 60 × 60 mm (1 m, C1) e 60 × 80 mm (3 m), com tampa |
| 1 | Barreira isolante | policarbonato 3 mm para separar a zona 220 V |
| 1 | Barra de terra | cobre, 12 furos, com isoladores |
| 2 | Grelhas de ventilação com filtro | 120 × 120 mm (IP54) |
| 1 | Ventilador + termostato DIN | 24 V, 120 mm, termostato NA 0–60 °C (opcional) |
| 4 | Molduras das telas | impressas em 3D (PETG preto) ou acrílico 3 mm usinado |
| 2 | Sinaleiros 22 mm | LED 24 V verde e vermelho |
| 1 | Botoeira de emergência | cogumelo 40 mm, giro para soltar, contato **NF**, 22 mm |
| 8 | Prensa-cabos | poliamida, 4 × M25 + 2 × M32 + 2 × M40 |
| 1 | Cordoalha de aterramento da porta | 6 mm², 300 mm |

### 16.2 Proteção e alimentação

| Qtd | Item | Especificação |
|---|---|---|
| 1 | Disjuntor Q2 | 2P, 6 A, curva C, 6 kA |
| 1 | DPS1 | classe II, 275 V, 20 kA (8/20 µs), F-N + N-PE |
| 1 | F1 | Mean Well **SDR-120-24** (24 V, 5 A, DIN) |
| 1 | F2 | Mean Well **DRC-100B** (27,6 V, 100 W, com carregador e alarme) |
| 2 | Baterias da F2 | VRLA 12 V 7 Ah (série) |
| 1 | Tomada de serviço DIN | 2P+T 10 A |
| 19 | Bornes-fusível | 5 × 20, com LED 24 V. Fusíveis rápidos: **10 × 1 A, 8 × 2 A** (tabelas X1/X2) e 1 × 5 A (bateria) |
| 1 | Disjuntor de comando no QDG | 1P, 2 A, curva C (fase de comando dos contatores) |

### 16.3 Controle e comunicação

| Qtd | Item | Especificação |
|---|---|---|
| 4 | Telas do QAU | Waveshare **ESP32-S3-Touch-LCD-4.3B** (N16R8, RS-485 isolado, 7–36 V) |
| 1 | Tela do corredor | Waveshare **ESP32-P4-NANO** + **10.1-DSI-TOUCH-A** + módulo PoE do NANO |
| 10 | Telas dos cômodos | Waveshare **ESP32-S3-Touch-LCD-7** (800 × 480) + fonte 5 V 2 A de embutir |
| 2 | Hubs RS-485 | isolados, 4 portas, trilho DIN, 9–36 V **(verificar o modelo: ex. "4-ch RS485 hub isolated DIN")** |
| 1 | Gateway | Waveshare RS485 TO WIFI/ETH (já comprado) |
| 2 | Relés de energia 32 canais | Waveshare Modbus RTU Relay 32CH (endereços 5 e 22) |
| 1 | Relé de energia 16 canais | Waveshare Modbus RTU Relay 16CH (endereço 6) |
| 1 | Relé da água | Waveshare Modbus RTU Relay 8CH (endereço 4) |
| 2 | Relés das luzes/saídas | Waveshare **Modbus RTU Relay (D)** 8CH + 8DI (endereços 90 e 91) |
| 2 | Entradas | Waveshare **Modbus RTU IO 8CH** (endereços 92 e 93) |
| 10 | Relés de retorno KR1–KR10 | Finder **38.51.0.240.0060** (bobina 230 V CA, 1 reversível 6 A) com base DIN |
| 2 | Relés de interface dos exaustores | Finder 38.51.7.024.0050 (bobina 24 V CC) |
| 8 | Sensores de temperatura/umidade | **XY-MD02** (SHT20, RS-485 Modbus) |
| 2 | Transmissores de gás | RS-485 Modbus + 2 relés AL1/AL2, 24 V, calibrados para GLP **ou** gás natural |
| 1 | Válvula de gás | solenoide NF com rearme manual, 24 V CC, certificada |
| 5 | Detectores de fumaça | óptico autônomo com saída a relé, 12–24 V (salas e quartos: X6.25–X6.40) |
| 1 | Detector térmico | termovelocimétrico com saída a relé (cozinha) |
| 8 | Sensores de presença | mmWave 24 GHz ou PIR de teto, **saída a relé**, 12–24 V |
| 2 | Contatos magnéticos | de sobrepor/embutir, NF |
| 1 | Botão de pânico | NA, com trava |
| 2 | Sirenes | 24 V, 110 dB (1 interna, 1 externa com strobe) |
| 1 | Shunt | 300 A / 75 mV |
| 1 | PZEM-017 | Peacefair, 0–300 V CC, RS-485 |
| 2 | PZEM-016 (nobreak) | Peacefair 100 A com TC de núcleo aberto |

### 16.4 Cabos e terminais

| Qtd | Item | Especificação |
|---|---|---|
| 305 m (1 caixa) | Cat.6 U/UTP | 4 pares 23 AWG, CM, para os home-runs dos sensores |
| 100 m | Cat.6 F/UTP blindado | 4 pares, para os ramos RS-485 de campo |
| 20 m | Cabo PP flexível blindado | 6 × 0,5 mm², para os chicotes da porta (e 2 × 0,5 mm² para o trecho do shunt) |
| 100 m de cada | Cabo flexível 750 V (classe 5) | 1,0 mm²: vermelho (comando CA), marrom (+24), azul-escuro (0 V) |
| 50 m | Cabo flexível 750 V | 0,5 mm² preto (sinais DI dentro do QAU) |
| 100 m de cada | Cabo flexível 750 V | 1,5 mm²: laranja (paralelos), cinza (retorno), azul-claro (N), preto (fase) |
| 25 m | Cabo flexível 750 V | 2,5 mm²: preto, azul-claro e verde-amarelo (entrada do QAU) |
| 4 m | Cabo de bateria | 35 mm² classe 5, vermelho e preto (2 m cada) |
| 3 m | Cabo de bateria | 50 mm² classe 5, vermelho e preto (1,5 m cada) |
| 1 kit | Terminais tubulares DIN 46228-4 | isolados, 0,5 / 0,75 / 1,0 / 1,5 / 2,5 mm² (500 de cada) + duplos 2 × 1,0 e 2 × 1,5 |
| 8 | Terminais de compressão | olhal M8 para 35 e 50 mm², cobre estanhado + termo-retrátil |
| 120 | Bornes push-in 2,5 mm² | R5: cinza (24 V e comando) + 30 azuis (neutro) + 20 verde-amarelo (terra) + tampas e pontes |
| 160 | Bornes push-in 1,5 mm² | R6 (X5–X9): cinza, **largura ≤ 4,2 mm** (148 + reserva) + tampas, batentes e pontes |
| 20 | Bornes push-in 4 mm² | cinza (entradas CA) |
| 1 rolo | Anilhas de identificação | letras e números para 0,5–2,5 mm² + etiquetas de borne |
| 10 | Resistores de terminação | 120 Ω ¼ W (um por ponta de ramo) |
| 1 | Alicate de crimpar | catraca, quadrado, 0,25–6 mm² |

### 16.5 Banco e inversor

| Qtd | Item | Especificação |
|---|---|---|
| 1 | Inversor híbrido | ANENJI ANJ-4000W-24V-WiFi (já definido) |
| 2 | Baterias | LiFePO4 24 V 100 Ah com BMS 100 A (ou 1 × 200 Ah / BMS 200 A) |
| 2 | Fusíveis por pack | classe T 150 A com porta-fusível |
| 1 | Seccionadora DC | 250 A, 48 V CC |
| 2 | Barramentos DC | cobre, M8, isolados (+ e −) |
| 1 | Chave reversora 1-0-2 | 2 polos, 40 A (bypass do inversor no QDC) |
| 2 | DPS classe II | 275 V (QDG e QDC) |

---

## 17. Montagem, passo a passo

1. **Bancada (antes de levar para a parede):**
   1. Fixe os trilhos e as canaletas nas cotas do §6.2.
   2. Monte os módulos na ordem do desenho `04-qau-interior.svg`.
   3. Cole as etiquetas.
2. **Endereçamento Modbus:** ligue **um aparelho por vez** na bancada (24 V + A/B) e grave o endereço do §5.2 com `scripts/enderecar-modbus.ps1`. Escreva o endereço com caneta no aparelho.
3. **Alimentação:**
   1. Ligue X0 → Q2 → DPS → F1/F2.
   2. Ligue as baterias da F2 **por último**.
   3. Meça 24 V em cada borne-fusível com os fusíveis **tirados**.
   4. Coloque os fusíveis um a um e veja cada módulo acender.
4. **Barramentos:**
   1. Ligue A, B e GND com o par trançado até o borne.
   2. Coloque a terminação (jumper na tela, jumper no hub, resistor no último aparelho).
   3. Grave os firmwares (`scripts/gravar-firmware.ps1`).
   4. Rode `scan` em cada tela (Monitor Serial ou `scripts/monitor-serial.ps1`). Todos os endereços do §5.2 precisam responder.
5. **Zona 220 V:** com **tudo desligado** no QDG, faça:
   1. X3 (comando dos contatores);
   2. X4 (luzes): um ponto por vez;
   3. o teste do three-way: a parede acende e apaga; a tela acende e apaga; o app mostra o estado certo.
6. **Segurança:**
   1. Teste a cadeia de gás antes de abrir o gás: aperte a botoeira (a válvula fecha); simule AL2 tirando o fio (a válvula fecha e a sirene toca).
   2. Teste com **gás-padrão** (spray de calibração) no transmissor.
7. **Rede:**
   1. Reserve os IPs do §14.
   2. Ligue o P4 no PoE.
   3. Configure as telas de 7" com o nome exato do cômodo.
   4. Rode `scripts/quiosque-nexushome.ps1 -Instalar` no servidor.
8. **NexusHome:**
   1. Rode a migração 025 e o seed `unificado.sql` no SQL Editor.
   2. Publique o `iot-gateway` (`scripts/publicar-funcoes.ps1`).
   3. Confira os dispositivos no app.
9. **Teste de falta de energia:**
   1. Desligue a rede no QDG. O inversor assume; a T4 mostra "Casa no inversor" e o celular recebe o push.
   2. Desligue também o inversor pela chave 1-0-2. A F2 mantém a segurança (T3 ligada).
   3. Religue tudo.

---

## 18. Scripts (Windows PowerShell 5.1 ou 7)

| Script | Para quê |
|---|---|
| `scripts/instalar-arduino.ps1` | instala Arduino IDE/CLI, core 3.3.12 e bibliotecas (ESP32_Display_Panel, lvgl, ArduinoJson) e grava um firmware: `-Firmware hidraulica\|eletrica\|seguranca\|nobreak\|painel` |
| `scripts/gravar-firmware.ps1` | compila e grava qualquer firmware (S3 4.3B, S3 7", P4 10,1") com o FQBN certo; `-SoCompilar` para testar |
| `scripts/monitor-serial.ps1` | abre o monitor serial (115200), lista as portas COM e manda comandos (`status`, `scan`) |
| `scripts/enderecar-modbus.ps1` | grava o endereço Modbus de **um** aparelho ligado ao PC por adaptador USB-RS485 (PZEM-016/017, Relay Waveshare, XY-MD02) |
| `scripts/testar-modbus.ps1` | lê registradores pelo gateway Modbus TCP ou pelo adaptador USB-RS485 (diagnóstico) |
| `scripts/quiosque-nexushome.ps1` | instala o NexusHome em tela cheia no monitor do servidor (Edge/Chrome em modo quiosque, inicia com o Windows) |
| `scripts/publicar-funcoes.ps1` | publica as Edge Functions no Supabase (exige o Supabase CLI e login; não pede segredos) |
| `scripts/testar-painel.ps1` | consulta `/iot-gateway/panel` e `/commands` com a chave do dispositivo, para conferir o servidor |

---

## 19. Normas e pendências

**Normas de referência:**
- NBR 5410 (instalações de baixa tensão);
- NBR 5419 (DPS);
- NBR 14136 (tomadas);
- NBR 17240 (detecção de incêndio);
- NBR 15526 e NBR 13103 (gás);
- NBR IEC 60079 (atmosferas explosivas);
- NBR IEC 61439 (quadros);
- NBR IEC 60204-1 (cores de comando);
- NR-10.

**Pendências do usuário:**
1. Quadro de cargas real (substitui a tabela provisória de 33 circuitos).
2. Tensão da rede (127/220 V ou 220/380 V) e esquema de aterramento.
3. Gás usado (GLP ou natural).
4. Modelos comprados dos transmissores de gás, sensores de presença e hubs: confirmar os mapas de registradores e as entradas.
5. Manual do inversor: bitolas, parametrização e ligação N-PE da saída.

# Simulador da tela do painel

Desenha a interface do `nexus_painel` **no PC, sem placa**, com o mesmo `ui.cpp` do firmware. O LVGL 8.4 é compilado com g++, e os arquivos desta pasta substituem a placa, a porta LVGL e o FreeRTOS. Os dados de exemplo saem do próprio servidor (`panel.ts` e `plan.ts`), com a **planta real da casa** (`supabase/seeds/residencia.sql`, importada do DXF) e os aparelhos do `seed unificado.sql`.

```bash
firmware/nexus_painel/simulador/rodar.sh /tmp/telas
```

Ele gera:

| Arquivo | Tela |
|---|---|
| `corredor-1.png` | P4 10,1" em pé |
| `corredor-2.png` | a mesma tela depois de um toque na Cozinha (a planta filtra os aparelhos) |
| `corredor-alarme-1.png` | fumaça na Sala de TV |
| `corredor-deitado-1.png` | P4 deitado (1280 × 800) |
| `comodo-cozinha-1.png` | tela de 7" da Cozinha |
| `producao-1.png` | só com `NEXUS_DEVICE_KEY` no ambiente: a **planta e os aparelhos atuais** do NexusHome (lidos do iot-gateway de produção) |

O seed é só o exemplo do repositório. A placa de verdade **não usa o seed**: desenha sempre a planta que está no app (veja o LEIA-ME do painel).

Precisa de g++, node, python3 com Pillow e das bibliotecas lvgl 8.4 e ArduinoJson 7. Indique a pasta delas com `LVGL_DIR` e `ARDUINOJSON_DIR`.

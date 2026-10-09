# Importar uma planta real (DWG/DXF)

O editor de planta lê **DXF ASCII**. O **DWG** é um formato binário proprietário e não pode ser lido de forma confiável no navegador — converta antes.

## 1. Converter DWG → DXF

Qualquer uma das opções:

- **AutoCAD / BricsCAD / DraftSight**: *Salvar como* → `AutoCAD DXF (R12 ou 2000/2004/2007, ASCII)`.
- **LibreCAD / QCAD** (gratuitos): abra o DWG → *Salvar como* → DXF.
- **ODA File Converter** (gratuito): converta uma pasta de DWG para *ACAD2000 DXF* (ASCII).

Use versões R12 a 2018 em **ASCII** (não "binary DXF").

## 2. Preparar o desenho (opcional, melhora o resultado)

- Deixe as **paredes numa camada própria** (ex.: `PAREDES`, `WALL`, `A-WALL`); o importador a pré-seleciona.
- Cômodos viram polígonos quando são **polilinhas fechadas**. Paredes desenhadas só como linhas soltas viram paredes 3D, mas você desenha os cômodos com a ferramenta *Polígono* por cima.
- Apague cotas, textos, móveis e hachuras (são ignorados; HATCH, SPLINE e 3DFACE não são lidos).

## 3. Importar

1. Abra **Planta** → **Importar CAD** e escolha o `.dxf`.
2. Marque as camadas desejadas e confira a **unidade** (mm, cm, m ou polegada — estimada pelo tamanho do desenho; ajuste se as dimensões estiverem erradas). Prévia e tamanho (ex.: 12 × 9 m) aparecem na janela.
3. Escolha **Substituir o conteúdo deste andar** ou **Adicionar**.
4. Revise no editor e clique em **Salvar planta**. O desenho é centralizado na origem.

**Cômodos detectados automaticamente:** quando o desenho não tem polilinhas fechadas (caso comum: paredes em linha dupla, com vãos de portas e janelas), o importador procura as áreas cercadas pelas paredes e cria um cômodo para cada uma. Vãos de até ~1 m são fechados; entradas mais largas são fechadas numa segunda passada. Camadas de janelas/portas (nomes como `ESQUADRIA`, `JANELA`, `PORTA`) ajudam a fechar os vãos, mas não viram paredes. Os cômodos vêm como "Cômodo N": renomeie e ajuste o tipo no editor. Confira o resultado antes de salvar.

Limite: 30000 segmentos por importação — selecione só as camadas de paredes se o arquivo for grande.

## 4. Persistência

Para salvar cômodos poligonais com a forma exata, rode `supabase/migrations/008_room_polygons.sql` no SQL Editor. Sem a migração, os cômodos são salvos como retângulos e o editor avisa.

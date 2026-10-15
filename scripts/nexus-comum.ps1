<#
.SYNOPSIS
  Funções comuns dos scripts do NexusHome OS (não é para rodar sozinho).

.DESCRIPTION
  Carregado pelos outros scripts da pasta scripts\ com ". $PSScriptRoot\nexus-comum.ps1".
  Reúne:
    - mensagens padronizadas em português e confirmação S/N;
    - Modbus RTU / Modbus TCP: CRC16, montagem de quadros, conferência de respostas,
      interpretação do PZEM-016 / PZEM-017, envio pela serial e pelo gateway TCP;
    - firmware: tabela de FQBN por firmware/placa, cópia preservando Wi-Fi e chave,
      localização do arduino-cli e leitura do tamanho compilado;
    - HTTP do iot-gateway e resumo legível do /panel;
    - cálculo da linha de comando do quiosque.
  Funciona no Windows PowerShell 5.1 e no PowerShell 7 (sem operadores exclusivos do 7).
  As funções "puras" (sem efeito colateral) são testadas por scripts\testes\rodar-testes.ps1.

.EXAMPLE
  . "$PSScriptRoot\nexus-comum.ps1"
  Get-ModbusCrc -Bytes ([byte[]](1, 4, 0, 0, 0, 10))     # -> 0x70 0x0D
#>

# ------------------------------------------------------------------
# Constantes do projeto
# ------------------------------------------------------------------
$script:NexusProjetoRef  = 'gfjxcsvxhaojbtuixpjh'
$script:NexusGatewayUrl  = 'https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway'
$script:NexusAppUrl      = 'https://nexushome-os.vercel.app'
$script:NexusCoreEsp32   = 'esp32:esp32@3.3.12'
$script:NexusBibliotecas = @('ESP32_Display_Panel@1.0.4', 'lvgl@8.4.0', 'ArduinoJson@7.4.2')
$script:NexusFqbnS3      = 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc'
$script:NexusFqbnP4      = 'esp32:esp32:esp32p4:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled'
$script:NexusSegredos    = @('WIFI_SSID', 'WIFI_PASSWORD', 'DEVICE_SECRET')
$script:NexusLinhasPainel = @('PAINEL_MODO', 'PAINEL_COMODO', 'PAINEL_PLACA')

# ------------------------------------------------------------------
# Mensagens e utilidades gerais
# ------------------------------------------------------------------
function Write-NexusPasso { param([string]$Texto) Write-Host "`n$Texto" -ForegroundColor Cyan }
function Write-NexusOk    { param([string]$Texto) Write-Host $Texto -ForegroundColor Green }
function Write-NexusAviso { param([string]$Texto) Write-Host $Texto -ForegroundColor Yellow }
function Write-NexusErro  { param([string]$Texto) Write-Host "ERRO: $Texto" -ForegroundColor Red }

function Test-NexusWindows {
  # $IsWindows não existe no Windows PowerShell 5.1 (e o StrictMode reclamaria); OSVersion funciona nos dois
  return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

function Confirm-Nexus {
  <# Pergunta S/N. Devolve $true só com "s"/"sim". Sem console interativo devolve $false. #>
  param([Parameter(Mandatory = $true)][string]$Pergunta)
  try { $r = Read-Host "$Pergunta (S/N)" } catch { return $false }
  return ("$r".Trim() -match '^(s|sim|y|yes)$')
}

function Get-NexusPropriedade {
  <# Lê uma propriedade de um objeto do ConvertFrom-Json sem quebrar no StrictMode quando ela não existe. #>
  param($Objeto, [Parameter(Mandatory = $true)][string]$Nome, $Padrao = $null)
  if ($null -eq $Objeto) { return $Padrao }
  if ($Objeto -is [System.Collections.IDictionary]) {
    if ($Objeto.Contains($Nome)) { return $Objeto[$Nome] } else { return $Padrao }
  }
  $p = $Objeto.PSObject.Properties[$Nome]
  if ($null -eq $p) { return $Padrao }
  return $p.Value
}

function Format-NexusHex {
  param([AllowNull()][AllowEmptyCollection()][byte[]]$Bytes)
  if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '(vazio)' }
  return (($Bytes | ForEach-Object { $_.ToString('X2') }) -join ' ')
}

function ConvertFrom-NexusHex {
  param([Parameter(Mandatory = $true)][string]$Texto)
  $limpo = ($Texto -replace '[^0-9A-Fa-f]', '')
  if ($limpo.Length % 2) { throw "hexadecimal com número ímpar de dígitos: $Texto" }
  $saida = New-Object byte[] ($limpo.Length / 2)
  for ($i = 0; $i -lt $saida.Length; $i++) { $saida[$i] = [Convert]::ToByte($limpo.Substring($i * 2, 2), 16) }
  return , $saida
}

function Invoke-NexusNativo {
  <#
    Roda um .exe mostrando a saída na tela e guardando o texto. Devolve @{ Codigo; Saida }.
    'Continue' aqui dentro: no Windows PowerShell 5.1 com 'Stop', qualquer linha no stderr de um .exe vira erro fatal.
  #>
  param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Argumentos = @(), [switch]$Silencioso)
  $antes = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $linhas = New-Object System.Collections.Generic.List[string]
  try {
    & $Exe @Argumentos 2>&1 | ForEach-Object {
      $s = "$_"
      $linhas.Add($s)
      if (-not $Silencioso) { Write-Host $s }
    }
    $codigo = $LASTEXITCODE
  } finally { $ErrorActionPreference = $antes }
  if ($null -eq $codigo) { $codigo = 0 }
  return [pscustomobject]@{ Codigo = [int]$codigo; Saida = ($linhas -join "`n") }
}

# ------------------------------------------------------------------
# Modbus — funções puras
# ------------------------------------------------------------------
function Get-ModbusCrc {
  <#
  .SYNOPSIS
    CRC16 do Modbus RTU (polinômio 0xA001, início 0xFFFF).
  .DESCRIPTION
    Devolve 2 bytes na ordem em que vão no fio: byte baixo primeiro.
    Ex.: 01 04 00 00 00 0A -> 70 0D.
  #>
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)
  $crc = 0xFFFF
  foreach ($b in $Bytes) {
    $crc = $crc -bxor [int]$b
    for ($i = 0; $i -lt 8; $i++) {
      if ($crc -band 1) { $crc = ($crc -shr 1) -bxor 0xA001 } else { $crc = $crc -shr 1 }
    }
  }
  return , ([byte[]]@(($crc -band 0xFF), (($crc -shr 8) -band 0xFF)))
}

function New-ModbusPdu {
  <# PDU das funções 03/04 (Valor = quantidade) e 06 (Valor = valor gravado): função + registro + valor. #>
  param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 127)][int]$Funcao,
    [ValidateRange(0, 65535)][int]$Registro = 0,
    [ValidateRange(0, 65535)][int]$Valor = 0
  )
  return , ([byte[]]@($Funcao, ($Registro -shr 8), ($Registro -band 0xFF), ($Valor -shr 8), ($Valor -band 0xFF)))
}

function New-ModbusFrame {
  <#
  .SYNOPSIS
    Monta um quadro Modbus RTU completo: escravo + PDU + CRC.
  .EXAMPLE
    New-ModbusFrame -Slave 0xF8 -Funcao 6 -Registro 2 -Valor 7   # PZEM: grava o endereço 7 (F8 06 00 02 00 07 7D A1)
  #>
  param(
    [Parameter(Mandatory = $true)][ValidateRange(0, 255)][int]$Slave,
    [Parameter(Mandatory = $true)][ValidateRange(1, 127)][int]$Funcao,
    [ValidateRange(0, 65535)][int]$Registro = 0,
    [ValidateRange(0, 65535)][int]$Valor = 0
  )
  $pdu = New-ModbusPdu -Funcao $Funcao -Registro $Registro -Valor $Valor
  $corpo = [byte[]](@([byte]$Slave) + $pdu)
  $crc = Get-ModbusCrc -Bytes $corpo
  return , ([byte[]]($corpo + $crc))
}

function New-ModbusTcpFrame {
  <#
  .SYNOPSIS
    Monta um quadro Modbus TCP: cabeçalho MBAP (7 bytes) + PDU (sem CRC).
  .DESCRIPTION
    MBAP = transação (2) + protocolo 0 (2) + comprimento (2, = PDU + 1) + unidade/escravo (1).
  #>
  param(
    [Parameter(Mandatory = $true)][ValidateRange(0, 65535)][int]$Transacao,
    [Parameter(Mandatory = $true)][ValidateRange(0, 255)][int]$Unidade,
    [Parameter(Mandatory = $true)][byte[]]$Pdu
  )
  $tam = $Pdu.Length + 1
  $mbap = [byte[]]@(($Transacao -shr 8), ($Transacao -band 0xFF), 0, 0, ($tam -shr 8), ($tam -band 0xFF), $Unidade)
  return , ([byte[]]($mbap + $Pdu))
}

function Get-ModbusExcecaoTexto {
  param([int]$Codigo)
  switch ($Codigo) {
    1  { return 'função não suportada pelo aparelho (exceção 0x01)' }
    2  { return 'registrador inexistente neste aparelho (exceção 0x02)' }
    3  { return 'valor ou quantidade inválida (exceção 0x03)' }
    4  { return 'falha interna do aparelho (exceção 0x04)' }
    6  { return 'aparelho ocupado, tente de novo (exceção 0x06)' }
    10 { return 'gateway sem caminho para o barramento: confira a porta serial do gateway (exceção 0x0A)' }
    11 { return 'o escravo não respondeu ao gateway (exceção 0x0B): endereço errado, A/B invertidos, aparelho sem alimentação, baud/paridade diferente ou terminação' }
    default { return ('exceção Modbus 0x{0:X2}' -f $Codigo) }
  }
}

function Test-ModbusPdu {
  <# Confere a PDU da resposta contra a PDU do pedido. Usada pelo RTU e pelo TCP. #>
  param([Parameter(Mandatory = $true)][byte[]]$PedidoPdu, [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$RespostaPdu)
  $r = [ordered]@{ Ok = $false; Excecao = $false; Codigo = 0; Mensagem = ''; Registros = @(); Dados = [byte[]]@() }
  if ($RespostaPdu.Length -lt 2) { $r.Mensagem = "resposta curta ($($RespostaPdu.Length) bytes)"; return [pscustomobject]$r }
  $fn = [int]$PedidoPdu[0]
  $fnR = [int]$RespostaPdu[0]
  if ($fnR -eq ($fn -bor 0x80)) {
    $r.Excecao = $true; $r.Codigo = [int]$RespostaPdu[1]; $r.Mensagem = Get-ModbusExcecaoTexto -Codigo $r.Codigo
    return [pscustomobject]$r
  }
  if ($fnR -ne $fn) { $r.Mensagem = ('função 0x{0:X2} na resposta, esperada 0x{1:X2}' -f $fnR, $fn); return [pscustomobject]$r }
  if ($fn -eq 3 -or $fn -eq 4) {
    $qtd = ([int]$PedidoPdu[3] -shl 8) -bor [int]$PedidoPdu[4]
    $n = [int]$RespostaPdu[1]
    if ($n -ne $qtd * 2 -or $RespostaPdu.Length -ne 2 + $n) {
      $r.Mensagem = "tamanho inesperado: $n bytes de dados para $qtd registradores"; return [pscustomobject]$r
    }
    $regs = New-Object int[] $qtd
    for ($i = 0; $i -lt $qtd; $i++) { $regs[$i] = ([int]$RespostaPdu[2 + 2 * $i] -shl 8) -bor [int]$RespostaPdu[3 + 2 * $i] }
    $r.Registros = $regs
    $r.Dados = [byte[]]$RespostaPdu[2..(1 + $n)]
    $r.Ok = $true; $r.Mensagem = 'ok'
    return [pscustomobject]$r
  }
  if ($fn -eq 6) {
    if ($RespostaPdu.Length -ne 5 -or (Format-NexusHex $RespostaPdu) -ne (Format-NexusHex $PedidoPdu)) {
      $r.Mensagem = 'a resposta da gravação (06) não é o eco do pedido'; return [pscustomobject]$r
    }
    $r.Registros = @((([int]$RespostaPdu[3] -shl 8) -bor [int]$RespostaPdu[4]))
    $r.Ok = $true; $r.Mensagem = 'ok'
    return [pscustomobject]$r
  }
  $r.Dados = [byte[]]$RespostaPdu[1..($RespostaPdu.Length - 1)]
  $r.Ok = $true; $r.Mensagem = 'ok'
  return [pscustomobject]$r
}

function Test-ModbusResponse {
  <#
  .SYNOPSIS
    Confere uma resposta Modbus RTU: tamanho, CRC, escravo, função, eco (06) ou contagem (03/04), exceções.
  .DESCRIPTION
    Devolve um objeto com Ok, Excecao, Codigo, Mensagem e Registros (int[]).
    Pedidos ao endereço geral (0xF8 do PZEM) ou broadcast (0x00) aceitam qualquer escravo na resposta.
  #>
  param([Parameter(Mandatory = $true)][byte[]]$Pedido, [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Resposta)
  if ($Resposta.Length -eq 0) {
    return [pscustomobject]@{ Ok = $false; Excecao = $false; Codigo = 0; Mensagem = 'sem resposta'; Registros = @(); Dados = [byte[]]@() }
  }
  if ($Resposta.Length -lt 5) {
    return [pscustomobject]@{ Ok = $false; Excecao = $false; Codigo = 0; Mensagem = "resposta curta ($($Resposta.Length) bytes): $(Format-NexusHex $Resposta)"; Registros = @(); Dados = [byte[]]@() }
  }
  $corpo = [byte[]]$Resposta[0..($Resposta.Length - 3)]
  $crc = Get-ModbusCrc -Bytes $corpo
  if ($crc[0] -ne $Resposta[$Resposta.Length - 2] -or $crc[1] -ne $Resposta[$Resposta.Length - 1]) {
    return [pscustomobject]@{ Ok = $false; Excecao = $false; Codigo = 0; Mensagem = "CRC inválido (ruído no barramento? terminação?): $(Format-NexusHex $Resposta)"; Registros = @(); Dados = [byte[]]@() }
  }
  $esc = [int]$Pedido[0]
  if ($esc -ne 0 -and $esc -ne 0xF8 -and [int]$Resposta[0] -ne $esc) {
    return [pscustomobject]@{ Ok = $false; Excecao = $false; Codigo = 0; Mensagem = "respondeu o escravo $([int]$Resposta[0]), esperado $esc (dois aparelhos com o mesmo endereço?)"; Registros = @(); Dados = [byte[]]@() }
  }
  $pduPed = [byte[]]$Pedido[1..($Pedido.Length - 3)]
  return (Test-ModbusPdu -PedidoPdu $pduPed -RespostaPdu ([byte[]]$corpo[1..($corpo.Length - 1)]))
}

function Test-ModbusTcpResponse {
  <# Confere uma resposta Modbus TCP: MBAP (transação, protocolo, comprimento, unidade) e PDU. #>
  param([Parameter(Mandatory = $true)][byte[]]$Pedido, [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Resposta)
  $falha = { param($m) [pscustomobject]@{ Ok = $false; Excecao = $false; Codigo = 0; Mensagem = $m; Registros = @(); Dados = [byte[]]@() } }
  if ($Resposta.Length -eq 0) { return (& $falha 'sem resposta') }
  if ($Resposta.Length -lt 9) { return (& $falha "resposta curta ($($Resposta.Length) bytes): $(Format-NexusHex $Resposta)") }
  if ($Resposta[0] -ne $Pedido[0] -or $Resposta[1] -ne $Pedido[1]) { return (& $falha 'número de transação diferente do pedido') }
  if ($Resposta[2] -ne 0 -or $Resposta[3] -ne 0) { return (& $falha 'protocolo diferente de 0 (não é Modbus TCP; gateway em modo transparente? use -Transparente)') }
  $tam = ([int]$Resposta[4] -shl 8) -bor [int]$Resposta[5]
  if ($tam -ne $Resposta.Length - 6) { return (& $falha "comprimento do MBAP ($tam) não bate com a resposta ($($Resposta.Length - 6))") }
  if ($Resposta[6] -ne $Pedido[6]) { return (& $falha "respondeu a unidade $([int]$Resposta[6]), esperada $([int]$Pedido[6])") }
  return (Test-ModbusPdu -PedidoPdu ([byte[]]$Pedido[7..($Pedido.Length - 1)]) -RespostaPdu ([byte[]]$Resposta[7..($Resposta.Length - 1)]))
}

function Get-ModbusTamanhoEsperado {
  <# Quantos bytes a resposta RTU terá, olhando o que já chegou (0 = ainda não dá para saber). #>
  param([Parameter(Mandatory = $true)][byte[]]$Pedido, [AllowEmptyCollection()][byte[]]$Parcial = @())
  if ($Parcial.Length -lt 2) { return 0 }
  $fn = [int]$Parcial[1]
  if ($fn -band 0x80) { return 5 }
  if ($fn -eq 3 -or $fn -eq 4) { if ($Parcial.Length -lt 3) { return 0 }; return 5 + [int]$Parcial[2] }
  if ($fn -eq 5 -or $fn -eq 6 -or $fn -eq 15 -or $fn -eq 16) { return 8 }
  return 0
}

function ConvertFrom-Pzem016 {
  <#
  .SYNOPSIS
    Interpreta os 10 registradores de entrada (função 04, a partir de 0) do PZEM-016.
  .DESCRIPTION
    0 tensão 0,1 V · 1-2 corrente 0,001 A · 3-4 potência 0,1 W · 5-6 energia 1 Wh ·
    7 frequência 0,1 Hz · 8 fator de potência 0,01 · 9 alarme (0xFFFF = ligado).
    Valores de 32 bits vêm com a palavra BAIXA primeiro.
  #>
  param([Parameter(Mandatory = $true)][int[]]$Registros)
  if ($Registros.Length -lt 10) { throw "o PZEM-016 precisa de 10 registradores (vieram $($Registros.Length))" }
  $r = $Registros
  return [pscustomobject]@{
    TensaoV       = $r[0] / 10.0
    CorrenteA     = ([double]$r[1] + [double]$r[2] * 65536) / 1000.0
    PotenciaW     = ([double]$r[3] + [double]$r[4] * 65536) / 10.0
    EnergiaWh     = [double]$r[5] + [double]$r[6] * 65536
    FrequenciaHz  = $r[7] / 10.0
    FatorPotencia = $r[8] / 100.0
    Alarme        = ($r[9] -ne 0)
  }
}

function ConvertFrom-Pzem017 {
  <#
  .SYNOPSIS
    Interpreta os 8 registradores de entrada do PZEM-017 (CC, shunt).
  .DESCRIPTION
    0 tensão 0,01 V · 1 corrente 0,01 A · 2-3 potência 0,1 W · 4-5 energia 1 Wh ·
    6 alarme de tensão alta · 7 alarme de tensão baixa (0xFFFF = ligado).
  #>
  param([Parameter(Mandatory = $true)][int[]]$Registros)
  if ($Registros.Length -lt 8) { throw "o PZEM-017 precisa de 8 registradores (vieram $($Registros.Length))" }
  $r = $Registros
  return [pscustomobject]@{
    TensaoV      = $r[0] / 100.0
    CorrenteA    = $r[1] / 100.0
    PotenciaW    = ([double]$r[2] + [double]$r[3] * 65536) / 10.0
    EnergiaWh    = [double]$r[4] + [double]$r[5] * 65536
    AlarmeAlta   = ($r[6] -ne 0)
    AlarmeBaixa  = ($r[7] -ne 0)
  }
}

function Format-NexusNumero {
  param([double]$Valor, [string]$Formato = '0.0')
  return $Valor.ToString($Formato, [System.Globalization.CultureInfo]::GetCultureInfo('pt-BR'))
}

function Format-Pzem016 {
  param([Parameter(Mandatory = $true)]$Leitura)
  $alarme = 'não'; if ($Leitura.Alarme) { $alarme = 'SIM' }
  return @(
    "  Tensão ........ $(Format-NexusNumero $Leitura.TensaoV '0.0') V",
    "  Corrente ...... $(Format-NexusNumero $Leitura.CorrenteA '0.000') A",
    "  Potência ...... $(Format-NexusNumero $Leitura.PotenciaW '0.0') W",
    "  Energia ....... $(Format-NexusNumero $Leitura.EnergiaWh '#,##0') Wh",
    "  Frequência .... $(Format-NexusNumero $Leitura.FrequenciaHz '0.0') Hz",
    "  Fator de pot. . $(Format-NexusNumero $Leitura.FatorPotencia '0.00')",
    "  Alarme ........ $alarme"
  )
}

function Format-Pzem017 {
  param([Parameter(Mandatory = $true)]$Leitura)
  $a = 'não'; if ($Leitura.AlarmeAlta) { $a = 'SIM' }
  $b = 'não'; if ($Leitura.AlarmeBaixa) { $b = 'SIM' }
  return @(
    "  Tensão ........ $(Format-NexusNumero $Leitura.TensaoV '0.00') V",
    "  Corrente ...... $(Format-NexusNumero $Leitura.CorrenteA '0.00') A",
    "  Potência ...... $(Format-NexusNumero $Leitura.PotenciaW '0.0') W",
    "  Energia ....... $(Format-NexusNumero $Leitura.EnergiaWh '#,##0') Wh",
    "  Alarme alta ... $a",
    "  Alarme baixa .. $b"
  )
}

function Get-NexusEnderecoInfo {
  <#
    Registrador e formato serial usados para gravar o endereço de cada tipo de aparelho.
    Geral = endereço que responde independentemente do endereço atual (só com UM aparelho no fio).
  #>
  param([Parameter(Mandatory = $true)][ValidateSet('pzem016', 'pzem017', 'waveshare', 'xymd02')][string]$Tipo)
  switch ($Tipo) {
    'pzem016'   { return [pscustomobject]@{ Tipo = $Tipo; Nome = 'PZEM-016';                 Registro = 0x0002; Geral = 0xF8; Formato = '8N1' } }
    'pzem017'   { return [pscustomobject]@{ Tipo = $Tipo; Nome = 'PZEM-017';                 Registro = 0x0002; Geral = 0xF8; Formato = '8N2' } }
    'waveshare' { return [pscustomobject]@{ Tipo = $Tipo; Nome = 'Waveshare Modbus RTU Relay'; Registro = 0x4000; Geral = 0x00; Formato = '8N1' } }
    'xymd02'    { return [pscustomobject]@{ Tipo = $Tipo; Nome = 'XY-MD02';                  Registro = 0x0101; Geral = -1;   Formato = '8N1' } }
  }
}

# ------------------------------------------------------------------
# Modbus — transporte (serial e TCP)
# ------------------------------------------------------------------
function Open-NexusSerial {
  <# Abre a porta serial. Formato 8N1 ou 8N2. Erros viram mensagens em português. #>
  param(
    [Parameter(Mandatory = $true)][string]$Porta,
    [int]$Baud = 9600,
    [ValidateSet('8N1', '8N2')][string]$Formato = '8N1',
    [int]$TimeoutMs = 1000,
    [switch]$Dtr
  )
  $parar = [System.IO.Ports.StopBits]::One
  if ($Formato -eq '8N2') { $parar = [System.IO.Ports.StopBits]::Two }
  $sp = New-Object System.IO.Ports.SerialPort $Porta, $Baud, ([System.IO.Ports.Parity]::None), 8, $parar
  $sp.ReadTimeout = $TimeoutMs
  $sp.WriteTimeout = $TimeoutMs
  $sp.Encoding = New-Object System.Text.UTF8Encoding $false
  $existe = $true
  if (Test-NexusWindows) { $existe = @([System.IO.Ports.SerialPort]::GetPortNames()) -contains $Porta }
  else { $existe = Test-Path -LiteralPath $Porta }
  if (-not $existe) { throw "não consegui abrir ${Porta}: a porta não existe. Veja as portas com: scripts\monitor-serial.ps1 -Listar" }
  try { $sp.Open() }
  catch [System.UnauthorizedAccessException] {
    throw "a porta $Porta está ocupada. Feche o Monitor Serial da Arduino IDE (ou outro programa) e tente de novo."
  }
  catch {
    $m = $_.Exception.Message
    if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }
    throw "não consegui abrir $Porta ($m). Veja as portas com: scripts\monitor-serial.ps1 -Listar"
  }
  if ($Dtr) {
    # ESP32-S3 com USB nativo (CDC): DTR ligado = "terminal conectado"; RTS fica desligado (RTS sem DTR reinicia a placa).
    # Depois do Open: num pty (testes no Linux) o ioctl de DTR falha e é ignorado.
    try { $sp.RtsEnable = $false; $sp.DtrEnable = $true } catch { }
  }
  return $sp
}

function Invoke-ModbusRtu {
  <# Envia um quadro RTU pela serial e devolve os bytes recebidos (vazio = sem resposta no prazo). #>
  param(
    [Parameter(Mandatory = $true)]$Serial,
    [Parameter(Mandatory = $true)][byte[]]$Pedido,
    [int]$TimeoutMs = 1000
  )
  try { $Serial.DiscardInBuffer() } catch { }
  $Serial.Write($Pedido, 0, $Pedido.Length)
  $buf = New-Object System.Collections.Generic.List[byte]
  $relogio = [System.Diagnostics.Stopwatch]::StartNew()
  while ($relogio.ElapsedMilliseconds -lt $TimeoutMs) {
    $n = $Serial.BytesToRead
    if ($n -gt 0) {
      $tmp = New-Object byte[] $n
      $lidos = $Serial.Read($tmp, 0, $n)
      for ($i = 0; $i -lt $lidos; $i++) { $buf.Add($tmp[$i]) }
      $esperado = Get-ModbusTamanhoEsperado -Pedido $Pedido -Parcial $buf.ToArray()
      if ($esperado -gt 0 -and $buf.Count -ge $esperado) { break }
    } else { Start-Sleep -Milliseconds 5 }
  }
  return , ($buf.ToArray())
}

function Invoke-ModbusTcp {
  <#
    Envia um quadro ao gateway e devolve os bytes recebidos.
    Modbus TCP (MBAP) por padrão; -Transparente manda o quadro RTU (com CRC) dentro do TCP.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Ip,
    [int]$Porta = 502,
    [Parameter(Mandatory = $true)][byte[]]$Pedido,
    [int]$TimeoutMs = 2000,
    [switch]$Transparente
  )
  $cli = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $cli.BeginConnect($Ip, $Porta, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      throw "sem conexão com ${Ip}:$Porta em $TimeoutMs ms (gateway ligado? IP certo? mesmo segmento de rede?)"
    }
    try { $cli.EndConnect($ar) }
    catch {
      $m = $_.Exception.Message; if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }
      throw "conexão recusada por ${Ip}:$Porta ($m). O gateway está em modo servidor TCP na porta ${Porta}?"
    }
    $st = $cli.GetStream()
    $st.Write($Pedido, 0, $Pedido.Length)
    $st.Flush()
    $buf = New-Object System.Collections.Generic.List[byte]
    $relogio = [System.Diagnostics.Stopwatch]::StartNew()
    $tmp = New-Object byte[] 512
    while ($relogio.ElapsedMilliseconds -lt $TimeoutMs) {
      if ($st.DataAvailable) {
        $n = $st.Read($tmp, 0, $tmp.Length)
        if ($n -le 0) { break }
        for ($i = 0; $i -lt $n; $i++) { $buf.Add($tmp[$i]) }
        $atual = $buf.ToArray()
        if ($Transparente) {
          $esperado = Get-ModbusTamanhoEsperado -Pedido $Pedido -Parcial $atual
        } elseif ($atual.Length -ge 6) {
          $esperado = 6 + (([int]$atual[4] -shl 8) -bor [int]$atual[5])
        } else { $esperado = 0 }
        if ($esperado -gt 0 -and $atual.Length -ge $esperado) { break }
      } else {
        if ($cli.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $cli.Client.Available -eq 0) { break }  # o gateway fechou
        Start-Sleep -Milliseconds 5
      }
    }
    return , ($buf.ToArray())
  } finally { $cli.Close() }
}

# ------------------------------------------------------------------
# Firmware / Arduino
# ------------------------------------------------------------------
function Get-NexusFirmware {
  <#
  .SYNOPSIS
    Pasta, FQBN e linhas a preservar de cada firmware.
  .DESCRIPTION
    hidraulica, eletrica, seguranca, nobreak -> esp32s3_<nome>, tela ESP32-S3-Touch-LCD-4.3B.
    painel -> nexus_painel, com -Placa p4 (ESP32-P4 10,1" do corredor) ou s3-7 (ESP32-S3 7" dos cômodos).
  #>
  param(
    [Parameter(Mandatory = $true)][ValidateSet('hidraulica', 'eletrica', 'seguranca', 'nobreak', 'painel')][string]$Firmware,
    [AllowEmptyString()][string]$Placa = ''
  )
  if ($Firmware -eq 'painel') {
    if ($Placa -eq 'p4') {
      return [pscustomobject]@{ Firmware = $Firmware; Nome = 'nexus_painel'; Placa = 'p4'; Fqbn = $script:NexusFqbnP4
        Descricao = 'ESP32-P4-NANO + tela 10,1" (corredor)'; Preservar = @($script:NexusSegredos + $script:NexusLinhasPainel) }
    }
    if ($Placa -eq 's3-7') {
      return [pscustomobject]@{ Firmware = $Firmware; Nome = 'nexus_painel'; Placa = 's3-7'; Fqbn = $script:NexusFqbnS3
        Descricao = 'ESP32-S3-Touch-LCD-7 (cômodo)'; Preservar = @($script:NexusSegredos + $script:NexusLinhasPainel) }
    }
    throw 'o firmware "painel" precisa de -Placa p4 (corredor, ESP32-P4 10,1") ou -Placa s3-7 (cômodos, ESP32-S3 7").'
  }
  if ($Placa) { Write-NexusAviso "  -Placa $Placa ignorado: o firmware $Firmware é sempre da tela ESP32-S3-Touch-LCD-4.3B." }
  return [pscustomobject]@{ Firmware = $Firmware; Nome = "esp32s3_$Firmware"; Placa = 's3-43b'; Fqbn = $script:NexusFqbnS3
    Descricao = 'ESP32-S3-Touch-LCD-4.3B (16 MB, PSRAM OPI)'; Preservar = @($script:NexusSegredos) }
}

function Copy-NexusFirmware {
  <#
  .SYNOPSIS
    Copia o firmware do repositório para a pasta de trabalho mantendo as linhas que você preencheu.
  .DESCRIPTION
    As linhas "#define NOME ..." listadas em -Preservar (Wi-Fi, chave e, no painel, PAINEL_MODO/COMODO/PLACA)
    são lidas da cópia antiga e repostas na nova. A cópia antiga do .ino fica em <nome>.ino.bak.
    Devolve só os NOMES preservados (nunca os valores).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Origem,
    [Parameter(Mandatory = $true)][string]$Destino,
    [Parameter(Mandatory = $true)][string]$Nome,
    [string[]]$Preservar = @()
  )
  if (-not (Test-Path -LiteralPath (Join-Path $Origem "$Nome.ino"))) {
    throw "não achei $Nome.ino em $Origem. Atualize o repositório (git pull) — esse firmware pode ainda não existir nesta versão."
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $ino = Join-Path $Destino "$Nome.ino"
  $guardadas = @{}
  $backup = $null
  if (Test-Path -LiteralPath $ino) {
    foreach ($linha in [System.IO.File]::ReadAllLines($ino, $utf8)) {
      if ($linha -match '^\s*#define\s+(\w+)\b') {
        $n = $Matches[1]
        if ($Preservar -contains $n -and -not $guardadas.ContainsKey($n)) { $guardadas[$n] = $linha }
      }
    }
    $backup = "$ino.bak"
    Copy-Item -LiteralPath $ino -Destination $backup -Force
  }
  New-Item -ItemType Directory -Force -Path $Destino | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $Origem -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $Destino -Recurse -Force
  }
  if ($guardadas.Count -gt 0) {
    $novo = foreach ($linha in [System.IO.File]::ReadAllLines($ino, $utf8)) {
      if ($linha -match '^\s*#define\s+(\w+)\b' -and $guardadas.ContainsKey($Matches[1])) { $guardadas[$Matches[1]] } else { $linha }
    }
    [System.IO.File]::WriteAllLines($ino, [string[]]@($novo), $utf8)
  }
  return [pscustomobject]@{ Ino = $ino; Backup = $backup; Preservadas = @($guardadas.Keys | Sort-Object) }
}

function Get-NexusPendencias {
  <# Nomes das linhas de Wi-Fi/chave que ainda estão com o valor de exemplo (nunca devolve os valores). #>
  param([Parameter(Mandatory = $true)][string]$Ino)
  $faltam = @()
  if (-not (Test-Path -LiteralPath $Ino)) { return $faltam }
  foreach ($linha in [System.IO.File]::ReadAllLines($Ino, (New-Object System.Text.UTF8Encoding $false))) {
    if ($linha -match '^\s*#define\s+(WIFI_SSID|WIFI_PASSWORD|DEVICE_SECRET)\s+"([^"]*)"') {
      if ($Matches[2] -eq '' -or $Matches[2] -like 'SUA_*' -or $Matches[2] -like 'COLE_AQUI*') { $faltam += $Matches[1] }
    }
  }
  return $faltam
}

function Get-NexusLinhaDefine {
  <# Valor de um #define (para conferir PAINEL_PLACA etc.; não use com segredos). #>
  param([Parameter(Mandatory = $true)][string]$Ino, [Parameter(Mandatory = $true)][string]$Nome)
  if (-not (Test-Path -LiteralPath $Ino)) { return $null }
  foreach ($linha in [System.IO.File]::ReadAllLines($Ino, (New-Object System.Text.UTF8Encoding $false))) {
    if ($linha -match ('^\s*#define\s+' + [regex]::Escape($Nome) + '\s+(.*?)\s*(//.*)?$')) { return $Matches[1] }
  }
  return $null
}

function Find-ArduinoCli {
  <# Caminho do arduino-cli: PATH, instalação do winget, Arduino CLI em Arquivos de Programas ou o da Arduino IDE 2. #>
  $c = Get-Command arduino-cli -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Path }
  if (-not (Test-NexusWindows)) { return $null }
  $candidatos = @()
  if ($env:LOCALAPPDATA) {
    $candidatos += Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\arduino-cli.exe'
    $pacotes = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $pacotes) {
      $candidatos += @(Get-ChildItem -LiteralPath $pacotes -Directory -Filter 'ArduinoSA.CLI*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Filter 'arduino-cli.exe' -ErrorAction SilentlyContinue } |
        ForEach-Object { $_.FullName })
    }
    $candidatos += Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
  }
  foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($pf) {
      $candidatos += Join-Path $pf 'Arduino CLI\arduino-cli.exe'
      $candidatos += Join-Path $pf 'Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
    }
  }
  foreach ($p in $candidatos) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
  return $null
}

function Get-ArduinoTamanho {
  <# Lê "Sketch uses ... / Global variables use ..." da saída do arduino-cli compile. #>
  param([AllowEmptyString()][string]$Texto)
  $r = [ordered]@{ FlashBytes = $null; FlashPct = $null; FlashMax = $null; RamBytes = $null; RamPct = $null; RamMax = $null }
  if ($Texto -match 'Sketch uses (\d+) bytes \((\d+)%\) of program storage space\. Maximum is (\d+) bytes') {
    $r.FlashBytes = [long]$Matches[1]; $r.FlashPct = [int]$Matches[2]; $r.FlashMax = [long]$Matches[3]
  }
  if ($Texto -match 'Global variables use (\d+) bytes \((\d+)%\) of dynamic memory.*?Maximum is (\d+) bytes') {
    $r.RamBytes = [long]$Matches[1]; $r.RamPct = [int]$Matches[2]; $r.RamMax = [long]$Matches[3]
  }
  if ($null -eq $r.FlashBytes -and $null -eq $r.RamBytes) { return $null }
  return [pscustomobject]$r
}

function Format-NexusBytes {
  param([long]$Bytes)
  if ($Bytes -ge 1MB) { return "$(Format-NexusNumero ($Bytes / 1MB) '0.00') MB" }
  if ($Bytes -ge 1KB) { return "$(Format-NexusNumero ($Bytes / 1KB) '0.0') KB" }
  return "$Bytes bytes"
}

# ------------------------------------------------------------------
# Portas seriais
# ------------------------------------------------------------------
function Get-NexusPortaDica {
  <# Palpite do que está ligado na porta, pela descrição do Windows. #>
  param([AllowEmptyString()][string]$Descricao)
  if ($Descricao -match 'USB JTAG|JTAG/serial|Espressif|ESP32') { return 'provável ESP32 (USB nativo)' }
  if ($Descricao -match 'CH34[0-9]|CP210|FT232|FTDI|PL2303|USB-SERIAL|USB Serial|RS-?485') { return 'conversor USB-serial (adaptador RS-485 ou placa com CH343)' }
  if ($Descricao -match 'Bluetooth') { return 'Bluetooth (não é a placa)' }
  return ''
}

function Get-NexusPortas {
  <# Lista portas: Windows via CIM (com descrição); Linux /dev/ttyUSB* e /dev/ttyACM*. #>
  $lista = @()
  if (Test-NexusWindows) {
    $vistos = @{}
    try {
      $dev = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%(COM%'" -ErrorAction Stop)
      foreach ($d in $dev) {
        if ("$($d.Name)" -match '\((COM\d+)\)') {
          $porta = $Matches[1]; $vistos[$porta] = $true
          $lista += [pscustomobject]@{ Porta = $porta; Descricao = "$($d.Name)"; Dica = (Get-NexusPortaDica "$($d.Name)") }
        }
      }
    } catch { }
    foreach ($p in [System.IO.Ports.SerialPort]::GetPortNames()) {
      if (-not $vistos.ContainsKey($p)) { $lista += [pscustomobject]@{ Porta = $p; Descricao = ''; Dica = '' } }
    }
  } else {
    foreach ($padrao in @('/dev/ttyUSB*', '/dev/ttyACM*')) {
      foreach ($f in @(Get-Item -Path $padrao -ErrorAction SilentlyContinue)) {
        $desc = ''
        $prod = "/sys/class/tty/$($f.Name)/device/../product"
        if (Test-Path -LiteralPath $prod) { try { $desc = (Get-Content -LiteralPath $prod -TotalCount 1) } catch { } }
        $lista += [pscustomobject]@{ Porta = $f.FullName; Descricao = $desc; Dica = (Get-NexusPortaDica $desc) }
      }
    }
  }
  return $lista | Sort-Object { [regex]::Replace($_.Porta, '\d+', { param($m) $m.Value.PadLeft(4, '0') }) }
}

# ------------------------------------------------------------------
# HTTP (iot-gateway) e resumo do /panel
# ------------------------------------------------------------------
function Invoke-NexusHttp {
  <#
    GET/POST com o corpo lido como UTF-8 (o Windows PowerShell 5.1 erra os acentos sem isso).
    Devolve @{ Status; Texto; Json }. Status 0 = sem resposta (rede/DNS).
  #>
  param(
    [ValidateSet('GET', 'POST')][string]$Metodo = 'GET',
    [Parameter(Mandatory = $true)][string]$Url,
    [AllowNull()][string]$Chave = $null,
    [AllowNull()][string]$CorpoJson = $null,
    [int]$TimeoutSec = 20
  )
  try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  } catch { }
  $cab = @{}
  if ($Chave) { $cab['x-device-key'] = $Chave }
  $args1 = @{ Uri = $Url; Method = $Metodo; Headers = $cab; UseBasicParsing = $true; TimeoutSec = $TimeoutSec; ErrorAction = 'Stop' }
  if ($null -ne $CorpoJson) {
    $args1['Body'] = [System.Text.Encoding]::UTF8.GetBytes($CorpoJson)
    $args1['ContentType'] = 'application/json; charset=utf-8'
  }
  $status = 0; $texto = ''
  try {
    $resp = Invoke-WebRequest @args1
    $status = [int]$resp.StatusCode
    $texto = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
  } catch {
    $ex = $_.Exception
    $r = $null
    if ($ex.PSObject.Properties['Response']) { $r = $ex.Response }
    if ($null -ne $r) {
      try { $status = [int]$r.StatusCode } catch { $status = -1 }
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $texto = $_.ErrorDetails.Message }
    } else {
      $status = 0
      $texto = $ex.Message
    }
  }
  $json = $null
  if ($texto -and $texto.TrimStart().StartsWith('{')) { try { $json = $texto | ConvertFrom-Json } catch { $json = $null } }
  return [pscustomobject]@{ Status = $status; Texto = $texto; Json = $json }
}

function ConvertTo-NexusValor {
  <# "true"/"false" -> booleano, número -> número, resto -> texto (para o corpo do /panel/command). #>
  param([AllowEmptyString()][string]$Texto)
  if ($Texto -match '^(?i:true|sim|ligar|on)$') { return $true }
  if ($Texto -match '^(?i:false|nao|não|desligar|off)$') { return $false }
  $n = 0.0
  if ([double]::TryParse(($Texto -replace ',', '.'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n)) {
    if ($n -eq [math]::Floor($n)) { return [int]$n }
    return $n
  }
  return $Texto
}

function Format-NexusPainel {
  <# Resumo legível do JSON do GET /iot-gateway/panel (energia, água, bateria, alertas, aparelhos). #>
  param([Parameter(Mandatory = $true)]$Snapshot)
  $g = { param($o, $n) Get-NexusPropriedade -Objeto $o -Nome $n }
  $casa = & $g $Snapshot 'house'
  $linhas = New-Object System.Collections.Generic.List[string]
  $saude = "$(& $g $casa 'health')"
  $saudeTxt = switch ($saude) { 'safe' { 'normal' } 'warning' { 'ATENÇÃO' } 'critical' { 'CRÍTICO' } default { $saude } }
  $linhas.Add("Casa (atualizado em $(& $g $Snapshot 't'))")
  $linhas.Add("  Saúde ......... $saudeTxt")
  $w = & $g $casa 'watts'
  if ($null -ne $w) { $linhas.Add("  Energia ....... $(Format-NexusNumero ([double]$w) '#,##0') W") }
  $agua = & $g $casa 'water_lph'
  if ($null -ne $agua) { $linhas.Add("  Água .......... $(Format-NexusNumero ([double]$agua) '#,##0') L/h") }
  $nivel = & $g $casa 'level_pct'
  if ($null -ne $nivel) { $linhas.Add("  Reservatório .. $nivel %") } else { $linhas.Add('  Reservatório .. (sem sonda)') }
  $soc = & $g $casa 'soc'
  if ($null -ne $soc) {
    $rede = & $g $casa 'grid_ok'
    $redeTxt = 'rede ok'; if ($rede -eq $false) { $redeTxt = 'SEM REDE — casa no inversor' }
    $linhas.Add("  Bateria ....... $soc % ($redeTxt)")
  } else { $linhas.Add('  Bateria ....... (sem nobreak)') }
  $linhas.Add("  Alertas ....... $(& $g $casa 'alerts_open') abertos")
  $comodos = @(& $g $Snapshot 'rooms')
  if ($comodos.Count -gt 0 -and $null -ne $comodos[0]) { $linhas.Add("Cômodos: $($comodos -join ', ')") }
  $alertas = @(& $g $Snapshot 'alerts') | Where-Object { $null -ne $_ }
  if (@($alertas).Count -gt 0) {
    $linhas.Add('Alertas recentes:')
    foreach ($a in $alertas) { $linhas.Add("  [$(& $g $a 'sev')] $(& $g $a 'msg')") }
  }
  $aps = @(& $g $Snapshot 'devices') | Where-Object { $null -ne $_ }
  $linhas.Add("Aparelhos ($(@($aps).Count)):")
  foreach ($d in $aps) {
    $partes = @()
    $on = & $g $d 'on';     if ($null -ne $on)   { if ($on) { $partes += 'ligado' } else { $partes += 'desligado' } }
    $op = & $g $d 'open';   if ($null -ne $op)   { if ($op) { $partes += 'aberto' } else { $partes += 'fechado' } }
    $wd = & $g $d 'w';      if ($null -ne $wd)   { $partes += "$wd W" }
    $bri = & $g $d 'bri';   if ($null -ne $bri)  { $partes += "brilho $bri %" }
    $tp = & $g $d 'temp';   if ($null -ne $tp)   { $partes += "$(Format-NexusNumero ([double]$tp) '0.0') °C" }
    $lv = & $g $d 'lvl';    if ($null -ne $lv)   { $partes += "nível $lv %" }
    $sc = & $g $d 'soc';    if ($null -ne $sc)   { $partes += "bateria $sc %" }
    $ar = & $g $d 'arm';    if ($null -ne $ar)   { $partes += "alarme: $ar" }
    if ((& $g $d 'alarm') -eq $true) { $partes += 'ALARME' }
    if ((& $g $d 'ok') -eq $false) { $partes += 'offline' }
    $acoes = @(& $g $d 'act') | Where-Object { $_ }
    $acTxt = ''; if (@($acoes).Count -gt 0) { $acTxt = "  [ações: $($acoes -join ', ')]" }
    $linhas.Add("  - $(& $g $d 'n') ($(& $g $d 'r'), $(& $g $d 't')): $($partes -join ', ')$acTxt")
    $linhas.Add("      id $(& $g $d 'id')")
  }
  return $linhas.ToArray()
}

# ------------------------------------------------------------------
# Quiosque
# ------------------------------------------------------------------
function Get-PosicaoMonitor {
  <#
    Canto superior esquerdo do monitor N (1 = principal; 2, 3... = os outros, da esquerda para a direita).
    -Telas: objetos com Primary e Bounds (X, Y, Width, Height), como [System.Windows.Forms.Screen]::AllScreens.
  #>
  param([Parameter(Mandatory = $true)][object[]]$Telas, [Parameter(Mandatory = $true)][int]$Monitor)
  $prim = @($Telas | Where-Object { $_.Primary })
  $outras = @($Telas | Where-Object { -not $_.Primary } | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y })
  $ordem = @($prim + $outras)
  if ($Monitor -lt 1 -or $Monitor -gt $ordem.Count) { return $null }
  $b = $ordem[$Monitor - 1].Bounds
  return [pscustomobject]@{ X = [int]$b.X; Y = [int]$b.Y; Largura = [int]$b.Width; Altura = [int]$b.Height }
}

function Get-QuiosqueArgumentos {
  <# Linha de argumentos do Edge/Chrome em modo quiosque. #>
  param(
    [Parameter(Mandatory = $true)][ValidateSet('edge', 'chrome')][string]$Navegador,
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Perfil = '',
    $Posicao = $null
  )
  $a = @("--kiosk `"$Url`"")
  if ($Navegador -eq 'edge') { $a += '--edge-kiosk-type=fullscreen' }
  $a += '--no-first-run'
  if ($Navegador -eq 'chrome') { $a += '--no-default-browser-check' }
  # perfil separado: abre uma instância própria mesmo com o navegador já aberto (senão o --kiosk é ignorado)
  if ($Perfil) { $a += "--user-data-dir=`"$Perfil`"" }
  if ($null -ne $Posicao) { $a += "--window-position=$($Posicao.X),$($Posicao.Y)" }
  return ($a -join ' ')
}

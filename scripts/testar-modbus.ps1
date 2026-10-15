<#
.SYNOPSIS
  Lê registradores Modbus pelo gateway Waveshare (Modbus TCP) ou pelo adaptador USB-RS485 (RTU), para diagnóstico.

.DESCRIPTION
  Pelo gateway (-Ip): antes, DESLIGUE a tela do barramento (ela é o mestre e não pode haver dois — §5.4).
  Por padrão fala Modbus TCP (cabeçalho MBAP, porta 502). Gateway em modo transparente: -Transparente.
  Pelo adaptador (-Porta): RTU com CRC, 9600 baud, 8N1 (barramento D do nobreak: -Formato 8N2).

  -Pzem interpreta a resposta como PZEM-016 (V, A, W, Wh, Hz, FP); -Pzem017 como PZEM-017 (CC).
  Sem resposta / exceção 0x0B do gateway = o escravo não respondeu (endereço, A/B, alimentação, terminação).
  Código de saída: 0 leu; 1 falhou.

.PARAMETER Ip
  IP do gateway Waveshare RS485 TO WIFI/ETH (no projeto: 192.168.1.200).

.PARAMETER Porta
  Porta do adaptador USB-RS485 (COM3; no Linux /dev/ttyUSB0).

.PARAMETER Slave
  Endereço do aparelho (1 a 247; tabela no §5.2).

.PARAMETER Funcao
  3 (holding) ou 4 (entrada). Padrão 4.

.PARAMETER Registro
  Primeiro registrador (aceita 0x0101). Padrão 0.

.PARAMETER Quantidade
  Quantos registradores (1 a 125). Padrão 10.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\testar-modbus.ps1 -Ip 192.168.1.200 -Slave 7 -Pzem

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\testar-modbus.ps1 -Porta COM3 -Slave 41 -Pzem017 -Formato 8N2

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\testar-modbus.ps1 -Porta COM3 -Slave 80 -Funcao 4 -Registro 1 -Quantidade 2
  XY-MD02: temperatura e umidade (x 0,1).
#>
[CmdletBinding(DefaultParameterSetName = 'Tcp')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Tcp')][ValidatePattern('^[A-Za-z0-9.\-]+$')][string]$Ip,
  [Parameter(ParameterSetName = 'Tcp')][ValidateRange(1, 65535)][int]$TcpPorta = 502,
  [Parameter(ParameterSetName = 'Tcp')][switch]$Transparente,
  [Parameter(Mandatory = $true, ParameterSetName = 'Serial')][ValidatePattern('^(COM\d{1,3}|/dev/\S+)$')][string]$Porta,
  [Parameter(ParameterSetName = 'Serial')][ValidateSet(2400, 4800, 9600, 19200, 38400, 57600, 115200)][int]$Baud = 9600,
  [Parameter(ParameterSetName = 'Serial')][ValidateSet('8N1', '8N2')][string]$Formato = '8N1',
  [ValidateRange(1, 247)][int]$Slave = 1,
  [ValidateSet(3, 4)][int]$Funcao = 4,
  [ValidateRange(0, 65535)][int]$Registro = 0,
  [ValidateRange(1, 125)][int]$Quantidade = 10,
  [switch]$Pzem,
  [switch]$Pzem017,
  [ValidateRange(100, 30000)][int]$TimeoutMs = 2000
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

try {
  if ($Pzem -and $Pzem017) { throw 'use -Pzem OU -Pzem017.' }
  if ($Pzem -or $Pzem017) {
    $q = 10; if ($Pzem017) { $q = 8 }
    if ($Funcao -ne 4 -or $Registro -ne 0 -or ($PSBoundParameters.ContainsKey('Quantidade') -and $Quantidade -ne $q)) { Write-Host "(PZEM: lendo $q registradores de entrada, função 04, a partir do 0)" }
    $Funcao = 4; $Registro = 0; $Quantidade = $q
  }

  $pdu = New-ModbusPdu -Funcao $Funcao -Registro $Registro -Valor $Quantidade
  $via = ''
  $relogio = [System.Diagnostics.Stopwatch]::StartNew()
  if ($PSCmdlet.ParameterSetName -eq 'Tcp') {
    if ($Transparente) {
      $pedido = New-ModbusFrame -Slave $Slave -Funcao $Funcao -Registro $Registro -Valor $Quantidade
      $via = "${Ip}:$TcpPorta (RTU dentro do TCP, modo transparente)"
    } else {
      $tid = Get-Random -Minimum 1 -Maximum 65535
      $pedido = New-ModbusTcpFrame -Transacao $tid -Unidade $Slave -Pdu $pdu
      $via = "${Ip}:$TcpPorta (Modbus TCP)"
    }
    Write-Host ("Lendo {0} registrador(es) (função 0x{1:X2}, a partir de {2} / 0x{2:X4}) do escravo {3} via {4}..." -f $Quantidade, $Funcao, $Registro, $Slave, $via)
    Write-Verbose "pedido: $(Format-NexusHex $pedido)"
    $resp = Invoke-ModbusTcp -Ip $Ip -Porta $TcpPorta -Pedido $pedido -TimeoutMs $TimeoutMs -Transparente:$Transparente
    if ($Transparente) { $res = Test-ModbusResponse -Pedido $pedido -Resposta $resp }
    else { $res = Test-ModbusTcpResponse -Pedido $pedido -Resposta $resp }
  } else {
    $pedido = New-ModbusFrame -Slave $Slave -Funcao $Funcao -Registro $Registro -Valor $Quantidade
    $via = "$Porta ($Baud baud $Formato)"
    Write-Host ("Lendo {0} registrador(es) (função 0x{1:X2}, a partir de {2} / 0x{2:X4}) do escravo {3} via {4}..." -f $Quantidade, $Funcao, $Registro, $Slave, $via)
    Write-Verbose "pedido: $(Format-NexusHex $pedido)"
    $sp = Open-NexusSerial -Porta $Porta -Baud $Baud -Formato $Formato -TimeoutMs $TimeoutMs
    try { $resp = Invoke-ModbusRtu -Serial $sp -Pedido $pedido -TimeoutMs $TimeoutMs } finally { $sp.Close() }
    $res = Test-ModbusResponse -Pedido $pedido -Resposta $resp
  }
  $ms = $relogio.ElapsedMilliseconds
  Write-Verbose "resposta: $(Format-NexusHex $resp)"

  if (-not $res.Ok) {
    if ($resp.Length -eq 0) {
      throw "o escravo $Slave não respondeu em $TimeoutMs ms. Confira o endereço (§5.2), A/B (troque se preciso), a alimentação do aparelho, o formato (8N1/8N2) e a terminação."
    }
    if ($res.Excecao) { throw "escravo ${Slave}: $($res.Mensagem)" }
    throw "resposta inválida do escravo ${Slave}: $($res.Mensagem)"
  }

  Write-NexusOk "Resposta em $ms ms:"
  for ($i = 0; $i -lt @($res.Registros).Count; $i++) {
    $v = [int]$res.Registros[$i]
    $assinado = $v; if ($v -ge 32768) { $assinado = $v - 65536 }
    Write-Host ("  reg {0,5} (0x{0:X4}) = {1,5}  (0x{1:X4}, com sinal {2})" -f ($Registro + $i), $v, $assinado)
  }
  if ($Pzem) {
    Write-NexusPasso "PZEM-016 (escravo $Slave):"
    Format-Pzem016 -Leitura (ConvertFrom-Pzem016 -Registros $res.Registros) | ForEach-Object { Write-Host $_ }
  } elseif ($Pzem017) {
    Write-NexusPasso "PZEM-017 (escravo $Slave):"
    Format-Pzem017 -Leitura (ConvertFrom-Pzem017 -Registros $res.Registros) | ForEach-Object { Write-Host $_ }
  }
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}

<#
.SYNOPSIS
  Testes dos scripts PowerShell do NexusHome (sem Pester): sintaxe, compatibilidade com o 5.1, Modbus, firmware, painel e integração.

.DESCRIPTION
  1. Sintaxe de todos os .ps1 (Parser do PowerShell), BOM UTF-8 (acentos no Windows PowerShell 5.1),
     nada exclusivo do PowerShell 7 (??, ?:, &&/||, ?., -AsHashtable, $IsWindows), cabeçalho de ajuda.
  2. Funções puras de scripts\nexus-comum.ps1: CRC16 com vetores conhecidos, quadros RTU, MBAP, conferência de
     respostas, PZEM-016/017, FQBN, cópia do firmware preservando linhas, tamanho do arduino-cli, quiosque, /panel.
  3. Integração: roda os scripts de verdade (processo novo) contra servidores falsos em Python
     (gateway Modbus TCP, iot-gateway HTTP, porta serial pty com ESP32/PZEM/Waveshare/XY-MD02 falsos).
     Os falsos ficam FORA do repositório: informe a pasta com -Falsos (ou NEXUS_TESTE_FALSOS).
     Sem a pasta, sem python3 ou no Windows (pty/arduino-cli falso), esses testes são pulados.
  Código de saída: 0 se nenhum teste falhou.

.PARAMETER Falsos
  Pasta com falso_modbus_tcp.py, falso_http.py, falso_serial.py e modbus_comum.py.

.EXAMPLE
  pwsh -NoProfile -File scripts/testes/rodar-testes.ps1 -Falsos /caminho/dos/falsos
#>
[CmdletBinding()]
param(
  [string]$Falsos = $env:NEXUS_TESTE_FALSOS,
  [string]$Python = 'python3'
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$pastaScripts = Split-Path -Parent $PSScriptRoot
. (Join-Path $pastaScripts 'nexus-comum.ps1')

$script:Passou = 0; $script:Falhou = 0; $script:Pulou = 0
$script:Falhas = New-Object System.Collections.Generic.List[string]

function Ok([bool]$Condicao, [string]$Nome, [string]$Detalhe = '') {
  if ($Condicao) { $script:Passou++; Write-Host "  ok    $Nome" -ForegroundColor Green }
  else {
    $script:Falhou++; $script:Falhas.Add($Nome)
    Write-Host "  FALHA $Nome" -ForegroundColor Red
    if ($Detalhe) { Write-Host ("        " + ($Detalhe -replace "`n", "`n        ")) -ForegroundColor DarkYellow }
  }
}
function Igual($Esperado, $Obtido, [string]$Nome) { Ok ("$Esperado" -eq "$Obtido") $Nome "esperado: [$Esperado]`nobtido:   [$Obtido]" }
function Pula([string]$Nome, [string]$Motivo) { $script:Pulou++; Write-Host "  pulou $Nome ($Motivo)" -ForegroundColor DarkGray }
function Caso([string]$Nome, [scriptblock]$Bloco) {
  try { & $Bloco } catch { Ok $false $Nome "exceção: $($_.Exception.Message)`n$($_.ScriptStackTrace)" }
}
function Secao([string]$t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Hex($b) { return (Format-NexusHex $b) }

$pwsh = (Get-Process -Id $PID).Path
$ehWindows = Test-NexusWindows
$tmpBase = Join-Path ([System.IO.Path]::GetTempPath()) ("nexus-testes-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmpBase | Out-Null

function Rodar([string]$Script, [string[]]$Argumentos = @(), [hashtable]$Ambiente = @{}, [int]$TimeoutSeg = 60) {
  $antes = @{}
  foreach ($k in $Ambiente.Keys) { $antes[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $Ambiente[$k]) }
  try {
    $caminho = Join-Path $pastaScripts $Script
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $saida = & $pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $caminho @Argumentos 2>&1 | ForEach-Object { "$_" }
    $codigo = $LASTEXITCODE
    $ErrorActionPreference = $eap
  } finally {
    foreach ($k in $Ambiente.Keys) { [Environment]::SetEnvironmentVariable($k, $antes[$k]) }
  }
  return [pscustomobject]@{ Codigo = $codigo; Saida = (@($saida) -join "`n") }
}
function SemStack([string]$Texto) {
  return -not ($Texto -match 'At .+:\d+ char:|CategoryInfo|FullyQualifiedErrorId|ScriptStackTrace|at <ScriptBlock>|Em .+:\d+ caractere:')
}

$todos = @(Get-ChildItem -LiteralPath $pastaScripts -Filter '*.ps1') + @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1')
$principais = @('instalar-arduino.ps1', 'gravar-firmware.ps1', 'monitor-serial.ps1', 'enderecar-modbus.ps1', 'testar-modbus.ps1',
                'quiosque-nexushome.ps1', 'publicar-funcoes.ps1', 'testar-painel.ps1')

# ==================================================================
Secao 'Sintaxe, codificação e compatibilidade com o Windows PowerShell 5.1'
foreach ($f in $todos) {
  Caso "sintaxe $($f.Name)" {
    $erros = $null; $tokens = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$erros)
    Ok (@($erros).Count -eq 0) "sintaxe $($f.Name)" ((@($erros) | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) -join "`n")
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    Ok ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "BOM UTF-8 $($f.Name) (acentos no 5.1)"
    $proibidos = @($ast.FindAll({ param($n)
        $t = $n.GetType().Name
        if ($t -eq 'TernaryExpressionAst' -or $t -eq 'PipelineChainAst') { return $true }
        if ($t -eq 'BinaryExpressionAst' -and "$($n.Operator)" -eq 'QuestionQuestion') { return $true }
        if ($t -eq 'AssignmentStatementAst' -and "$($n.Operator)" -eq 'QuestionQuestionEquals') { return $true }
        if (($t -eq 'MemberExpressionAst' -or $t -eq 'InvokeMemberExpressionAst') -and $n.PSObject.Properties['NullConditional'] -and $n.NullConditional) { return $true }
        if ($t -eq 'VariableExpressionAst' -and @('IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR') -contains $n.VariablePath.UserPath) { return $true }
        if ($t -eq 'VariableExpressionAst' -and "$($n.VariablePath.UserPath)".EndsWith('?')) { return $true }   # "$Porta?" vira a variável Porta?
        if ($t -eq 'CommandParameterAst' -and @('AsHashtable', 'Parallel', 'SkipHttpErrorCheck') -contains $n.ParameterName) { return $true }
        return $false }, $true))
    Ok ($proibidos.Count -eq 0) "só sintaxe do 5.1 em $($f.Name)" (($proibidos | ForEach-Object { "linha $($_.Extent.StartLineNumber): $($_.Extent.Text)" }) -join "`n")
  }
}
foreach ($n in $principais) {
  Caso "cabeçalho $n" {
    $txt = [System.IO.File]::ReadAllText((Join-Path $pastaScripts $n))
    Ok ($txt -match '\.SYNOPSIS' -and $txt -match '\.DESCRIPTION' -and $txt -match '\.EXAMPLE') "ajuda .SYNOPSIS/.DESCRIPTION/.EXAMPLE em $n"
    Ok ($txt -match 'Set-StrictMode -Version 2') "Set-StrictMode -Version 2 em $n"
    Ok ($txt -match '\bexit 1\b' -and $txt -match '\bexit 0\b') "códigos de saída 0/1 em $n"
    $h = Get-Help (Join-Path $pastaScripts $n)
    Ok ("$($h.Synopsis)".Length -gt 10 -and "$($h.Synopsis)" -notmatch '^\s*\S+\.ps1 ') "Get-Help mostra a sinopse de $n" "$($h.Synopsis)"
  }
}

# ==================================================================
Secao 'Modbus: CRC16, quadros RTU e MBAP'
Caso 'crc' {
  Igual '70 0D' (Hex (Get-ModbusCrc -Bytes ([byte[]](0x01, 0x04, 0x00, 0x00, 0x00, 0x0A)))) 'CRC 01 04 00 00 00 0A = 70 0D'
  Igual '7D A1' (Hex (Get-ModbusCrc -Bytes ([byte[]](0xF8, 0x06, 0x00, 0x02, 0x00, 0x07)))) 'CRC F8 06 00 02 00 07 = 7D A1 (PZEM -> endereço 7)'
  Igual '5C 1B' (Hex (Get-ModbusCrc -Bytes ([byte[]](0x00, 0x06, 0x40, 0x00, 0x00, 0x01)))) 'CRC 00 06 40 00 00 01 = 5C 1B (Waveshare, manual)'
  Igual '90 1B' (Hex (Get-ModbusCrc -Bytes ([byte[]](0x00, 0x03, 0x40, 0x00, 0x00, 0x01)))) 'CRC 00 03 40 00 00 01 = 90 1B (Waveshare, manual)'
  Igual 'D9 CA' (Hex (Get-ModbusCrc -Bytes ([byte[]](0x01, 0x06, 0x01, 0x01, 0x00, 0x50)))) 'CRC 01 06 01 01 00 50 = D9 CA (XY-MD02 -> 80)'
}
Caso 'quadros' {
  Igual '01 04 00 00 00 0A 70 0D' (Hex (New-ModbusFrame -Slave 1 -Funcao 4 -Registro 0 -Valor 10)) 'New-ModbusFrame leitura PZEM'
  Igual 'F8 06 00 02 00 07 7D A1' (Hex (New-ModbusFrame -Slave 0xF8 -Funcao 6 -Registro 2 -Valor 7)) 'New-ModbusFrame PZEM geral -> 7'
  Igual '00 06 40 00 00 05' ((Hex (New-ModbusFrame -Slave 0 -Funcao 6 -Registro 0x4000 -Valor 5)).Substring(0, 17)) 'New-ModbusFrame Waveshare broadcast -> 5'
  Igual '07 03 00 02 00 01 25 AC' (Hex (New-ModbusFrame -Slave 7 -Funcao 3 -Registro 2 -Valor 1)) 'New-ModbusFrame ler endereço do PZEM 7'
  $f = New-ModbusFrame -Slave 1 -Funcao 4
  Ok ($f -is [byte[]] -and $f.Length -eq 8) 'New-ModbusFrame devolve byte[] de 8'
}
Caso 'mbap' {
  $pdu = New-ModbusPdu -Funcao 4 -Registro 0 -Valor 10
  Igual '04 00 00 00 0A' (Hex $pdu) 'New-ModbusPdu'
  $tcp = New-ModbusTcpFrame -Transacao 0x1234 -Unidade 7 -Pdu $pdu
  Igual '12 34 00 00 00 06 07 04 00 00 00 0A' (Hex $tcp) 'MBAP: transação, protocolo 0, comprimento 6, unidade 7'
  $exc = ConvertFrom-NexusHex '12 34 00 00 00 03 07 84 0B'
  $r = Test-ModbusTcpResponse -Pedido $tcp -Resposta $exc
  Ok ((-not $r.Ok) -and $r.Excecao -and $r.Codigo -eq 11 -and $r.Mensagem -match '0x0B') 'MBAP: exceção 0x0B do gateway reconhecida' $r.Mensagem
  $boa = ConvertFrom-NexusHex '12 34 00 00 00 07 07 04 04 08 98 00 01'
  $pdu2 = New-ModbusPdu -Funcao 4 -Registro 0 -Valor 2
  $tcp2 = New-ModbusTcpFrame -Transacao 0x1234 -Unidade 7 -Pdu $pdu2
  $r2 = Test-ModbusTcpResponse -Pedido $tcp2 -Resposta $boa
  Ok ($r2.Ok -and $r2.Registros[0] -eq 2200 -and $r2.Registros[1] -eq 1) 'MBAP: resposta com 2 registradores' $r2.Mensagem
  $r3 = Test-ModbusTcpResponse -Pedido $tcp2 -Resposta (ConvertFrom-NexusHex '99 99 00 00 00 07 07 04 04 08 98 00 01')
  Ok (-not $r3.Ok -and $r3.Mensagem -match 'transação') 'MBAP: transação trocada é recusada'
  $r4 = Test-ModbusTcpResponse -Pedido $tcp2 -Resposta (ConvertFrom-NexusHex '12 34 00 00 00 09 07 04 04 08 98 00 01')
  Ok (-not $r4.Ok -and $r4.Mensagem -match 'comprimento') 'MBAP: comprimento errado é recusado'
}
Caso 'respostas rtu' {
  $ped = New-ModbusFrame -Slave 1 -Funcao 4 -Registro 0 -Valor 10
  $regs = @(2200, (70000 -band 0xFFFF), (70000 -shr 16), (154000 -band 0xFFFF), (154000 -shr 16), (123456 -band 0xFFFF), (123456 -shr 16), 600, 100, 0)
  $corpo = New-Object System.Collections.Generic.List[byte]
  $corpo.AddRange([byte[]](1, 4, 20))
  foreach ($v in $regs) { $corpo.Add([byte]($v -shr 8)); $corpo.Add([byte]($v -band 0xFF)) }
  $sem = $corpo.ToArray()
  $resp = [byte[]]($sem + (Get-ModbusCrc -Bytes $sem))
  $r = Test-ModbusResponse -Pedido $ped -Resposta $resp
  Ok ($r.Ok -and @($r.Registros).Count -eq 10) 'Test-ModbusResponse: PZEM 10 registradores' $r.Mensagem
  $p = ConvertFrom-Pzem016 -Registros $r.Registros
  Igual '220' $p.TensaoV 'PZEM-016: 2200 = 220,0 V'
  Igual '70' $p.CorrenteA 'PZEM-016: corrente 32 bits palavra baixa primeiro (70,000 A)'
  Igual '15400' $p.PotenciaW 'PZEM-016: potência 32 bits (15400,0 W)'
  Igual '123456' $p.EnergiaWh 'PZEM-016: energia 32 bits (123456 Wh)'
  Igual '60' $p.FrequenciaHz 'PZEM-016: 60,0 Hz'
  Igual '1' $p.FatorPotencia 'PZEM-016: FP 1,00'
  Ok (-not $p.Alarme) 'PZEM-016: sem alarme'
  $txt = (Format-Pzem016 -Leitura $p) -join "`n"
  Ok ($txt -match '220,0 V' -and $txt -match '70,000 A' -and $txt -match '123\.456 Wh') 'PZEM-016: texto em pt-BR (220,0 V)' $txt
  $p17 = ConvertFrom-Pzem017 -Registros @(2640, 1250, 3300, 0, 4464, 1, 0, 0xFFFF)
  Ok ($p17.TensaoV -eq 26.4 -and $p17.CorrenteA -eq 12.5 -and $p17.PotenciaW -eq 330 -and $p17.EnergiaWh -eq 70000 -and $p17.AlarmeBaixa) 'PZEM-017: V/A/W/Wh/alarme'

  $ruim = [byte[]]$resp.Clone(); $ruim[5] = $ruim[5] -bxor 0xFF
  $r2 = Test-ModbusResponse -Pedido $ped -Resposta $ruim
  Ok (-not $r2.Ok -and $r2.Mensagem -match 'CRC') 'Test-ModbusResponse: CRC errado recusado'
  $outro = [byte[]](@([byte]2) + $sem[1..($sem.Length - 1)]); $outro = [byte[]]($outro + (Get-ModbusCrc -Bytes $outro))
  $r3 = Test-ModbusResponse -Pedido $ped -Resposta $outro
  Ok (-not $r3.Ok -and $r3.Mensagem -match 'escravo 2') 'Test-ModbusResponse: escravo diferente recusado'
  $exc = [byte[]](1, 0x84, 2); $exc = [byte[]]($exc + (Get-ModbusCrc -Bytes $exc))
  $r4 = Test-ModbusResponse -Pedido $ped -Resposta $exc
  Ok ($r4.Excecao -and $r4.Codigo -eq 2) 'Test-ModbusResponse: exceção 0x02'
  $g = New-ModbusFrame -Slave 0xF8 -Funcao 6 -Registro 2 -Valor 7
  $eco = [byte[]]$g.Clone(); $eco[0] = 1; $eco = [byte[]]($eco[0..5] + (Get-ModbusCrc -Bytes ([byte[]]$eco[0..5])))
  $r5 = Test-ModbusResponse -Pedido $g -Resposta $eco
  Ok ($r5.Ok -and $r5.Registros[0] -eq 7) 'Test-ModbusResponse: eco da função 06 pelo endereço geral' $r5.Mensagem
  Ok (-not (Test-ModbusResponse -Pedido $ped -Resposta ([byte[]]@())).Ok) 'Test-ModbusResponse: vazio = sem resposta'
  Igual 0 (Get-ModbusTamanhoEsperado -Pedido $ped -Parcial ([byte[]](1))) 'tamanho esperado: parcial curto'
  Igual 25 (Get-ModbusTamanhoEsperado -Pedido $ped -Parcial ([byte[]](1, 4, 20))) 'tamanho esperado: 03/04'
  Igual 5 (Get-ModbusTamanhoEsperado -Pedido $ped -Parcial ([byte[]](1, 0x84))) 'tamanho esperado: exceção'
  Igual 8 (Get-ModbusTamanhoEsperado -Pedido $g -Parcial ([byte[]](1, 6))) 'tamanho esperado: 06'
  Igual '0x0002 8N2 248' ('0x{0:X4} {1} {2}' -f (Get-NexusEnderecoInfo pzem017).Registro, (Get-NexusEnderecoInfo pzem017).Formato, (Get-NexusEnderecoInfo pzem017).Geral) 'endereçamento PZEM-017: reg 2, 8N2, geral 0xF8'
  Igual '0x4000 0' ('0x{0:X4} {1}' -f (Get-NexusEnderecoInfo waveshare).Registro, (Get-NexusEnderecoInfo waveshare).Geral) 'endereçamento Waveshare: reg 0x4000, broadcast 0'
  Igual '0x0101' ('0x{0:X4}' -f (Get-NexusEnderecoInfo xymd02).Registro) 'endereçamento XY-MD02: reg 0x0101'
}

# ==================================================================
Secao 'Firmware: FQBN, cópia preservando linhas, tamanho'
Caso 'fqbn' {
  $s3 = 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc'
  $p4 = 'esp32:esp32:esp32p4:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled'
  foreach ($f in 'hidraulica', 'eletrica', 'seguranca', 'nobreak') {
    $x = Get-NexusFirmware -Firmware $f
    Ok ($x.Fqbn -eq $s3 -and $x.Nome -eq "esp32s3_$f") "FQBN 4.3B e pasta de $f"
  }
  Igual $p4 (Get-NexusFirmware -Firmware painel -Placa p4).Fqbn 'FQBN painel P4'
  Igual $s3 (Get-NexusFirmware -Firmware painel -Placa s3-7).Fqbn 'FQBN painel S3 7"'
  Igual 'nexus_painel' (Get-NexusFirmware -Firmware painel -Placa p4).Nome 'pasta do painel = nexus_painel'
  Ok (@((Get-NexusFirmware -Firmware painel -Placa p4).Preservar) -contains 'PAINEL_COMODO') 'painel preserva PAINEL_COMODO'
  $erro = ''; try { Get-NexusFirmware -Firmware painel | Out-Null } catch { $erro = $_.Exception.Message }
  Ok ($erro -match '-Placa') 'painel sem -Placa dá erro claro' $erro
  Igual 'esp32:esp32@3.3.12' $script:NexusCoreEsp32 'core fixo 3.3.12'
  Ok ($script:NexusBibliotecas -contains 'ArduinoJson@7.4.2') 'ArduinoJson 7.4.2 na lista'
  $inst = [System.IO.File]::ReadAllText((Join-Path $pastaScripts 'instalar-arduino.ps1'))
  Ok ($inst -match 'NexusCoreEsp32' -and $inst -match "'painel'" -and $inst -notmatch 'core install esp32:esp32\s*$') 'instalar-arduino usa o core fixo e aceita painel'
}
Caso 'copia' {
  $repoFw = Join-Path $tmpBase 'repo/nexus_painel'; $docs = Join-Path $tmpBase 'docs/nexus_painel'
  New-Item -ItemType Directory -Force -Path (Join-Path $repoFw 'src') | Out-Null
  $v1 = @('// v1', '#define WIFI_SSID        "SUA_REDE_WIFI"', '#define WIFI_PASSWORD    "SUA_SENHA_WIFI"', '#define DEVICE_SECRET    "SUA_IOT_DEVICE_SECRET"',
          '#define PAINEL_MODO      PAINEL_MODO_CORREDOR', '#define PAINEL_MODO_CORREDOR 1', '#define PAINEL_COMODO    ""', '#define PAINEL_PLACA     PAINEL_PLACA_P4', 'void setup(){}')
  [System.IO.File]::WriteAllLines((Join-Path $repoFw 'nexus_painel.ino'), $v1)
  [System.IO.File]::WriteAllText((Join-Path $repoFw 'src/ui.h'), '// ui v1')
  $fw = Get-NexusFirmware -Firmware painel -Placa s3-7
  $c1 = Copy-NexusFirmware -Origem $repoFw -Destino $docs -Nome 'nexus_painel' -Preservar $fw.Preservar
  Igual 0 @($c1.Preservadas).Count 'cópia nova: nada a preservar'
  Igual 'WIFI_SSID WIFI_PASSWORD DEVICE_SECRET' ((Get-NexusPendencias -Ino $c1.Ino) -join ' ') 'pendências: as 3 linhas no valor de exemplo'
  # o usuário preenche
  $ino = Join-Path $docs 'nexus_painel.ino'
  $txt = [System.IO.File]::ReadAllText($ino)
  $txt = $txt.Replace('"SUA_REDE_WIFI"', '"MinhaRede"').Replace('"SUA_SENHA_WIFI"', '"s3nh@"').Replace('"SUA_IOT_DEVICE_SECRET"', '"segredo-xyz"')
  $txt = $txt.Replace('PAINEL_MODO_CORREDOR' + "`n", 'PAINEL_MODO_COMODO' + "`n").Replace('#define PAINEL_COMODO    ""', '#define PAINEL_COMODO    "Cozinha"').Replace('PAINEL_PLACA_P4', 'PAINEL_PLACA_S3_7')
  $txt = $txt -replace '(?m)^#define PAINEL_MODO\s+PAINEL_MODO_CORREDOR', '#define PAINEL_MODO      PAINEL_MODO_COMODO'
  [System.IO.File]::WriteAllText($ino, $txt)
  Igual 0 @(Get-NexusPendencias -Ino $ino).Count 'pendências: nenhuma depois de preencher'
  $tmpIno = Join-Path $tmpBase 'pend.ino'
  [System.IO.File]::WriteAllLines($tmpIno, [string[]]@('#define DEVICE_SECRET   "COLE_AQUI_O_IOT_DEVICE_SECRET"', '#define WIFI_SSID "Casa"'))
  Igual 'DEVICE_SECRET' ((Get-NexusPendencias -Ino $tmpIno) -join ' ') 'pendências: reconhece COLE_AQUI_... (nexus_painel)'
  # nova versão no repositório
  $v2 = $v1 | ForEach-Object { $_ -replace '^// v1', '// v2' }
  [System.IO.File]::WriteAllLines((Join-Path $repoFw 'nexus_painel.ino'), [string[]]($v2 + '// linha nova'))
  [System.IO.File]::WriteAllText((Join-Path $repoFw 'src/ui.h'), '// ui v2')
  $c2 = Copy-NexusFirmware -Origem $repoFw -Destino $docs -Nome 'nexus_painel' -Preservar $fw.Preservar
  $novo = [System.IO.File]::ReadAllText($ino)
  Igual 'DEVICE_SECRET PAINEL_COMODO PAINEL_MODO PAINEL_PLACA WIFI_PASSWORD WIFI_SSID' (@($c2.Preservadas) -join ' ') 'recopiar: devolve só os NOMES preservados'
  Ok ($novo -match '// v2' -and $novo -match '// linha nova') 'recopiar: código novo veio do repositório'
  Ok ($novo -match '"MinhaRede"' -and $novo -match '"s3nh@"' -and $novo -match '"segredo-xyz"') 'recopiar: Wi-Fi e chave mantidos'
  Ok ($novo -match 'PAINEL_MODO\s+PAINEL_MODO_COMODO' -and $novo -match 'PAINEL_COMODO\s+"Cozinha"' -and $novo -match 'PAINEL_PLACA\s+PAINEL_PLACA_S3_7') 'recopiar: PAINEL_MODO/COMODO/PLACA mantidos'
  Ok ($novo -match '#define PAINEL_MODO_CORREDOR 1') 'recopiar: #define parecido (PAINEL_MODO_CORREDOR) não é confundido'
  Ok (Test-Path -LiteralPath "$ino.bak") 'recopiar: backup .ino.bak'
  Ok ([System.IO.File]::ReadAllText((Join-Path $docs 'src/ui.h')) -eq '// ui v2' -and -not (Test-Path -LiteralPath (Join-Path $docs 'src/src'))) 'recopiar: subpasta atualizada sem aninhar'
  Igual 'PAINEL_PLACA_S3_7' (Get-NexusLinhaDefine -Ino $ino -Nome 'PAINEL_PLACA') 'Get-NexusLinhaDefine'
  $erro = ''; try { Copy-NexusFirmware -Origem (Join-Path $tmpBase 'nao-existe') -Destino $docs -Nome 'x' | Out-Null } catch { $erro = $_.Exception.Message }
  Ok ($erro -match 'git pull') 'firmware ausente: erro amigável' $erro
}
Caso 'tamanho' {
  $saida = "Sketch uses 1677721 bytes (53%) of program storage space. Maximum is 3145728 bytes.`nGlobal variables use 62000 bytes (18%) of dynamic memory, leaving 265680 bytes for local variables. Maximum is 327680 bytes."
  $t = Get-ArduinoTamanho -Texto $saida
  Ok ($t.FlashBytes -eq 1677721 -and $t.FlashPct -eq 53 -and $t.FlashMax -eq 3145728 -and $t.RamBytes -eq 62000 -and $t.RamPct -eq 18 -and $t.RamMax -eq 327680) 'Get-ArduinoTamanho lê flash e RAM'
  Ok ($null -eq (Get-ArduinoTamanho -Texto 'nada')) 'Get-ArduinoTamanho sem dados = $null'
  Igual '1,60 MB' (Format-NexusBytes 1677721) 'Format-NexusBytes MB'
}

# ==================================================================
Secao 'Quiosque, painel e utilidades'
Caso 'quiosque' {
  $telas = @(
    [pscustomobject]@{ Primary = $false; Bounds = [pscustomobject]@{ X = 1920; Y = 0; Width = 1920; Height = 1080 } },
    [pscustomobject]@{ Primary = $true;  Bounds = [pscustomobject]@{ X = 0; Y = 0; Width = 1920; Height = 1080 } },
    [pscustomobject]@{ Primary = $false; Bounds = [pscustomobject]@{ X = -1280; Y = 100; Width = 1280; Height = 1024 } })
  $m1 = Get-PosicaoMonitor -Telas $telas -Monitor 1
  $m2 = Get-PosicaoMonitor -Telas $telas -Monitor 2
  $m3 = Get-PosicaoMonitor -Telas $telas -Monitor 3
  Ok ($m1.X -eq 0 -and $m2.X -eq -1280 -and $m2.Y -eq 100 -and $m3.X -eq 1920) 'Get-PosicaoMonitor: principal primeiro, depois da esquerda para a direita'
  Ok ($null -eq (Get-PosicaoMonitor -Telas $telas -Monitor 4)) 'Get-PosicaoMonitor: monitor inexistente = $null'
  $e = Get-QuiosqueArgumentos -Navegador edge -Url 'https://nexushome-os.vercel.app' -Perfil 'C:\p' -Posicao $m3
  Igual '--kiosk "https://nexushome-os.vercel.app" --edge-kiosk-type=fullscreen --no-first-run --user-data-dir="C:\p" --window-position=1920,0' $e 'argumentos do Edge'
  $c = Get-QuiosqueArgumentos -Navegador chrome -Url 'http://x'
  Ok ($c -match '^--kiosk "http://x"' -and $c -notmatch 'edge-kiosk' -and $c -notmatch 'window-position') 'argumentos do Chrome'
}
Caso 'painel' {
  $json = '{"v":1,"t":"2026-10-15T12:00:00Z","house":{"watts":1234,"water_lph":56,"level_pct":78,"soc":91,"grid_ok":false,"alerts_open":1,"health":"critical"},"rooms":["Cozinha","Área Externa"],"devices":[{"id":"b3000000-0000-4000-8000-000000000001","n":"Luz — Cozinha","r":"Cozinha","t":"light","ok":true,"on":true,"bri":80,"act":["power","brightness"]},{"id":"b3000000-0000-4000-8000-000000000041","n":"Exaustor","r":"Banheiro 1","t":"fan","ok":false,"act":[]}],"alerts":[{"sev":"critical","msg":"Gás na cozinha","at":"x"}]}'
  $txt = (Format-NexusPainel -Snapshot ($json | ConvertFrom-Json)) -join "`n"
  Ok ($txt -match '1\.234 W' -and $txt -match '56 L/h' -and $txt -match '78 %' -and $txt -match '91 %' -and $txt -match 'SEM REDE' -and $txt -match 'CRÍTICO') 'Format-NexusPainel: resumo da casa' $txt
  Ok ($txt -match 'Luz — Cozinha \(Cozinha, light\): ligado, brilho 80 %' -and $txt -match 'offline' -and $txt -match 'Gás na cozinha') 'Format-NexusPainel: aparelhos e alertas' $txt
  $vazio = (Format-NexusPainel -Snapshot ('{"house":{"watts":0,"level_pct":null,"soc":null,"alerts_open":0,"health":"safe"},"rooms":[],"devices":[],"alerts":[]}' | ConvertFrom-Json)) -join "`n"
  Ok ($vazio -match 'sem sonda' -and $vazio -match 'sem nobreak' -and $vazio -match 'Aparelhos \(0\)') 'Format-NexusPainel: casa vazia (StrictMode)' $vazio
  Ok ((ConvertTo-NexusValor 'true') -eq $true -and (ConvertTo-NexusValor 'false') -eq $false -and (ConvertTo-NexusValor '22') -eq 22 -and (ConvertTo-NexusValor 'away') -eq 'away') 'ConvertTo-NexusValor'
  Igual '' (Get-NexusPortaDica 'Porta de comunicação') 'dica de porta: desconhecida'
  Ok ((Get-NexusPortaDica 'Dispositivo Serial USB JTAG/serial debug unit (COM5)') -match 'ESP32') 'dica de porta: ESP32'
  Ok ((Get-NexusPortaDica 'USB-SERIAL CH340 (COM3)') -match 'RS-485') 'dica de porta: CH340'
}
Caso 'http' {
  # Invoke-WebRequest falso: guarda os parâmetros. No Windows PowerShell 5.1 um GET com Body/ContentType
  # falha ("Não é possível enviar um conteúdo com este tipo de verbo") — o PowerShell 7 aceita e esconderia o erro.
  $script:pedido = $null
  function global:Invoke-WebRequest {
    [CmdletBinding()] param($Uri, $Method, $Headers, [switch]$UseBasicParsing, $TimeoutSec, $Body, $ContentType)
    $script:pedido = @{} + $PSBoundParameters
    throw 'sem rede (falso)'
  }
  try {
    $null = Invoke-NexusHttp -Url 'https://exemplo.invalid/health'
    Ok (-not $script:pedido.ContainsKey('Body') -and -not $script:pedido.ContainsKey('ContentType')) 'Invoke-NexusHttp: GET sem corpo (Windows PowerShell 5.1)' ($script:pedido.Keys -join ', ')
    $null = Invoke-NexusHttp -Url 'https://exemplo.invalid/panel' -Chave 'k'
    Ok (-not $script:pedido.ContainsKey('Body') -and $script:pedido.Headers['x-device-key'] -eq 'k') 'Invoke-NexusHttp: GET com chave, sem corpo' ($script:pedido.Keys -join ', ')
    $r = Invoke-NexusHttp -Metodo POST -Url 'https://exemplo.invalid/panel/command' -CorpoJson '{"a":"ç"}'
    Ok ($script:pedido.ContainsKey('Body') -and $script:pedido.ContentType -match 'utf-8' -and $script:pedido.Body.Length -eq 10) 'Invoke-NexusHttp: POST com corpo UTF-8' ($script:pedido.Keys -join ', ')
    Igual 0 $r.Status 'Invoke-NexusHttp: sem rede = Status 0'
  } finally {
    Remove-Item function:global:Invoke-WebRequest -ErrorAction SilentlyContinue
  }
}

# ==================================================================
Secao 'Integração: scripts que só rodam no Windows'
if ($ehWindows) {
  Pula 'detecção de sistema' 'rodando no Windows'
} else {
  Caso 'so windows' {
    foreach ($c in @(@('quiosque-nexushome.ps1', @('-Instalar', '-WhatIf')), @('quiosque-nexushome.ps1', @('-Testar')), @('quiosque-nexushome.ps1', @('-Remover', '-WhatIf')),
                     @('publicar-funcoes.ps1', @('-WhatIf')), @('publicar-funcoes.ps1', @('-Todas', '-WhatIf')), @('instalar-arduino.ps1', @('-Firmware', 'eletrica', '-Porta', 'COM5')))) {
      $r = Rodar $c[0] $c[1]
      $nome = "$($c[0]) $($c[1] -join ' ') fora do Windows"
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'Windows' -and (SemStack $r.Saida)) "$nome -> código 1, mensagem clara, sem stacktrace" $r.Saida
    }
  }
}

Secao 'Integração: gravar-firmware com arduino-cli falso'
if ($ehWindows) { Pula 'gravar-firmware' 'arduino-cli falso é um script bash' }
else {
  Caso 'gravar' {
    $bin = Join-Path $tmpBase 'bin'; New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $log = Join-Path $tmpBase 'cli.log'
    $falso = Join-Path $bin 'arduino-cli'
    [System.IO.File]::WriteAllText($falso, "#!/bin/sh`necho ""`$@"" >> '$log'`nif [ ""`$1"" = compile ]; then echo 'Compilando...'; echo 'Sketch uses 1677721 bytes (53%) of program storage space. Maximum is 3145728 bytes.'; echo 'Global variables use 62000 bytes (18%) of dynamic memory, leaving 265680 bytes for local variables. Maximum is 327680 bytes.'; fi`nif [ ""`$1"" = upload ]; then echo 'Hard resetting via RTS pin...'; fi`nexit 0`n")
    & chmod +x $falso
    $sk = Join-Path $tmpBase 'sk/esp32s3_eletrica'
    New-Item -ItemType Directory -Force -Path $sk | Out-Null
    [System.IO.File]::WriteAllLines((Join-Path $sk 'esp32s3_eletrica.ino'), [string[]]@('#define WIFI_SSID "SUA_REDE_WIFI"', '#define WIFI_PASSWORD "s"', '#define DEVICE_SECRET "SEGREDO-NAO-MOSTRAR"'))
    $amb = @{ PATH = "$bin$([System.IO.Path]::PathSeparator)$env:PATH" }

    $r = Rodar 'gravar-firmware.ps1' @('-Firmware', 'eletrica', '-Pasta', $sk, '-SoCompilar') $amb
    Ok ($r.Codigo -eq 0 -and $r.Saida -match 'Flash \(programa\): 1,60 MB de 3,00 MB \(53%\)' -and $r.Saida -match 'RAM \(variáveis\)') 'gravar-firmware -SoCompilar mostra flash/RAM' $r.Saida
    $l = [System.IO.File]::ReadAllText($log)
    Ok ($l -match 'compile --fqbn esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc') 'gravar-firmware passa o FQBN da 4.3B' $l
    Ok ($r.Saida -notmatch 'SEGREDO-NAO-MOSTRAR') 'gravar-firmware não mostra a chave'

    $r = Rodar 'gravar-firmware.ps1' @('-Firmware', 'eletrica', '-Pasta', $sk, '-Porta', 'COM5') $amb
    Ok ($r.Codigo -eq 1 -and $r.Saida -match 'WIFI_SSID' -and $r.Saida -match 'Cancelado' -and $r.Saida -notmatch 'SEGREDO') 'gravar com Wi-Fi de exemplo pede confirmação (sem console = cancela)' $r.Saida
    $r = Rodar 'gravar-firmware.ps1' @('-Firmware', 'eletrica', '-Pasta', $sk, '-Porta', 'COM5', '-Sim') $amb
    $l = [System.IO.File]::ReadAllText($log)
    Ok ($r.Codigo -eq 0 -and $l -match 'upload -p COM5 --fqbn esp32:esp32:esp32s3') 'gravar-firmware -Porta -Sim grava (upload)' $r.Saida

    $sp = Join-Path $tmpBase 'sk2/nexus_painel'; New-Item -ItemType Directory -Force -Path $sp | Out-Null
    [System.IO.File]::WriteAllLines((Join-Path $sp 'nexus_painel.ino'), [string[]]@('#define PAINEL_PLACA PAINEL_PLACA_S3_7'))
    $r = Rodar 'gravar-firmware.ps1' @('-Firmware', 'painel', '-Placa', 'p4', '-Pasta', $sp, '-SoCompilar') $amb
    $l = [System.IO.File]::ReadAllText($log)
    Ok ($r.Codigo -eq 0 -and $l -match 'compile --fqbn esp32:esp32:esp32p4:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled' -and $r.Saida -match 'não combina') 'painel P4: FQBN do P4 e aviso de PAINEL_PLACA trocado' $r.Saida
    $r = Rodar 'gravar-firmware.ps1' @('-Firmware', 'painel', '-Pasta', $sp, '-SoCompilar') $amb
    Ok ($r.Codigo -eq 1 -and $r.Saida -match '-Placa p4' -and (SemStack $r.Saida)) 'painel sem -Placa: erro claro' $r.Saida
    $r = Rodar 'gravar-firmware.ps1' @('-Firmware', 'eletrica', '-Pasta', $sk, '-SoCompilar') @{ PATH = '/nao/existe' }
    Ok ($r.Codigo -eq 1 -and $r.Saida -match 'arduino-cli não encontrado' -and (SemStack $r.Saida)) 'sem arduino-cli: erro amigável' $r.Saida
  }
}

# ==================================================================
$temFalsos = $false
$py = Get-Command $Python -ErrorAction SilentlyContinue
if (-not $Falsos -or -not (Test-Path -LiteralPath (Join-Path $Falsos 'falso_modbus_tcp.py'))) { $motivo = 'sem -Falsos (pasta dos servidores falsos)' }
elseif (-not $py) { $motivo = "sem $Python" }
else { $temFalsos = $true }

$processos = New-Object System.Collections.Generic.List[object]
function Iniciar-Falso([string]$Arquivo, [string[]]$Argumentos) {
  $saidaArq = Join-Path $tmpBase ([guid]::NewGuid().ToString('N') + '.txt')
  $p = Start-Process -FilePath $py.Path -ArgumentList (@((Join-Path $Falsos $Arquivo)) + $Argumentos + @($saidaArq)) -WorkingDirectory $Falsos -PassThru
  $processos.Add($p)
  for ($i = 0; $i -lt 100 -and -not ((Test-Path -LiteralPath $saidaArq) -and (Get-Item -LiteralPath $saidaArq).Length -gt 0); $i++) { Start-Sleep -Milliseconds 50 }
  if (-not (Test-Path -LiteralPath $saidaArq)) { throw "o falso $Arquivo não iniciou" }
  Start-Sleep -Milliseconds 100
  return ([System.IO.File]::ReadAllText($saidaArq).Trim())
}
function Iniciar-Serial([string]$Modo) {
  # falso_serial.py <modo> <saida> [segundos]
  $saidaArq = Join-Path $tmpBase ([guid]::NewGuid().ToString('N') + '.txt')
  $p = Start-Process -FilePath $py.Path -ArgumentList @((Join-Path $Falsos 'falso_serial.py'), $Modo, $saidaArq, '60') -WorkingDirectory $Falsos -PassThru
  $processos.Add($p)
  for ($i = 0; $i -lt 100 -and -not ((Test-Path -LiteralPath $saidaArq) -and (Get-Item -LiteralPath $saidaArq).Length -gt 0); $i++) { Start-Sleep -Milliseconds 50 }
  return ([System.IO.File]::ReadAllText($saidaArq).Trim())
}

try {
  Secao 'Integração: testar-modbus contra gateway Modbus TCP falso'
  if (-not $temFalsos) { Pula 'testar-modbus TCP' $motivo }
  else {
    Caso 'modbus tcp' {
      $portas = (Iniciar-Falso 'falso_modbus_tcp.py' @()) -split ' '
      $mb = $portas[0]; $tr = $portas[1]
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $mb, '-Slave', '7', '-Pzem')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '220,0 V' -and $r.Saida -match '70,000 A' -and $r.Saida -match '15400,0 W' -and $r.Saida -match '123\.456 Wh' -and $r.Saida -match '60,0 Hz' -and $r.Saida -match '1,00') 'testar-modbus -Ip -Slave 7 -Pzem: leitura do PZEM-016' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $mb, '-Slave', '9')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match '0x0B' -and $r.Saida -match 'não respondeu' -and (SemStack $r.Saida)) 'testar-modbus escravo inexistente: exceção 0x0B explicada' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $mb, '-Slave', '41', '-Pzem017')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '26,40 V' -and $r.Saida -match '12,50 A' -and $r.Saida -match '330,0 W') 'testar-modbus -Pzem017 (banco 24 V)' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $mb, '-Slave', '3', '-Funcao', '3', '-Registro', '0x0101', '-Quantidade', '2')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'reg\s+257 \(0x0101\) =\s+357' -and $r.Saida -match 'reg\s+258 \(0x0102\) =\s+358') 'testar-modbus função 03, registro em hexadecimal' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $mb, '-Slave', '7', '-Funcao', '3', '-Registro', '5', '-Quantidade', '1')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match '0x02') 'testar-modbus exceção 0x02 (registrador inexistente)' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $tr, '-Transparente', '-Slave', '7', '-Pzem')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '220,0 V') 'testar-modbus -Transparente (RTU dentro do TCP)' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', $tr, '-Transparente', '-Slave', '9', '-TimeoutMs', '500')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'não respondeu em 500 ms' -and (SemStack $r.Saida)) 'testar-modbus -Transparente sem resposta: timeout' $r.Saida
      $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0; $l.Start(); $livre = $l.LocalEndpoint.Port; $l.Stop()
      $r = Rodar 'testar-modbus.ps1' @('-Ip', '127.0.0.1', '-TcpPorta', "$livre", '-Slave', '7', '-TimeoutMs', '800')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match '(recusada|sem conexão)' -and (SemStack $r.Saida)) 'testar-modbus porta fechada: erro de conexão claro' $r.Saida
    }
  }

  Secao 'Integração: testar-painel contra iot-gateway HTTP falso'
  if (-not $temFalsos) { Pula 'testar-painel' $motivo }
  else {
    Caso 'painel http' {
      $porta = Iniciar-Falso 'falso_http.py' @()
      $base = "http://127.0.0.1:$porta/functions/v1/iot-gateway"
      $chave = 'chave-de-teste-123'
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base) @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '1\.234 W' -and $r.Saida -match '78 %' -and $r.Saida -match '91 %' -and $r.Saida -match 'Luz — Cozinha' -and $r.Saida -match 'Consumo alto' -and $r.Saida -match 'ATENÇÃO') 'testar-painel: health + resumo da casa' $r.Saida
      Ok ($r.Saida -notmatch [regex]::Escape($chave)) 'testar-painel: a chave não aparece na saída'
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base, '-Comodo', 'Cozinha') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'Aparelhos \(2\)' -and $r.Saida -notmatch 'Exaustor') 'testar-painel -Comodo filtra os aparelhos' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base, '-Dispositivo', 'b3000000-0000-4000-8000-000000000001', '-Acao', 'power', '-Valor', 'false', '-Sim') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'comando aceito \(na fila' -and $r.Saida -match '"value":false') 'testar-painel POST /panel/command (power=false)' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base, '-Dispositivo', 'b3000000-0000-4000-8000-000000000001', '-Acao', 'power') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'cancelado' -and $r.Saida -notmatch 'comando aceito') 'testar-painel: comando sem confirmação não é enviado' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base, '-Dispositivo', 'b3000000-0000-4000-8000-000000000001', '-Acao', 'power', '-WhatIf') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 0 -and $r.Saida -notmatch 'comando aceito') 'testar-painel -WhatIf não envia o comando' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base, '-Dispositivo', 'b3000000-0000-4000-8000-000000000033', '-Acao', 'temp', '-Valor', '22', '-Sim') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 1 -and $r.Saida -match '422' -and $r.Saida -match 'não disponível') 'testar-painel: ação inválida (422) explicada' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base, '-VerComandos', '-Sim') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '1 comando' -and $r.Saida -match 'ATENÇÃO') 'testar-painel -VerComandos (com aviso de consumo)' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base) @{ NEXUS_DEVICE_KEY = 'chave-errada-456' }
      Ok ($r.Codigo -eq 1 -and $r.Saida -match '401' -and $r.Saida -match 'recusada' -and $r.Saida -notmatch 'chave-errada-456' -and (SemStack $r.Saida)) 'testar-painel: chave errada (401) sem mostrar a chave' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', $base) @{ NEXUS_DEVICE_KEY = '' }
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'NEXUS_DEVICE_KEY' -and (SemStack $r.Saida)) 'testar-painel: sem chave e sem console -> mensagem clara' $r.Saida
      $r = Rodar 'testar-painel.ps1' @('-BaseUrl', 'http://127.0.0.1:1/x') @{ NEXUS_DEVICE_KEY = $chave }
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'sem resposta' -and (SemStack $r.Saida)) 'testar-painel: servidor fora do ar' $r.Saida
    }
  }

  Secao 'Integração: serial (pty) — monitor, endereçamento e leitura RTU'
  if (-not $temFalsos) { Pula 'serial' $motivo }
  elseif ($ehWindows) { Pula 'serial' 'pty só existe no Linux' }
  else {
    Caso 'serial' {
      $esp = Iniciar-Serial 'esp32'
      $r = Rodar 'monitor-serial.ps1' @('-Porta', $esp, '-Comando', 'status', '-Segundos', '2')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '\[status\] Wi-Fi ok') 'monitor-serial -Comando status' $r.Saida
      $r = Rodar 'monitor-serial.ps1' @('-Porta', $esp, '-Comando', 'scan', '-Segundos', '2')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'fim: 3 respondendo') 'monitor-serial -Comando scan' $r.Saida
      $r = Rodar 'monitor-serial.ps1' @('-Porta', '/dev/ttyNAOEXISTE9', '-Comando', 'status', '-Segundos', '1')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'não consegui abrir' -and (SemStack $r.Saida)) 'monitor-serial porta inexistente' $r.Saida
      $r = Rodar 'monitor-serial.ps1' @('-Porta', $esp)
      Ok ($r.Codigo -eq 1 -and $r.Saida -match '-Comando' -and (SemStack $r.Saida)) 'monitor-serial interativo sem console: mensagem clara' $r.Saida
      $r = Rodar 'monitor-serial.ps1' @('-Listar')
      Ok (($r.Codigo -eq 0 -or $r.Codigo -eq 1) -and $r.Saida -match '(Portas seriais|Nenhuma porta)' -and (SemStack $r.Saida)) 'monitor-serial -Listar' $r.Saida

      $pz = Iniciar-Serial 'pzem016'
      $r = Rodar 'monitor-serial.ps1' @('-Porta', $pz, '-Comando', 'status', '-Segundos', '1')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'Nada chegou') 'monitor-serial: nada chegou -> código 1' $r.Saida
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $pz, '-Tipo', 'pzem016', '-Novo', '7', '-Geral', '-WhatIf')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'F8 06 00 02 00 07 7D A1' -and $r.Saida -match '07 03 00 02 00 01 25 AC' -and $r.Saida -notmatch 'confirmado') 'enderecar-modbus -WhatIf mostra os quadros sem enviar' $r.Saida
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $pz, '-Tipo', 'pzem016', '-Novo', '7', '-Geral')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'Cancelado') 'enderecar-modbus sem confirmação não grava' $r.Saida
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $pz, '-Tipo', 'pzem016', '-Novo', '7', '-Geral', '-Sim')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'Endereço 7 gravado e confirmado') 'enderecar-modbus PZEM-016 pelo endereço geral 0xF8' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Porta', $pz, '-Slave', '7', '-Pzem')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '220,0 V' -and $r.Saida -match '123\.456 Wh') 'testar-modbus -Porta (RTU) lê o PZEM no endereço novo' $r.Saida
      $r = Rodar 'testar-modbus.ps1' @('-Porta', $pz, '-Slave', '1', '-TimeoutMs', '400')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'não respondeu em 400 ms') 'testar-modbus -Porta: endereço antigo não responde mais' $r.Saida
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $pz, '-Tipo', 'pzem016', '-Novo', '9', '-Atual', '3', '-Sim', '-TimeoutMs', '400')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'sem resposta do endereço 3' -and (SemStack $r.Saida)) 'enderecar-modbus: -Atual errado -> dica' $r.Saida

      $ws = Iniciar-Serial 'waveshare'
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $ws, '-Tipo', 'waveshare', '-Novo', '5', '-Geral', '-Sim')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '00 06 40 00 00 05' -and $r.Saida -match 'Endereço 5 gravado e confirmado') 'enderecar-modbus Waveshare por broadcast 0x00' $r.Saida
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $ws, '-Tipo', 'waveshare', '-Novo', '22', '-Atual', '5', '-Sim')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match 'Endereço 22 gravado') 'enderecar-modbus Waveshare 5 -> 22' $r.Saida

      $xy = Iniciar-Serial 'xymd02'
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $xy, '-Tipo', 'xymd02', '-Novo', '80', '-Geral', '-Sim')
      Ok ($r.Codigo -eq 1 -and $r.Saida -match 'não tem endereço geral') 'enderecar-modbus XY-MD02 recusa -Geral' $r.Saida
      $r = Rodar 'enderecar-modbus.ps1' @('-Porta', $xy, '-Tipo', 'xymd02', '-Novo', '80', '-Sim')
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '01 06 01 01 00 50 D9 CA' -and $r.Saida -match 'Endereço 80 gravado e confirmado') 'enderecar-modbus XY-MD02 1 -> 80 (reg 0x0101)' $r.Saida
    }
  }

  Secao 'Ajuda (-?) dos scripts'
  foreach ($n in $principais) {
    Caso "ajuda $n" {
      # sem terminal o pwsh 7 desenha a ajuda do -? em branco; no Linux roda dentro de um pty com o 'script'
      $scriptCmd = $null
      if (-not $ehWindows) { $scriptCmd = Get-Command script -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
      if ($scriptCmd) {
        $linhaCmd = "'$pwsh' -NoProfile -NonInteractive -File '$(Join-Path $pastaScripts $n)' -?"
        $saida = & $scriptCmd.Path -qc $linhaCmd /dev/null 2>&1 | ForEach-Object { "$_" }
        $r = [pscustomobject]@{ Codigo = $LASTEXITCODE; Saida = (@($saida) -join "`n") }
      } else { $r = Rodar $n @('-?') }
      Ok ($r.Codigo -eq 0 -and $r.Saida -match '(SYNOPSIS|SINOPSE)' -and $r.Saida -match 'NexusHome|PZEM|Modbus|firmware|quiosque|serial') "$n -? mostra a ajuda" $r.Saida
    }
  }
} finally {
  foreach ($p in $processos) { try { if (-not $p.HasExited) { $p.Kill() } } catch { } }
  try { Remove-Item -LiteralPath $tmpBase -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Host ''
$cor = 'Green'; if ($script:Falhou -gt 0) { $cor = 'Red' }
Write-Host "Resultado: $($script:Passou) passaram, $($script:Falhou) falharam, $($script:Pulou) pulados." -ForegroundColor $cor
if ($script:Falhou -gt 0) {
  Write-Host 'Falharam:' -ForegroundColor Red
  $script:Falhas | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0

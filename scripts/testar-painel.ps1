<#
.SYNOPSIS
  Confere o servidor das telas de parede: /iot-gateway/health, /panel e (opcional) /panel/command e /commands.

.DESCRIPTION
  A chave do dispositivo (o IOT_DEVICE_SECRET) é lida da variável de ambiente NEXUS_DEVICE_KEY ou digitada
  sem aparecer na tela (Read-Host -AsSecureString). Ela nunca é mostrada nem gravada em arquivo.
    1. GET  /iot-gateway/health                    (sem chave)
    2. GET  /iot-gateway/panel?room=&limit=         resumo legível: energia, água, reservatório, bateria,
                                                   alertas e aparelhos (com o id para usar no -Dispositivo)
   2b. GET  /iot-gateway/panel/plan                 a planta ATUAL do app (a que o P4 desenha) e a assinatura
    3. POST /iot-gateway/panel/command              só com -Dispositivo/-Acao/-Valor, e pede confirmação
    4. GET  /iot-gateway/commands?devices=          só com -VerComandos: ATENÇÃO, os comandos lidos são
                                                   marcados como entregues e a placa não os recebe mais.
  Código de saída: 0 tudo ok; 1 alguma falha.

.PARAMETER Comodo
  Filtra os aparelhos de um cômodo (ex.: Cozinha). O resumo da casa vem sempre.

.PARAMETER Limite
  Máximo de aparelhos (1 a 150; padrão 80).

.PARAMETER Dispositivo
  UUID do aparelho para o comando (aparece no resumo).

.PARAMETER Acao
  power, brightness, temp, valve, open ou armed.

.PARAMETER Valor
  true/false, número (brilho 1-100, temperatura 16-30) ou off/home/away (alarme). Padrão true.

.PARAMETER BaseUrl
  Endereço do iot-gateway (padrão: o do projeto no Supabase).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1 -Comodo Cozinha

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1 -Dispositivo b3000000-0000-4000-8000-000000000001 -Acao power -Valor true

.EXAMPLE
  $env:NEXUS_DEVICE_KEY = Read-Host -Prompt 'chave'; powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Comodo = '',
  [ValidateRange(1, 150)][int]$Limite = 80,
  [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')][string]$Dispositivo = '',
  [ValidateSet('power', 'brightness', 'temp', 'valve', 'open', 'armed')][string]$Acao = '',
  [string]$Valor = 'true',
  [switch]$VerComandos,
  [string]$Dispositivos = '',
  [ValidatePattern('^https?://\S+$')][string]$BaseUrl = 'https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway',
  [switch]$Bruto,
  [switch]$Sim
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

function Get-Chave {
  if ($env:NEXUS_DEVICE_KEY) { Write-Host '(chave lida de NEXUS_DEVICE_KEY)'; return $env:NEXUS_DEVICE_KEY }
  try { $seg = Read-Host -AsSecureString 'Chave do dispositivo (IOT_DEVICE_SECRET; não aparece na tela)' }
  catch { throw 'sem console para digitar a chave: defina a variável de ambiente NEXUS_DEVICE_KEY.' }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($seg)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-MotivoHttp($r) {
  $msg = Get-NexusPropriedade $r.Json 'error'
  if (-not $msg) { $msg = Get-NexusPropriedade $r.Json 'message' }
  if (-not $msg) { $msg = "$($r.Texto)"; if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) } }
  switch ($r.Status) {
    0   { return "sem resposta do servidor ($msg). Internet? Endereço certo?" }
    401 {
      if ("$msg" -match '(?i)authorization|jwt') { return "401: $msg — publique o iot-gateway com --no-verify-jwt (scripts\publicar-funcoes.ps1 já faz isso)." }
      return "401: chave do dispositivo recusada ($msg). Confira o IOT_DEVICE_SECRET."
    }
    404 { return "404: $msg" }
    503 { return "503: $msg — configure o segredo: supabase secrets set IOT_DEVICE_SECRET=... (digitado por você)." }
    default { return "HTTP $($r.Status): $msg" }
  }
}

try {
  $base = $BaseUrl.TrimEnd('/')
  if (($Dispositivo -and -not $Acao) -or ($Acao -and -not $Dispositivo)) { throw 'para mandar um comando informe -Dispositivo e -Acao (e -Valor).' }
  $falhou = $false

  # ---- 1. health ----
  Write-NexusPasso "1. GET $base/health"
  $h = Invoke-NexusHttp -Url "$base/health"
  if ($h.Status -eq 200 -and (Get-NexusPropriedade $h.Json 'ok') -eq $true) {
    Write-NexusOk "  ok ($(Get-NexusPropriedade $h.Json 'service'))"
  } else { Write-NexusErro "  $(Get-MotivoHttp $h)"; exit 1 }

  $chave = Get-Chave
  if (-not $chave) { throw 'chave vazia.' }

  # ---- 2. panel ----
  $q = "limit=$Limite"
  if ($Comodo) { $q = "room=$([uri]::EscapeDataString($Comodo))&$q" }
  Write-NexusPasso "2. GET $base/panel?$q"
  $p = Invoke-NexusHttp -Url "$base/panel?$q" -Chave $chave
  if ($p.Status -ne 200) { Write-NexusErro "  $(Get-MotivoHttp $p)"; $falhou = $true }
  elseif ($null -eq (Get-NexusPropriedade $p.Json 'house')) {
    Write-NexusErro '  o servidor respondeu, mas sem o resumo "house": o iot-gateway publicado ainda não tem o /panel (v11). Rode scripts\publicar-funcoes.ps1.'
    $falhou = $true
  } else {
    if ($Bruto) { Write-Host $p.Texto }
    Format-NexusPainel -Snapshot $p.Json | ForEach-Object { Write-Host "  $_" }
    if ($Comodo -and @(Get-NexusPropriedade $p.Json 'devices' @()).Count -eq 0) {
      Write-NexusAviso "  nenhum aparelho no cômodo '$Comodo'. Confira o nome exato na lista de cômodos acima."
    }
  }

  # ---- 2b. planta do app (a mesma que o P4 do corredor desenha) ----
  Write-NexusPasso "2b. GET $base/panel/plan?floor=0  (planta atual do NexusHome)"
  $pl = Invoke-NexusHttp -Url "$base/panel/plan?floor=0" -Chave $chave
  if ($pl.Status -eq 404) {
    Write-NexusAviso '  o iot-gateway publicado ainda não tem /panel/plan: o P4 fica sem a planta. Rode scripts\publicar-funcoes.ps1.'
  } elseif ($pl.Status -ne 200) { Write-NexusErro "  $(Get-MotivoHttp $pl)"; $falhou = $true }
  else {
    $nc = @(Get-NexusPropriedade $pl.Json 'rooms' @()).Count
    $np = @(Get-NexusPropriedade $pl.Json 'walls' @()).Count
    $sig = Get-NexusPropriedade $pl.Json 'sig'
    $nomes = (@(Get-NexusPropriedade $pl.Json 'rooms' @()) | ForEach-Object { Get-NexusPropriedade $_ 'n' }) -join ', '
    Write-NexusOk "  $nc cômodos, $np paredes: $nomes"
    if (-not $sig) {
      Write-NexusAviso '  sem assinatura (sig): o iot-gateway publicado é anterior à atualização automática da planta. Rode scripts\publicar-funcoes.ps1.'
    } else {
      $ps = Invoke-NexusHttp -Url "$base/panel?limit=1&plan=0" -Chave $chave
      $psv = if ($ps.Status -eq 200) { Get-NexusPropriedade $ps.Json 'ps' } else { $null }
      if ($psv -eq $sig) { Write-NexusOk "  assinatura ${sig}: o P4 redesenha sozinho quando a planta muda no app." }
      else { Write-NexusAviso "  assinatura da planta ($sig) diferente da do /panel ($psv): tente de novo (a planta pode ter mudado agora)." }
    }
  }

  # ---- 3. comando ----
  if ($Dispositivo) {
    $v = ConvertTo-NexusValor $Valor
    $corpo = (@{ device_id = $Dispositivo.ToLower(); action = $Acao; value = $v } | ConvertTo-Json -Compress)
    Write-NexusPasso "3. POST $base/panel/command  $corpo"
    $vai = $false
    if ($PSCmdlet.ShouldProcess($Dispositivo, "acionar $Acao = $v")) {
      $vai = $Sim
      if (-not $vai) { $vai = Confirm-Nexus "Isto aciona o aparelho de verdade ($Acao = $v). Continuar?" }
      if (-not $vai) { Write-Host '  cancelado.' }
    }
    if ($vai) {
      $c = Invoke-NexusHttp -Metodo POST -Url "$base/panel/command" -Chave $chave -CorpoJson $corpo
      if ($c.Status -ge 200 -and $c.Status -lt 300) {
        $extra = ''
        $fila = Get-NexusPropriedade $c.Json 'queued'
        if ($fila -eq $true) { $extra = ' (na fila da tela do barramento)' }
        Write-NexusOk "  comando aceito$extra."
        if ($Bruto) { Write-Host "  $($c.Texto)" }
      } else { Write-NexusErro "  $(Get-MotivoHttp $c)"; $falhou = $true }
    }
  }

  # ---- 4. comandos pendentes ----
  if ($VerComandos) {
    $q2 = ''
    if ($Dispositivos) { $q2 = "?devices=$([uri]::EscapeDataString($Dispositivos))" }
    Write-NexusPasso "4. GET $base/commands$q2"
    Write-NexusAviso '  ATENÇÃO: os comandos lidos aqui são marcados como entregues e a tela NÃO os recebe mais.'
    $vai = $Sim
    if (-not $vai -and -not $WhatIfPreference) { $vai = Confirm-Nexus 'Ler (e consumir) os comandos pendentes?' }
    if ($vai -and $PSCmdlet.ShouldProcess('comandos pendentes', 'ler e marcar como entregues')) {
      $k = Invoke-NexusHttp -Url "$base/commands$q2" -Chave $chave
      if ($k.Status -ne 200) { Write-NexusErro "  $(Get-MotivoHttp $k)"; $falhou = $true }
      else {
        $lista = @(Get-NexusPropriedade $k.Json 'commands' @()) | Where-Object { $null -ne $_ }
        Write-Host "  $(@($lista).Count) comando(s):"
        foreach ($x in $lista) { Write-Host "    $(Get-NexusPropriedade $x 'device_id') -> $((Get-NexusPropriedade $x 'command') | ConvertTo-Json -Compress)" }
      }
    }
  }

  if ($falhou) { exit 1 }
  Write-NexusOk "`nServidor das telas ok."
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}

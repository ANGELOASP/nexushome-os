<#
.SYNOPSIS
  Publica as Edge Functions do NexusHome no Supabase (projeto gfjxcsvxhaojbtuixpjh) pelo Supabase CLI.

.DESCRIPTION
  Roda, na pasta do repositório:
    supabase functions deploy <nome> --project-ref gfjxcsvxhaojbtuixpjh [--no-verify-jwt]
  Padrão: iot-gateway e notify-alert. -Todas inclui smartthings-proxy e tuya-proxy.
    iot-gateway   --no-verify-jwt  (o ESP32 se autentica só pelo cabeçalho x-device-key)
    notify-alert  --no-verify-jwt  (quem chama é o webhook do banco)
    smartthings-proxy / tuya-proxy SEM --no-verify-jwt (exigem login no app)
  Confere se o Supabase CLI existe e se você está logado. Tenta publicar sem Docker (--use-api) e,
  se o seu CLI for antigo, sem essa opção.
  Secrets (opcional, antes de publicar):
    -DefinirSegredo  pede o IOT_DEVICE_SECRET aqui dentro, sem aparecer na tela (Read-Host -AsSecureString,
                     digitado duas vezes). NÃO digite "supabase secrets set" com o valor no console: a
                     linha fica no histórico do PowerShell (ConsoleHost_history.txt).
    -OwnerId <uuid>  grava IOT_OWNER_ID (o uuid do usuário dono da casa; não é segredo).
  Os valores vão para o Supabase CLI por um arquivo .env temporário (supabase secrets set --env-file),
  apagado logo em seguida; nunca na linha de comando nem na tela. -SoSegredos grava e não publica nada.
  Só para Windows (o PC onde você faz a manutenção). Aceita -WhatIf.

.PARAMETER Funcoes
  Quais publicar: iot-gateway, notify-alert, smartthings-proxy, tuya-proxy.

.PARAMETER Todas
  Publica as quatro.

.PARAMETER Sim
  Não pergunta antes de abrir o "supabase login".

.PARAMETER DefinirSegredo
  Pede (sem eco) e grava o secret IOT_DEVICE_SECRET no projeto.

.PARAMETER OwnerId
  Grava o secret IOT_OWNER_ID = uuid do usuário dono da casa (Supabase > Authentication > Users).

.PARAMETER SoSegredos
  Só grava os secrets (-DefinirSegredo / -OwnerId), sem publicar as funções.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -Funcoes iot-gateway

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -Todas -WhatIf

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -DefinirSegredo -OwnerId 00000000-0000-4000-8000-000000000000 -SoSegredos
  Grava IOT_DEVICE_SECRET (digitado sem aparecer) e IOT_OWNER_ID, sem publicar.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('iot-gateway', 'notify-alert', 'smartthings-proxy', 'tuya-proxy')][string[]]$Funcoes = @('iot-gateway', 'notify-alert'),
  [switch]$Todas,
  [switch]$Sim,
  [switch]$DefinirSegredo,
  [ValidatePattern('^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$')][string]$OwnerId = '',
  [switch]$SoSegredos
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

if (-not (Test-NexusWindows)) {
  Write-NexusErro 'este script é para o Windows do PC de manutenção. Em outro sistema rode à mão: supabase functions deploy iot-gateway --project-ref gfjxcsvxhaojbtuixpjh --no-verify-jwt'
  exit 1
}

$semJwt = @('iot-gateway', 'notify-alert')
$ref = $script:NexusProjetoRef

try {
  if ($Todas) { $Funcoes = @('iot-gateway', 'notify-alert', 'smartthings-proxy', 'tuya-proxy') }
  $repo = Split-Path -Parent $PSScriptRoot
  foreach ($f in $Funcoes) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo "supabase\functions\$f\index.ts"))) { throw "não achei supabase\functions\$f\index.ts no repositório ($repo)." }
  }

  $cmd = Get-Command supabase -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) {
    throw ('Supabase CLI não encontrado. Instale com:  winget install Supabase.CLI   (ou: npm i -g supabase)' +
           ' — depois feche e reabra o PowerShell.')
  }
  $sb = $cmd.Path
  Write-Host "Supabase CLI: $sb"

  # ---- logado? (só o código de saída importa; a lista de projetos não é mostrada) ----
  $teste = Invoke-NexusNativo -Exe $sb -Argumentos @('projects', 'list') -Silencioso
  if ($teste.Codigo -ne 0) {
    Write-NexusAviso 'Você não está logado no Supabase CLI.'
    Write-Host '  O login abre o navegador; nenhuma senha passa por este script.'
    if ($WhatIfPreference) { Write-Host '  (WhatIf: rodaria "supabase login")' }
    elseif ($Sim -or (Confirm-Nexus 'Rodar "supabase login" agora?')) {
      & $sb login
      if ($LASTEXITCODE -ne 0) { throw 'o login não terminou. Rode "supabase login" e depois este script de novo.' }
    } else { throw 'rode "supabase login" e depois este script de novo.' }
  }

  # ---- secrets (opcional): lidos aqui dentro — nunca na linha de comando, no histórico ou na tela ----
  $valores = [ordered]@{}
  if ($DefinirSegredo) {
    if ($WhatIfPreference) { Write-Host '  (WhatIf: pediria o IOT_DEVICE_SECRET sem eco e gravaria com "supabase secrets set --env-file <temporário>")' }
    else {
      $s1 = Read-NexusSegredo 'IOT_DEVICE_SECRET (o mesmo DEVICE_SECRET das placas; não aparece na tela)'
      if (-not $s1) { throw 'segredo vazio (ou sem console para digitar). Nada foi alterado.' }
      $s2 = Read-NexusSegredo 'Digite de novo para conferir'
      if ($s1 -cne $s2) { $s1 = $null; $s2 = $null; throw 'os dois valores digitados não são iguais. Nada foi alterado.' }
      $valores['IOT_DEVICE_SECRET'] = $s1
      $s1 = $null; $s2 = $null
    }
  }
  if ($OwnerId) { $valores['IOT_OWNER_ID'] = $OwnerId.ToLower() }
  if ($valores.Count -gt 0 -and $PSCmdlet.ShouldProcess("projeto $ref", "supabase secrets set $(@($valores.Keys) -join ', ')")) {
    Write-NexusPasso "Gravando $(@($valores.Keys) -join ' e ') no Supabase (os valores não aparecem)..."
    $cod = Set-NexusSupabaseSegredos -Supabase $sb -Ref $ref -Valores $valores
    $valores = $null
    if ($cod -ne 0) { throw "o supabase secrets set falhou (código $cod). Nada foi publicado." }
    Write-NexusOk '  secrets gravados (as funções passam a usar os valores novos sem precisar publicar de novo).'
  }
  if ($SoSegredos) {
    if (-not $DefinirSegredo -and -not $OwnerId) { throw '-SoSegredos sem -DefinirSegredo nem -OwnerId: nada a fazer.' }
    exit 0
  }

  $falhas = @()
  Push-Location -LiteralPath $repo
  try {
    foreach ($f in $Funcoes) {
      $a = @('functions', 'deploy', $f, '--project-ref', $ref)
      if ($semJwt -contains $f) { $a += '--no-verify-jwt' }
      if (-not $PSCmdlet.ShouldProcess("$f (projeto $ref)", "supabase $($a -join ' ')")) { continue }
      Write-NexusPasso "Publicando $f..."
      $r = Invoke-NexusNativo -Exe $sb -Argumentos ($a + '--use-api')
      if ($r.Codigo -ne 0 -and $r.Saida -match 'unknown flag|flag provided but not defined') {
        Write-Host '  (CLI antigo: tentando sem --use-api; precisa do Docker Desktop aberto)'
        $r = Invoke-NexusNativo -Exe $sb -Argumentos $a
      }
      if ($r.Codigo -ne 0) { $falhas += $f; Write-NexusErro "falha ao publicar $f (código $($r.Codigo))." }
      else { Write-NexusOk "  $f publicada." }
    }
  } finally { Pop-Location }

  if ($WhatIfPreference) { exit 0 }

  if ($Funcoes -contains 'iot-gateway' -and $falhas -notcontains 'iot-gateway') {
    $h = Invoke-NexusHttp -Url "$($script:NexusGatewayUrl)/health"
    if ($h.Status -eq 200) { Write-NexusOk 'iot-gateway respondendo (/health ok).' }
    else { Write-NexusAviso "o /health respondeu $($h.Status). Confira em supabase.com > Edge Functions > iot-gateway > Logs." }
  }

  if (-not $DefinirSegredo) {
    Write-Host ''
    Write-Host 'Lembrete: os segredos ficam só no Supabase. Se ainda não configurou, rode:' -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -DefinirSegredo -OwnerId <uuid-do-dono> -SoSegredos'
    Write-Host '  (o IOT_DEVICE_SECRET é digitado sem aparecer; não use "supabase secrets set NOME=valor" no console:'
    Write-Host '   a linha fica no histórico do PowerShell. Nunca cole o segredo em chat, e-mail ou commit)'
  }

  if ($falhas.Count -gt 0) { throw "não publicadas: $($falhas -join ', ')" }
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}

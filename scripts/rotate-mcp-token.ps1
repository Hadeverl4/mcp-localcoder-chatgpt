# One-time, owner-approved rotation. No token or authenticated endpoint is printed.
param(
  [Parameter(Mandatory=$true)][int]$ExpectedPid,
  [switch]$Preflight
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repo '.env'
$stateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTLocalCoder'
$statusPath = Join-Path $stateDir 'MCP-TOKEN-ROTATION-STATUS.txt'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Write-State([string]$Message) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [IO.File]::WriteAllText($statusPath, "$stamp | $Message" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Get-Owner {
  $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $ExpectedPid })
  if ($listener.Count -eq 0) { throw 'expected MCP listener not present' }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
  if (-not $proc -or $proc.Name -ine 'node.exe' -or $proc.CommandLine -notmatch 'dist[/\\]index\.js') {
    throw 'unexpected MCP process ownership'
  }
  return $proc
}

function Free-Port {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Http-Status([string]$Url) {
  try {
    $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return [int]$res.StatusCode
  } catch [Net.WebException] {
    if ($null -ne $_.Exception.Response) {
      return [int]$_.Exception.Response.StatusCode
    }
    return 0
  } catch {
    return 0
  }
}

function Wait-Health([int]$Port,[int]$ProcessId,[int]$WaitSeconds) {
  $end = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $end) {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
      $keys = @($health.PSObject.Properties.Name | Sort-Object)
      if ($health.status -eq 'ok' -and $keys.Count -eq 2 -and
          $keys[0] -eq 'name' -and $keys[1] -eq 'status') { return $true }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  return $false
}

Set-Location -LiteralPath $repo
$null = Get-Owner
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw 'missing .env' }
if (-not (Test-Path '.\dist\index.js')) { throw 'missing built server' }
$lines = [IO.File]::ReadAllLines($envPath)
$indices = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*MCP_TOKEN\s*=') { $indices += $i }
}
if ($indices.Count -ne 1) { throw 'MCP_TOKEN must occur exactly once' }
$oldToken = (($lines[$indices[0]] -split '=',2)[1]).Trim().Trim('"').Trim("'")
if ($oldToken.Length -lt 16) { throw 'invalid existing MCP token' }

if ($Preflight) {
  Write-Output 'ROTATION_PREFLIGHT_PASS: expected process, .env, build, and one token verified'
  return
}

$stage = $null
$live = $null
$tokenWasWritten = $false
try {
  $entropy = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($entropy) } finally { $rng.Dispose() }
  $newToken = [Convert]::ToBase64String($entropy).TrimEnd('=').Replace('+','-').Replace('/','_')
  if ($newToken -eq $oldToken -or $newToken.Length -lt 60) { throw 'new token entropy failure' }

  # Smoke test the new token and patched code on two temporary loopback ports.
  $tempPort = Free-Port
  $tempAdminPort = Free-Port
  while ($tempAdminPort -eq $tempPort -or $tempPort -in @(3000,3001) -or $tempAdminPort -in @(3000,3001)) {
    $tempPort = Free-Port
    $tempAdminPort = Free-Port
  }
  $env:MCP_TOKEN = $newToken
  $env:HOST = '127.0.0.1'
  $env:PORT = "$tempPort"
  $env:ADMIN_PORT = "$tempAdminPort"
  $stage = Start-Process -FilePath $nodeExe -ArgumentList 'dist/index.js' -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'mcp-rotation-stage.stdout.log') -RedirectStandardError (Join-Path $stateDir 'mcp-rotation-stage.stderr.log')
  if (-not (Wait-Health -Port $tempPort -ProcessId $stage.Id -WaitSeconds 25)) { throw 'staged MCP failed minimal-health smoke test' }
  $url = "http://127.0.0.1:$tempPort"
  if ((Http-Status "$url/mcp/$newToken") -ne 400 -or (Http-Status "$url/mcp/$oldToken") -ne 404) {
    throw 'staged new/old-token authorization verification failed'
  }
  Stop-Process -Id $stage.Id -Force -ErrorAction Stop
  Wait-Process -Id $stage.Id -Timeout 10 -ErrorAction SilentlyContinue
  $stage = $null

  # Rotate on disk without storing a backup copy of the compromised token.
  $lines[$indices[0]] = 'MCP_TOKEN="' + $newToken + '"'
  [IO.File]::WriteAllLines($envPath, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
  $tokenWasWritten = $true
  $lines = $null

  # The obsolete MCP token must never be restored as a rollback mechanism.
  Write-State 'ROTATED_ON_DISK; restart pending. If needed, retrieve MCP_TOKEN from project .env locally.'
  $null = Get-Owner
  Stop-Process -Id $ExpectedPid -Force -ErrorAction Stop
  Start-Sleep -Milliseconds 700

  $env:MCP_TOKEN = $newToken
  $env:PORT = '3000'
  $env:ADMIN_PORT = '3001'
  $live = Start-Process -FilePath $nodeExe -ArgumentList 'dist/index.js' -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'mcp-rotation-live.stdout.log') -RedirectStandardError (Join-Path $stateDir 'mcp-rotation-live.stderr.log')
  if (-not (Wait-Health -Port 3000 -ProcessId $live.Id -WaitSeconds 30)) { throw 'new MCP failed health check after restart' }
  $url = 'http://127.0.0.1:3000'
  $newStatus = Http-Status "$url/mcp/$newToken"
  $oldStatus = Http-Status "$url/mcp/$oldToken"
  $oldRootStatus = Http-Status "$url/$oldToken"
  if ($newStatus -ne 400 -or $oldStatus -ne 404 -or $oldRootStatus -ne 404) {
    throw 'post-rotation auth check failed'
  }
  Write-State 'ROTATION_PASS: health minimal; new MCP path accepted; BOTH old token routes rejected. Update the ChatGPT connector URL locally using MCP_TOKEN from .env.'
} catch {
  $kind = $_.Exception.GetType().Name
  if ($tokenWasWritten) {
    Write-State "ROTATED_BUT_RESTART_OR_VERIFY_FAILED ($kind). Old token remains retired. Check local logs and restart node from the project; do not restore the old token."
  } else {
    Write-State "ROTATION_FAILED_BEFORE_ENV_CHANGE ($kind). Live MCP may still be using the old token."
  }
  exit 1
} finally {
  if ($stage -and (Get-Process -Id $stage.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $stage.Id -Force -ErrorAction SilentlyContinue
  }
}

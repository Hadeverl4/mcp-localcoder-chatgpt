param(
    [string]$HostAlias = 'mcp-relay',
    [int]$RemotePort = 43000,
    [int]$LocalPort = 3000
)
$ErrorActionPreference = 'Stop'

$StateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTLocalCoderLauncher'
$PidFile = Join-Path $StateDir 'ubuntu-relay-ssh.pid'
$MetaFile = Join-Path $StateDir 'ubuntu-relay-ssh.json'
$HealthUrl = "http://127.0.0.1:$LocalPort/health"
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Test-LocalHealth {
    try {
        $raw = (& curl.exe --fail --silent --show-error --connect-timeout 2 --max-time 5 $HealthUrl 2>$null) -join "\n"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { return $false }
        return (($raw | ConvertFrom-Json -ErrorAction Stop).status -eq 'ok')
    } catch { return $false }
}

function Get-TrackedSsh {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $raw = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($raw -notmatch '^\d+$') { return $null }
    $pidValue = [int]$raw
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    if (-not $proc -or [IO.Path]::GetFileNameWithoutExtension($proc.ExecutablePath) -ne 'ssh') { return $null }
    $expected = ("-R 127.0.0.1:{0}:127.0.0.1:{1}" -f $RemotePort, $LocalPort)
    if ($proc.CommandLine -notlike "*$expected*" -or $proc.CommandLine -notlike "*$HostAlias*") { return $null }
    return $proc
}

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw 'ssh.exe not found.' }
if (-not (Test-LocalHealth)) { throw "Local MCP health is not OK at $HealthUrl." }

$tracked = Get-TrackedSsh
if ($tracked) {
    Write-Host "[OK] Ubuntu relay already running (PID $($tracked.ProcessId))." -ForegroundColor Green
    exit 0
}

& ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=6 $HostAlias "true"
if ($LASTEXITCODE -ne 0) { throw "SSH preflight failed for $HostAlias." }

& ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=yes $HostAlias "ss -lnt | grep -q '127.0.0.1:$RemotePort '"
if ($LASTEXITCODE -eq 0) {
    throw "Ubuntu relay port 127.0.0.1:$RemotePort is already in use by an untracked process."
}

$forwardSpec = ("127.0.0.1:{0}:127.0.0.1:{1}" -f $RemotePort, $LocalPort)
$args = @(
    '-N','-T',
    '-o','BatchMode=yes',
    '-o','StrictHostKeyChecking=yes',
    '-o','ExitOnForwardFailure=yes',
    '-o','ServerAliveInterval=15',
    '-o','ServerAliveCountMax=3',
    '-o','TCPKeepAlive=yes',
    '-R',$forwardSpec,
    $HostAlias
)

$proc = Start-Process ssh.exe -ArgumentList $args -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
if ($proc.HasExited) { throw "Reverse SSH exited immediately (exit $($proc.ExitCode))." }

$remoteHealth = & ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=yes $HostAlias "curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:$RemotePort/health"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($remoteHealth -join ''))) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "Ubuntu cannot reach MCP through 127.0.0.1:$RemotePort."
}

Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ASCII
[IO.File]::WriteAllText(
    $MetaFile,
    (@{
        version = 1
        pid = $proc.Id
        host = $HostAlias
        remote_port = $RemotePort
        local_port = $LocalPort
        started_at = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json),
    (New-Object Text.UTF8Encoding($false))
)

Write-Host '[OK] Ubuntu reverse SSH relay is live.' -ForegroundColor Green
Write-Host "Windows MCP: 127.0.0.1:$LocalPort"
Write-Host "Ubuntu relay: 127.0.0.1:$RemotePort"
Write-Host "SSH PID: $($proc.Id)"

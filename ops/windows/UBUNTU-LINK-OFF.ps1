param(
    [string]$HostAlias = 'mcp-relay',
    [int]$RemotePort = 43000,
    [int]$LocalPort = 3000
)
$ErrorActionPreference = 'Stop'

$StateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTLocalCoderLauncher'
$PidFile = Join-Path $StateDir 'ubuntu-relay-ssh.pid'
$MetaFile = Join-Path $StateDir 'ubuntu-relay-ssh.json'

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host '[OK] Ubuntu relay is already off.' -ForegroundColor Green
    exit 0
}

$raw = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
if ($raw -notmatch '^\d+$') { throw "Invalid relay PID file: $PidFile" }

$pidValue = [int]$raw
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
if ($proc) {
    if ([IO.Path]::GetFileNameWithoutExtension($proc.ExecutablePath) -ne 'ssh') {
        throw "Safety stop: tracked PID $pidValue is not ssh.exe."
    }
    $expected = ("-R 127.0.0.1:{0}:127.0.0.1:{1}" -f $RemotePort, $LocalPort)
    if ($proc.CommandLine -notlike "*$expected*" -or $proc.CommandLine -notlike "*$HostAlias*") {
        throw "Safety stop: PID $pidValue does not match expected relay."
    }
    Stop-Process -Id $pidValue -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 500
}

Remove-Item -LiteralPath $PidFile, $MetaFile -Force -ErrorAction SilentlyContinue
Write-Host '[OK] Ubuntu reverse SSH relay is OFF.' -ForegroundColor Green

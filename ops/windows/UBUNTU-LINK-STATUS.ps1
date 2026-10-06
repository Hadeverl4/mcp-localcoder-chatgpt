param(
    [string]$HostAlias = 'mcp-relay',
    [int]$RemotePort = 43000,
    [int]$LocalPort = 3000
)
$ErrorActionPreference = 'Continue'

$StateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTLocalCoderLauncher'
$PidFile = Join-Path $StateDir 'ubuntu-relay-ssh.pid'
$pidValue = $null
if (Test-Path -LiteralPath $PidFile) {
    $raw = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($raw -match '^\d+$') { $pidValue = [int]$raw }
}

$localOk = $false
try {
    $health = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health" -TimeoutSec 4
    $localOk = ($health.status -eq 'ok')
} catch {}

$sshOk = $false
if ($pidValue) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    if ($proc -and [IO.Path]::GetFileNameWithoutExtension($proc.ExecutablePath) -eq 'ssh') {
        $expected = ("-R 127.0.0.1:{0}:127.0.0.1:{1}" -f $RemotePort, $LocalPort)
        $sshOk = ($proc.CommandLine -like "*$expected*" -and $proc.CommandLine -like "*$HostAlias*")
    }
}

& ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 $HostAlias "curl -fsS --connect-timeout 2 --max-time 4 http://127.0.0.1:$RemotePort/health >/dev/null"
$remoteOk = ($LASTEXITCODE -eq 0)

Write-Host ("Local MCP:      " + $(if($localOk){'OK'}else{'DOWN'}))
Write-Host ("Reverse SSH:    " + $(if($sshOk){'ON'}else{'OFF'}) + $(if($pidValue){" (PID $pidValue)"}else{''}))
Write-Host ("Ubuntu relay:   " + $(if($remoteOk){'OK'}else{'DOWN'}))
if ($localOk -and $sshOk -and $remoteOk) { exit 0 } else { exit 1 }

param(
    [string]$HostAlias = 'mcp-relay',
    [string]$HomeLanHost = '',
    [string]$HomeLanPrefix = '',
    [int]$RemotePort = 43000,
    [int]$LocalPort = 3000
)
$ErrorActionPreference = 'Stop'

$StateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTLocalCoderLauncher'
$PidFile = Join-Path $StateDir 'ubuntu-relay-ssh.pid'
$MetaFile = Join-Path $StateDir 'ubuntu-relay-ssh.json'
$RelayOutLog = Join-Path $StateDir 'ubuntu-relay-ssh.out.log'
$RelayErrLog = Join-Path $StateDir 'ubuntu-relay-ssh.err.log'
$HealthUrl = "http://127.0.0.1:$LocalPort/health"
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$SshTransport = 'tailscale'
$SshHostOverride = $null

function Invoke-BoundedSsh {
    param(
        [string]$HostNameOverride,
        [string[]]$RemoteArgs,
        [int]$TimeoutMs = 7000
    )

    $args = @('-n', '-T')
    if (-not [string]::IsNullOrWhiteSpace($HostNameOverride)) {
        $args += @('-o', "HostName=$HostNameOverride")
    }
    $args += @(
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=3',
        '-o', 'ConnectionAttempts=1',
        $HostAlias
    )
    if ($RemoteArgs) { $args += $RemoteArgs }

    # Use .NET Process directly. Start-Process -PassThru with redirected
    # stdout/stderr can return a null ExitCode even after WaitForExit() on
    # Windows PowerShell 5.1. Casting that null to [int] made exit 1 from
    # grep look like exit 0 (false "remote port is occupied").
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Command ssh.exe -ErrorAction Stop).Source
    $startInfo.Arguments = $args -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $startInfo
    try {
        if (-not $proc.Start()) { throw "Could not start bounded SSH probe." }
        if (-not $proc.WaitForExit($TimeoutMs)) {
            try { $proc.Kill() } catch {}
            try { [void]$proc.WaitForExit(1000) } catch {}
            return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Output = ''; Error = 'SSH probe timed out' }
        }

        $output = $proc.StandardOutput.ReadToEnd()
        $errorText = $proc.StandardError.ReadToEnd()
        return [pscustomobject]@{
            ExitCode = $proc.ExitCode
            TimedOut = $false
            Output = [string]$output
            Error = [string]$errorText
        }
    }
    finally {
        $proc.Dispose()
    }
}

function Test-HomeLanAddress {
    # Empty LAN settings mean use the SSH alias only (portable default).
    if ([string]::IsNullOrWhiteSpace($HomeLanHost) -or [string]::IsNullOrWhiteSpace($HomeLanPrefix)) { return $false }
    try {
        return [bool](@(
            Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                Where-Object {
                    $_.IPAddress -like "$HomeLanPrefix*" -and
                    $_.IPAddress -ne $HomeLanHost
                }
        ).Count)
    } catch {
        return $false
    }
}

function Test-HomeLanSsh {
    if (-not (Test-HomeLanAddress)) { return $false }
    try {
        $probe = Invoke-BoundedSsh -HostNameOverride $HomeLanHost -RemoteArgs @('true') -TimeoutMs 5000
        return (-not $probe.TimedOut -and $probe.ExitCode -eq 0)
    } catch {
        return $false
    }
}

function Select-SshTransport {
    if (Test-HomeLanSsh) {
        $script:SshTransport = 'lan'
        $script:SshHostOverride = $HomeLanHost
        Write-Host "[NETWORK] Home LAN detected and verified." -ForegroundColor Green
        Write-Host "[TRANSPORT] Using direct LAN SSH -> $HomeLanHost" -ForegroundColor Green
        return
    }

    $script:SshTransport = 'tailscale'
    $script:SshHostOverride = $null
    Write-Host "[NETWORK] Home LAN unavailable." -ForegroundColor DarkGray
    Write-Host "[TRANSPORT] Using Tailscale/SSH alias -> $HostAlias" -ForegroundColor Cyan
}

function Get-ProcessTransport($Process) {
    if (-not $Process) { return 'unknown' }
    if ($HomeLanHost -and $Process.CommandLine -like "*HostName=$HomeLanHost*") { return 'lan' }
    return 'tailscale'
}

function Test-LocalHealth {
    try {
        $raw = (& curl.exe --fail --silent --show-error --connect-timeout 2 --max-time 5 $HealthUrl 2>$null) -join "\n"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { return $false }
        return (($raw | ConvertFrom-Json -ErrorAction Stop).status -eq 'ok')
    } catch { return $false }
}

function Test-SshPreflight {
    try {
        $probe = Invoke-BoundedSsh -HostNameOverride $SshHostOverride -RemoteArgs @('true') -TimeoutMs 6000
        return (-not $probe.TimedOut -and $probe.ExitCode -eq 0)
    } catch {
        return $false
    }
}

function Wait-SshPreflight([int]$Attempts = 8, [int]$DelayMs = 1250) {
    for ($i = 1; $i -le $Attempts; $i++) {
        if (Test-SshPreflight) { return $true }
        if ($i -eq 1) {
            Write-Host "[WAIT] SSH path to $HostAlias is not ready yet; waiting for network/Tailscale convergence..." -ForegroundColor Yellow
        }
        if ($i -lt $Attempts) { Start-Sleep -Milliseconds $DelayMs }
    }
    return $false
}

function Test-RemoteRelayHealth {
    try {
        $probe = Invoke-BoundedSsh -HostNameOverride $SshHostOverride -RemoteArgs @('curl','-fsS','--connect-timeout','2','--max-time','4',"http://127.0.0.1:$RemotePort/health") -TimeoutMs 7000
        if ($probe.TimedOut -or $probe.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($probe.Output)) { return $false }
        return (($probe.Output | ConvertFrom-Json -ErrorAction Stop).status -eq 'ok')
    } catch {
        return $false
    }
}

function Wait-RemoteRelayHealth([int]$Attempts = 6, [int]$DelayMs = 750) {
    for ($i = 1; $i -le $Attempts; $i++) {
        if (Test-RemoteRelayHealth) { return $true }
        if ($i -lt $Attempts) { Start-Sleep -Milliseconds $DelayMs }
    }
    return $false
}

function Test-RemoteRelayPortInUse {
    # Do not interpret failed/unknown SSH probes as either busy or free.
    # Get ss output and inspect the *local address* column instead of
    # depending on the exit code of an SSH-side grep pipeline.
    $probe = Invoke-BoundedSsh -HostNameOverride $SshHostOverride -RemoteArgs @('ss','-lnt') -TimeoutMs 6000
    if ($probe.TimedOut -or $probe.ExitCode -ne 0) {
        throw "Could not check Ubuntu listening ports (SSH exit $($probe.ExitCode)): $($probe.Error)"
    }
    $pattern = ('(?m)^\s*LISTEN\s+\S+\s+\S+\s+\S+:{0}(?=\s|$)' -f $RemotePort)
    return [bool]($probe.Output -match $pattern)
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

function Get-RelaySshCandidates {
    $expected = ("-R 127.0.0.1:{0}:127.0.0.1:{1}" -f $RemotePort, $LocalPort)
    return @(
        Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                [IO.Path]::GetFileNameWithoutExtension($_.ExecutablePath) -eq 'ssh' -and
                $_.CommandLine -like "*$expected*" -and
                $_.CommandLine -like "*$HostAlias*"
            }
    )
}

function Clear-RelayState {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $MetaFile -Force -ErrorAction SilentlyContinue
}

function Save-RelayState($Process) {
    Set-Content -LiteralPath $PidFile -Value $Process.ProcessId -Encoding ASCII
    [IO.File]::WriteAllText(
        $MetaFile,
        (@{
            version = 1
            pid = [int]$Process.ProcessId
            host = $HostAlias
            transport = $SshTransport
            ssh_host = $(if ($SshHostOverride) { $SshHostOverride } else { $HostAlias })
            remote_port = $RemotePort
            local_port = $LocalPort
            started_at = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json),
        (New-Object Text.UTF8Encoding($false))
    )
}

function Wait-RemoteRelayPortFree([int]$Seconds = 10) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-RemoteRelayPortInUse)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (-not (Test-RemoteRelayPortInUse))
}

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw 'ssh.exe not found.' }
if (-not (Test-LocalHealth)) { throw "Local MCP health is not OK at $HealthUrl." }

Select-SshTransport

if (-not (Wait-SshPreflight 8 1250)) {
    throw "SSH preflight failed for $HostAlias after bounded retries. Existing relay was left untouched."
}

$tracked = Get-TrackedSsh
if ($tracked) {
    $trackedTransport = Get-ProcessTransport $tracked
    if ($trackedTransport -ne $SshTransport) {
        $stalePid = [int]$tracked.ProcessId
        Write-Host "[SWITCH] Relay transport is $trackedTransport; preferred path is $SshTransport." -ForegroundColor Yellow
        Write-Host "[SWITCH] Rebuilding only tracked relay PID $stalePid on the preferred path..." -ForegroundColor Yellow
        Stop-Process -Id $stalePid -Force -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $deadline -and (Get-Process -Id $stalePid -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 250
        }
        if (Get-Process -Id $stalePid -ErrorAction SilentlyContinue) {
            throw "Tracked reverse SSH PID $stalePid did not exit during transport switch."
        }
        Clear-RelayState
        if (-not (Wait-RemoteRelayPortFree 20)) {
            throw "Ubuntu relay port 127.0.0.1:$RemotePort stayed busy during transport switch."
        }
        $tracked = $null
    }
}

if ($tracked) {
    if (Wait-RemoteRelayHealth 5 750) {
        Write-Host "[OK] Ubuntu relay already running and healthy via $SshTransport (PID $($tracked.ProcessId))." -ForegroundColor Green
        exit 0
    }

    $stalePid = [int]$tracked.ProcessId
    Write-Host "[REPAIR] Tracked reverse SSH PID $stalePid is alive but Ubuntu relay health failed." -ForegroundColor Yellow
    Write-Host "[REPAIR] Stopping only the tracked relay process and rebuilding it..." -ForegroundColor Yellow
    Stop-Process -Id $stalePid -Force -ErrorAction Stop

    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $stalePid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $stalePid -ErrorAction SilentlyContinue) {
        throw "Tracked reverse SSH PID $stalePid did not exit."
    }

    Clear-RelayState
    if (-not (Wait-RemoteRelayPortFree 20)) {
        throw "Ubuntu relay port 127.0.0.1:$RemotePort stayed busy after the tracked relay stopped. Refusing to kill any untracked process."
    }
}

$candidates = @(Get-RelaySshCandidates)
if ($candidates.Count -eq 1) {
    if (Wait-RemoteRelayHealth 5 750) {
        Save-RelayState $candidates[0]
        Write-Host "[OK] Adopted healthy reverse SSH relay PID $($candidates[0].ProcessId) into launcher state." -ForegroundColor Green
        exit 0
    }
    throw "Found one matching but untracked reverse SSH PID $($candidates[0].ProcessId), and relay health is down. Refusing to kill an untracked process."
}
if ($candidates.Count -gt 1) {
    throw "Found multiple matching reverse SSH processes. Refusing to guess which process is launcher-owned."
}

if (Test-RemoteRelayPortInUse) {
    if (Wait-RemoteRelayHealth 2 500) {
        throw "Ubuntu relay 127.0.0.1:$RemotePort is healthy but not owned by the tracked PID. Refusing to replace an untracked relay."
    }
    Write-Host "[WAIT] Ubuntu port $RemotePort is busy but relay health is down. Waiting up to 60s for a stale SSH listener to disappear..." -ForegroundColor Yellow
    if (-not (Wait-RemoteRelayPortFree 60)) {
        throw "Ubuntu relay port 127.0.0.1:$RemotePort is still held by an untracked process after 60s. No remote process was modified."
    }
    Write-Host "[RECOVER] Ubuntu relay port $RemotePort became free; creating a fresh reverse SSH link." -ForegroundColor Green
}

$forwardSpec = ("127.0.0.1:{0}:127.0.0.1:{1}" -f $RemotePort, $LocalPort)
$args = @(
    '-N','-T','-n',
    '-o','BatchMode=yes',
    '-o','StrictHostKeyChecking=yes',
    '-o','ExitOnForwardFailure=yes',
    '-o','ServerAliveInterval=15',
    '-o','ServerAliveCountMax=3',
    '-o','TCPKeepAlive=yes',
    '-R',$forwardSpec
)
if ($SshHostOverride) {
    $args += @('-o', "HostName=$SshHostOverride")
}
$args += $HostAlias

Remove-Item -LiteralPath $RelayOutLog,$RelayErrLog -Force -ErrorAction SilentlyContinue
$proc = Start-Process ssh.exe `
    -ArgumentList $args `
    -WindowStyle Hidden `
    -RedirectStandardOutput $RelayOutLog `
    -RedirectStandardError $RelayErrLog `
    -PassThru
Start-Sleep -Seconds 2
if ($proc.HasExited) { throw "Reverse SSH exited immediately (exit $($proc.ExitCode))." }

if (-not (Wait-RemoteRelayHealth 10 750)) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Clear-RelayState
    throw "Ubuntu cannot reach MCP through 127.0.0.1:$RemotePort."
}

Save-RelayState ([pscustomobject]@{ ProcessId = $proc.Id })

Write-Host '[OK] Ubuntu reverse SSH relay is live.' -ForegroundColor Green
Write-Host "Transport: $SshTransport"
Write-Host "Windows MCP: 127.0.0.1:$LocalPort"
Write-Host "Ubuntu relay: 127.0.0.1:$RemotePort"
Write-Host "SSH PID: $($proc.Id)"

param(
    [Parameter(Position=0)]
    [ValidateSet("status","lock","readonly","arm")]
    [string]$Action = "status",
    [int]$Minutes = 60,
    [int]$IdleMinutes = 10
)

$ErrorActionPreference = "Stop"

$root = Join-Path $env:LOCALAPPDATA "ChatGPTLocalCoder\OwnerGuard"
$statePath = Join-Path $root "owner-lock.json"

function Get-Identity {
    $sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    return @{
        machine = $env:COMPUTERNAME
        user = $env:USERNAME
        sid = $sid
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    try { return Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Write-State([string]$Mode, [int]$TtlMinutes, [int]$MaxIdleMinutes) {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $id = Get-Identity
    $now = [DateTime]::UtcNow
    $expires = $null
    $armedAt = $null
    if ($Mode -eq "armed") {
        if ($TtlMinutes -lt 1 -or $TtlMinutes -gt 480) { throw "Minutes must be between 1 and 480." }
        if ($MaxIdleMinutes -lt 1 -or $MaxIdleMinutes -gt 240) { throw "IdleMinutes must be between 1 and 240." }
        $armedAt = $now.ToString("o")
        $expires = $now.AddMinutes($TtlMinutes).ToString("o")
    }

    $state = [ordered]@{
        version = 1
        mode = $Mode
        machine = $id.machine
        user = $id.user
        sid = $id.sid
        armed_at = $armedAt
        expires_at = $expires
        max_idle_minutes = $MaxIdleMinutes
    }

    $json = $state | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($statePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Owner Guard: $Mode" -ForegroundColor Green
    if ($expires) {
        Write-Host "Expires (UTC): $expires"
        Write-Host "Auto-demote after local idle: $MaxIdleMinutes minute(s)"
    }
    Write-Host "State: $statePath"
}

switch ($Action) {
    "lock" { Write-State "locked" 0 $IdleMinutes; break }
    "readonly" { Write-State "readonly" 0 $IdleMinutes; break }
    "arm" { Write-State "armed" $Minutes $IdleMinutes; break }
    default {
        $state = Read-State
        if (-not $state) {
            Write-Host "Owner Guard: LOCKED (no state; fail-closed)" -ForegroundColor Yellow
            Write-Host "State: $statePath"
            exit 0
        }
        Write-Host ("Owner Guard: " + $state.mode.ToUpperInvariant())
        Write-Host ("Machine: " + $state.machine)
        Write-Host ("User: " + $state.user)
        if ($state.expires_at) { Write-Host ("Expires (UTC): " + $state.expires_at) }
        Write-Host ("Max idle: " + $state.max_idle_minutes + " minute(s)")
        Write-Host ("State: " + $statePath)
    }
}

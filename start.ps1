# Script khởi động Codex MCP Server trên Windows (foreground, xem log trực tiếp)
param(
    [string]$Workspace,
    [int]$Port = 3000,
    [switch]$Force,
    [switch]$OpenUI
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Get-PortOwnerPid([int]$TargetPort) {
    $lines = netstat -ano | Select-String ":$TargetPort\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
        $processId = [int]$parts[-1]
        if ($processId -gt 0) { return $processId }
    }
    return $null
}

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path ".env")) { return $null }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $line = [System.IO.File]::ReadAllLines((Join-Path $ScriptDir ".env"), $utf8) | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1

    if (-not $line) { return $null }

    $value = ($line -split "=", 2)[1].Trim()
    return $value.Trim("'").Trim('"')
}

function Set-DotEnvValue([string]$Name, [string]$Value) {
    $envPath = Join-Path $ScriptDir ".env"
    if (-not (Test-Path $envPath)) {
        Copy-Item (Join-Path $ScriptDir ".env.example") $envPath
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $lines = @([System.IO.File]::ReadAllLines($envPath, $utf8))
    $escapedValue = $Value.Replace('"', '\"')
    $replacement = $Name + "=" + [char]34 + $escapedValue + [char]34
    $matched = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ("^\s*" + [regex]::Escape($Name) + "\s*=") -and -not $lines[$i].TrimStart().StartsWith("#")) {
            $lines[$i] = $replacement
            $matched = $true
            break
        }
    }

    if (-not $matched) {
        $lines += $replacement
    }

    [System.IO.File]::WriteAllLines($envPath, [string[]]$lines, $utf8)
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Da tao file .env" -ForegroundColor Yellow
}

if (-not $Workspace) {
    $Workspace = $env:WORKSPACE_PATH
}

if (-not $Workspace) {
    $Workspace = Get-DotEnvValue "WORKSPACE_PATH"
}

$PortableWorkspace = Split-Path -Parent $ScriptDir
if (-not $Workspace -or -not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    if ($Workspace) {
        Write-Host "[PORTABLE] Workspace cu khong ton tai: $Workspace" -ForegroundColor Yellow
    }
    $Workspace = $PortableWorkspace
    Set-DotEnvValue "WORKSPACE_PATH" $Workspace
    Write-Host "[PORTABLE] Workspace da tu dong chuyen sang: $Workspace" -ForegroundColor Green
} else {
    $Workspace = [System.IO.Path]::GetFullPath($Workspace)
}

$ChatGptAutoApprove = Get-DotEnvValue "CHATGPT_AUTO_APPROVE"

$PortableRuntime = Get-DotEnvValue "PORTABLE_MACHINE_RUNTIME"
if (-not $PortableRuntime) { $PortableRuntime = "true" }
if ($PortableRuntime -notmatch '^(0|false|no|off)$') {
    $machineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
    $machineSlug = ($machineName -replace '[^A-Za-z0-9._-]', '_')
    if (-not $machineSlug) { $machineSlug = "windows-machine" }
    $runtimeRoot = Join-Path $ScriptDir (".runtime\" + $machineSlug)
    $env:MCP_SHELL_STATE_DIR = Join-Path $runtimeRoot "state"
    $env:MCP_PROCESS_STATE_DIR = Join-Path $runtimeRoot "processes"
    $env:CHECKPOINT_PATH = Join-Path $runtimeRoot "checkpoints"
    $env:AUDIT_LOG_PATH = Join-Path $runtimeRoot "audit.log"
}

$env:WORKSPACE_PATH = $Workspace
$env:PORT = $Port
if ($ChatGptAutoApprove) {
    $env:CHATGPT_AUTO_APPROVE = $ChatGptAutoApprove
}

Write-Host ""
Write-Host "=== Codex MCP Server ===" -ForegroundColor Cyan
Write-Host "Default cwd: $Workspace"
Write-Host "Full machine access: ON"
if ($ChatGptAutoApprove) { Write-Host "ChatGPT auto-approve: $ChatGptAutoApprove" }
$AdminPort = Get-DotEnvValue "ADMIN_PORT"
if (-not $AdminPort) { $AdminPort = "3001" }
$env:ADMIN_PORT = $AdminPort

Write-Host "Port: $Port"
Write-Host "Admin UI: http://127.0.0.1:$AdminPort/ui"
if ($env:MCP_SHELL_STATE_DIR) { Write-Host "Machine runtime: $env:MCP_SHELL_STATE_DIR" }
Write-Host ""

if ($env:OPEN_UI -eq "1" -or $OpenUI) {
    Start-Process "http://127.0.0.1:$AdminPort/ui"
}

$existingPid = Get-PortOwnerPid -TargetPort $Port
if ($existingPid) {
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }

    Write-Host "[CANH BAO] Port $Port dang duoc dung boi PID $existingPid ($procName)" -ForegroundColor Yellow

    if ($Force) {
        Write-Host "Dang tat process cu (Force)..." -ForegroundColor Yellow
        Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } else {
        $answer = Read-Host "Dung server cu va chay lai? (y/n)"
        if ($answer -match '^[yY]') {
            Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } else {
            Write-Host "Huy. Server cu van dang chay tai http://localhost:$Port" -ForegroundColor Red
            exit 1
        }
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js chua duoc cai. Can Node.js 18+." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm chua duoc cai." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Dependencies chua co - dang chay npm ci..." -ForegroundColor Yellow
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm ci that bai!" -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path "dist/index.js")) {
    Write-Host "Building..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build that bai!" -ForegroundColor Red
        Read-Host "Nhan Enter de dong"
        exit 1
    }
}

Write-Host "Khoi dong server (log hien ben duoi)..." -ForegroundColor Green
Write-Host "Nhan Ctrl+C de dung server" -ForegroundColor DarkGray
Write-Host ""

& node dist/index.js
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -ne 0) {
    Write-Host "Server loi (exit code: $exitCode)" -ForegroundColor Red
} else {
    Write-Host "Server da dung." -ForegroundColor Yellow
}

exit $exitCode
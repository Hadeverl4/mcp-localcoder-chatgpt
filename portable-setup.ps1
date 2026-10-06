# Prepare ChatGPT Local Coder after cloning/copying the workspace to another Windows machine.
param(
    [string]$Workspace,
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$Preview
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

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

function Require-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing '$Name'. $Hint"
    }
}

if (-not $Workspace) {
    # Expected portable layout:
    # ChatGPT Local\
    #   mcp-localcoder-chatgpt\
    #   <other projects/files>
    $Workspace = Split-Path -Parent $ScriptDir
}

$Workspace = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace does not exist: $Workspace"
}

$machineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
$machineSlug = ($machineName -replace '[^A-Za-z0-9._-]', '_')
if (-not $machineSlug) { $machineSlug = "windows-machine" }
$runtimeRoot = Join-Path $ScriptDir (".runtime\" + $machineSlug)

Write-Host ""
Write-Host "=== Portable MCP setup ===" -ForegroundColor Cyan
Write-Host "Repo:      $ScriptDir"
Write-Host "Workspace: $Workspace"
Write-Host "Machine:   $machineName"
Write-Host "Runtime:   $runtimeRoot"
Write-Host ""

if ($Preview) {
    Write-Host "Preview only - no files or dependencies changed." -ForegroundColor Yellow
    exit 0
}

Require-Command "node" "Install Node.js 18+ first."
Require-Command "npm" "Install npm/Node.js first."

if (-not (Test-Path (Join-Path $ScriptDir ".env"))) {
    Copy-Item (Join-Path $ScriptDir ".env.example") (Join-Path $ScriptDir ".env")
    Write-Host "Created .env from .env.example"
}

# Preserve existing secrets/tunnel credentials. Only machine/path/performance settings are updated.
Set-DotEnvValue "WORKSPACE_PATH" $Workspace
Set-DotEnvValue "CHATGPT_TOOL_PROFILE" "fast"
Set-DotEnvValue "TOOL_RESULT_TEXT_MODE" "summary"
Set-DotEnvValue "MCP_RUN_COMMAND_SYNC_MS" "8000"
Set-DotEnvValue "MCP_COMPLETED_RESULT_CACHE" "true"
Set-DotEnvValue "MCP_CONTINUATION_HISTORY_MAX" "12"
Set-DotEnvValue "PORTABLE_MACHINE_RUNTIME" "true"
Set-DotEnvValue "OWNER_GUARD_ENABLED" "true"

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

if (-not $SkipInstall) {
    Write-Host "Installing exact dependencies from package-lock.json..." -ForegroundColor Yellow
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
}

if (-not $SkipBuild) {
    Write-Host "Building TypeScript..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
}

Write-Host ""
Write-Host "Portable setup complete." -ForegroundColor Green
Write-Host "Existing MCP_TOKEN / tunnel credentials were preserved."
Write-Host "Run: .\start.ps1"

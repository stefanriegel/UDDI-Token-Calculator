# UDDI Token Calculator — Windows Installer
# Usage: irm https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.ps1 | iex
# Or:   .\install.ps1 -Channel dev

[CmdletBinding()]
param(
    [ValidateSet('stable', 'dev')]
    [string]$Channel = 'stable'
)

$ErrorActionPreference = 'Stop'

$Repo = 'stefanriegel/UDDI-Token-Calculator'
$Binary = 'uddi-token-calculator'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs' $Binary

# Determine latest release tag
if ($Channel -eq 'stable') {
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
    $Tag = $release.tag_name
} else {
    $releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=20"
    $prerelease = $releases | Where-Object { $_.prerelease } | Select-Object -First 1
    if (-not $prerelease) {
        Write-Error "No dev pre-release found."
        exit 1
    }
    $Tag = $prerelease.tag_name
}

if (-not $Tag) {
    Write-Error "Failed to determine latest $Channel release."
    exit 1
}

$Asset = "${Binary}_windows_amd64.exe"
$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"

Write-Host "Downloading $Binary $Tag ($Channel) for Windows/amd64..." -ForegroundColor Cyan

# Download to temp
$TempFile = Join-Path $env:TEMP "$Binary.exe"
try {
    Invoke-WebRequest -Uri $Url -OutFile $TempFile -UseBasicParsing
} catch {
    Write-Error "Download failed. Check available assets at: https://github.com/$Repo/releases/tag/$Tag"
    exit 1
}

# Remove SmartScreen mark-of-the-web
Unblock-File $TempFile -ErrorAction SilentlyContinue

# Install
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$Destination = Join-Path $InstallDir "$Binary.exe"
Move-Item -Path $TempFile -Destination $Destination -Force

Write-Host "Installed $Binary $Tag ($Channel) to $Destination" -ForegroundColor Green

# Add to user PATH if not already present
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$UserPath;$InstallDir", 'User')
    Write-Host ""
    Write-Host "Added $InstallDir to your user PATH." -ForegroundColor Yellow
    Write-Host "Restart your terminal, then run: $Binary" -ForegroundColor Yellow
} else {
    Write-Host "Run '$Binary' to start." -ForegroundColor Green
}

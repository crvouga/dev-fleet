# Native Windows, PowerShell 5.1+. Download and run this file (not a bash script).
param([string]$WorkspaceDir = "$HOME\workspace")
$ErrorActionPreference = 'Stop'
$MiseVersion = '2026.10.24'
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), reopen PowerShell and rerun. WinGet is available through Microsoft App Installer.'
  }
  Invoke-Checked winget @('install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements')
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Reopen PowerShell and rerun to pick up Git on PATH.' }
}
$LocalRoot = Join-Path $PSScriptRoot '..'
if (Test-Path (Join-Path $LocalRoot 'mise.toml')) {
  $WorkspaceDir = (Resolve-Path $LocalRoot).Path
} else {
  if (-not (Test-Path (Join-Path $WorkspaceDir '.git'))) {
    Invoke-Checked git @('clone', 'https://github.com/crvouga/dev-fleet.git', $WorkspaceDir)
  }
  $Origin = & git -C $WorkspaceDir remote get-url origin
  if ($LASTEXITCODE -ne 0 -or $Origin -ne 'https://github.com/crvouga/dev-fleet.git') { throw "Unexpected checkout at $WorkspaceDir; choose an empty -WorkspaceDir." }
}
# The baseline uses Windows x64; ARM machines can use an x64 PowerShell/process.
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Use Windows x64 PowerShell. Native Windows ARM64 tool coverage is not yet validated.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  $Asset = "mise-v$MiseVersion-windows-x64.zip"
  $Base = "https://github.com/jdx/mise/releases/download/v$MiseVersion"
  Invoke-WebRequest "$Base/$Asset" -OutFile "$Temp\$Asset" -UseBasicParsing
  Invoke-WebRequest "$Base/SHASUMS256.txt" -OutFile "$Temp\SHASUMS256.txt" -UseBasicParsing
  $Line = Get-Content "$Temp\SHASUMS256.txt" | Where-Object { $_ -match ('\s+\./' + [regex]::Escape($Asset) + '$') }
  if (-not $Line) { throw 'Missing mise checksum.' }
  $Expected = ($Line -split '\s+')[0]
  if ((Get-FileHash "$Temp\$Asset" -Algorithm SHA256).Hash -ne $Expected) { throw 'mise checksum mismatch.' }
  Expand-Archive "$Temp\$Asset" -DestinationPath $Temp
  $Bin = "$HOME\.local\bin"
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  Copy-Item "$Temp\mise\bin\*.exe" $Bin -Force
  $env:Path = "$Bin;$env:Path"
  Set-Location $WorkspaceDir
  Invoke-Checked mise @('trust', $WorkspaceDir)
  Invoke-Checked mise @('install', '--locked', 'bun')
  Invoke-Checked mise @('exec', '--locked', 'bun', '--', 'bun', 'bootstrap/setup.ts')
} finally { Remove-Item $Temp -Recurse -Force }

<#
.SYNOPSIS
  Build, sign and package PhotoSuite for Windows.

.DESCRIPTION
  Produces, in $env:DIST (default: dist/release):
    photosuite-<version>-windows-<arch>.msi            per-machine installer (WiX v5)
    photosuite-<version>-windows-<arch>-portable.zip   photosuite.exe + photosuite-cli.exe + portable.txt

  The binaries link the C runtime statically (+crt-static), so neither the MSI nor the portable
  zip needs the Visual C++ redistributable. Signing is delegated to sign.ps1 (skipped with a
  warning when no signing secrets are set).

  Needs: Rust (MSVC toolchain + the target), the Windows SDK (rc.exe, signtool.exe),
  and WiX v5: dotnet tool install --global wix --version 5.0.2

.EXAMPLE
  pwsh packaging/windows/package.ps1 -Arch x64
  pwsh packaging/windows/package.ps1 -Arch x86 -SkipBuild
#>
param(
  [ValidateSet('x64', 'x86')] [string] $Arch = 'x64',
  [switch] $SkipBuild
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Invoke-Native([string] $What, [scriptblock] $Block) {
  Write-Output "==> $What"
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

# The version lives in one place: [workspace.package] version in the root Cargo.toml.
$Version = $env:PHOTOSUITE_VERSION
if (-not $Version) {
  $inPkg = $false
  foreach ($line in Get-Content (Join-Path $Root 'Cargo.toml')) {
    if ($line -match '^\s*\[') { $inPkg = ($line.Trim() -eq '[workspace.package]'); continue }
    if ($inPkg -and $line -match '^\s*version\s*=\s*"([^"]+)"') { $Version = $Matches[1]; break }
  }
}
if (-not $Version) { throw 'could not read [workspace.package] version from Cargo.toml' }
# MSI ProductVersion is numeric (major.minor.build); pre-release tags are dropped there.
$MsiVersion = ($Version -split '-')[0]

$Target = if ($Arch -eq 'x64') { 'x86_64-pc-windows-msvc' } else { 'i686-pc-windows-msvc' }
$Dist = if ($env:DIST) { $env:DIST } else { Join-Path $Root 'dist\release' }
$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Root 'target' }
New-Item -ItemType Directory -Force -Path $Dist | Out-Null

if (-not $env:PHOTOSUITE_BUILD_SHA) { $env:PHOTOSUITE_BUILD_SHA = (git -C $Root rev-parse HEAD 2>$null) }
if (-not $env:PHOTOSUITE_BUILD_DATE) { $env:PHOTOSUITE_BUILD_DATE = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }

Write-Output "PhotoSuite $Version for Windows $Arch ($Target)"

if (-not $SkipBuild) {
  # Static CRT: no VC++ redistributable needed. Scoped to the target so host build scripts and
  # proc-macros are unaffected.
  $flagVar = 'CARGO_TARGET_' + ($Target.ToUpper() -replace '-', '_') + '_RUSTFLAGS'
  [Environment]::SetEnvironmentVariable($flagVar, '-C target-feature=+crt-static')
  # Fail the build (rather than warn) if the icon/VERSIONINFO can't be embedded.
  $env:PHOTOSUITE_REQUIRE_WINRES = '1'
  Invoke-Native "cargo build ($Target)" { cargo build --release --locked -p photosuite -p photosuite-cli --target $Target }
}

$Bin = Join-Path $TargetDir "$Target\release"
$Stage = Join-Path $TargetDir "windows-package\$Arch"
Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item (Join-Path $Bin 'photosuite.exe'), (Join-Path $Bin 'photosuite-cli.exe') $Stage
# Bundled resources beside the exe: the same allowlist as SHIPPED_RESOURCES in packaging/env.sh.
foreach ($d in 'luts', 'lensfun', 'gradients', 'brushes', 'patterns', 'shapes') {
  New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'resources') | Out-Null
  Copy-Item -Recurse (Join-Path $Root "resources/$d") (Join-Path $Stage 'resources')
}

# Licences and notices, installed beside the exe.
$Notices = Join-Path $Stage 'notices'
New-Item -ItemType Directory -Force -Path $Notices | Out-Null
foreach ($f in 'README.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-CRATES.md') {
  $p = Join-Path $Root $f
  if (Test-Path $p) { Copy-Item $p $Notices }
}

& (Join-Path $PSScriptRoot 'sign.ps1') (Join-Path $Stage 'photosuite.exe') (Join-Path $Stage 'photosuite-cli.exe')

# ---- MSI ---------------------------------------------------------------------------------------
$Msi = Join-Path $Dist "photosuite-$Version-windows-$Arch.msi"
& (Join-Path $PSScriptRoot 'check-icons.ps1')
Invoke-Native 'wix build' {
  wix build (Join-Path $PSScriptRoot 'photosuite.wxs') -arch $Arch `
    -d "Version=$MsiVersion" -d "BinDir=$Stage" -d "IconPath=$(Join-Path $Root 'assets\app-icon\photosuite.ico')" `
    -o $Msi
}
Invoke-Native 'MSI shortcut icon validation (ICE50)' {
  wix msi validate $Msi -ice ICE50 -intermediateFolder (Join-Path $Stage 'msi-validation')
}
# wix writes its debug symbols (.wixpdb) next to the MSI; keep them out of the release assets.
Remove-Item -Force -ErrorAction SilentlyContinue ([IO.Path]::ChangeExtension($Msi, '.wixpdb'))
& (Join-Path $PSScriptRoot 'sign.ps1') $Msi

# ---- portable zip ------------------------------------------------------------------------------
$Portable = Join-Path $TargetDir "windows-package\photosuite-$Version-windows-$Arch-portable"
Remove-Item -Recurse -Force $Portable -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Portable | Out-Null
Copy-Item (Join-Path $Stage '*.exe') $Portable
Copy-Item -Recurse (Join-Path $Stage 'resources') $Portable
# NOTICE must travel with the binary (Apache-2.0 §4(d)).
foreach ($f in 'README.md', 'LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-CRATES.md') {
  $p = Join-Path $Root $f
  if (Test-Path $p) { Copy-Item $p $Portable }
}
# portable.txt beside photosuite.exe switches on portable mode: settings, presets and recovery
# files go to PhotoSuiteData\ next to the exe instead of %APPDATA% (#228; see app_dirs.rs).
Copy-Item (Join-Path $PSScriptRoot 'portable.txt') $Portable
$Zip = Join-Path $Dist "photosuite-$Version-windows-$Arch-portable.zip"
Remove-Item -Force $Zip -ErrorAction SilentlyContinue
Compress-Archive -Path $Portable -DestinationPath $Zip

Invoke-Native 'photosuite-cli --version' { & (Join-Path $Stage 'photosuite-cli.exe') --version }
Get-Item $Msi, $Zip | Format-Table Name, Length

[CmdletBinding()]
param(
  [string]$ExpectedCommit = "",
  [switch]$AllowDirty,
  [switch]$SkipInstall,
  [switch]$SkipVerify,
  [switch]$SkipLaunchSmoke
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $repoRoot "package.json"
$tauriConfigPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$bundleDirectory = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
$binaryPath = Join-Path $repoRoot "src-tauri\target\release\openkiwi.exe"
$outputDirectory = Join-Path $repoRoot "RELEASE ASSETS"
$releaseRepository = "m17h/OpenKiwi-Windows"
$defaultUpdaterKeyPath = Join-Path $env:USERPROFILE ".tauri\openkiwi-windows-updater.key"
$defaultUpdaterPasswordPath = Join-Path $env:USERPROFILE ".tauri\openkiwi-windows-updater-password.xml"
Set-Location -LiteralPath $repoRoot

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE."
  }
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "OpenKiwi's Windows release currently requires 64-bit Windows."
}
if (-not (Test-Path $packagePath) -or -not (Test-Path $tauriConfigPath)) {
  throw "Run Windows/build.ps1 from an OpenKiwi checkout."
}

# Clear the previous release before starting. This prevents a failed build from
# leaving stale artifacts that could be mistaken for the current release.
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}
$resolvedRepoRoot = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($outputDirectory).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutputDirectory.StartsWith($resolvedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clear release assets outside the repository: $resolvedOutputDirectory"
}
Get-ChildItem -LiteralPath $outputDirectory -Force |
  Where-Object { $_.Name -ne "README.md" } |
  Remove-Item -Recurse -Force

if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and (Test-Path -LiteralPath $defaultUpdaterKeyPath -PathType Leaf)) {
  $env:TAURI_SIGNING_PRIVATE_KEY = $defaultUpdaterKeyPath
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -and (Test-Path -LiteralPath $defaultUpdaterPasswordPath -PathType Leaf)) {
  $secureUpdaterPassword = Import-Clixml -LiteralPath $defaultUpdaterPasswordPath
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUpdaterPassword)
  try {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  throw "The Windows updater key is unavailable. Expected secure key storage at $defaultUpdaterKeyPath or TAURI_SIGNING_PRIVATE_KEY."
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  throw "The Windows updater key password is unavailable. Expected the DPAPI vault at $defaultUpdaterPasswordPath or TAURI_SIGNING_PRIVATE_KEY_PASSWORD."
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]$tauriConfig.version -ne $version) {
  throw "Version mismatch: package.json=$version, tauri.conf.json=$($tauriConfig.version)."
}

$head = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $head) {
  throw "Could not resolve the source commit."
}
if ($ExpectedCommit -and $head -ne $ExpectedCommit) {
  throw "Windows checkout is at $head, expected $ExpectedCommit."
}

$dirtyTree = (& git -C $repoRoot status --porcelain) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Could not inspect the Git working tree."
}
if ($dirtyTree -and -not $AllowDirty) {
  throw "Refusing to build Windows from a dirty working tree:`n$dirtyTree"
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm -or -not $npx) {
  throw "Node.js/npm is not installed or is not available on PATH."
}

if (-not $SkipInstall) {
  Invoke-Checked -Command $npm -Arguments @("ci")
}
if (-not $SkipVerify) {
  Invoke-Checked -Command $npm -Arguments @("run", "verify")
}

$tauriArguments = @("tauri", "build", "--bundles", "nsis")

if (Test-Path $bundleDirectory) {
  Remove-Item -LiteralPath $bundleDirectory -Recurse -Force
}
Invoke-Checked -Command $npx -Arguments $tauriArguments

$installerName = "OpenKiwi_${version}_x64-setup.exe"
$installerPath = Join-Path $bundleDirectory $installerName
$signaturePath = "$installerPath.sig"
foreach ($artifact in @($binaryPath, $installerPath, $signaturePath)) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Missing Windows release artifact: $artifact"
  }
}
if ((Get-Item -LiteralPath $signaturePath).Length -le 0) {
  throw "The Windows updater signature is empty."
}

$peBytes = [System.IO.File]::ReadAllBytes($binaryPath)
if ($peBytes.Length -lt 256) {
  throw "Native Windows executable is too small to contain a valid PE header."
}
$peHeaderOffset = [BitConverter]::ToInt32($peBytes, 0x3c)
$subsystemOffset = $peHeaderOffset + 24 + 68
if ($peHeaderOffset -lt 0 -or $subsystemOffset + 2 -gt $peBytes.Length) {
  throw "Native Windows executable has an invalid PE header."
}
$peSubsystem = [BitConverter]::ToUInt16($peBytes, $subsystemOffset)
if ($peSubsystem -ne 2) {
  throw "Native Windows executable uses PE subsystem $peSubsystem instead of Windows GUI (2); it would open a background terminal window."
}

$versionInfo = (Get-Item -LiteralPath $installerPath).VersionInfo
if ([string]$versionInfo.ProductVersion -ne $version -or [string]$versionInfo.FileVersion -ne $version) {
  throw "Installer version mismatch: expected $version, product=$($versionInfo.ProductVersion), file=$($versionInfo.FileVersion)."
}

$installerBytes = [System.IO.File]::ReadAllBytes($installerPath)
if ($installerBytes.Length -lt 256) {
  throw "The Windows installer is too small to contain a valid PE header."
}
$installerPeOffset = [BitConverter]::ToInt32($installerBytes, 0x3c)
$optionalHeaderOffset = $installerPeOffset + 24
if ($installerPeOffset -lt 0 -or $optionalHeaderOffset + 2 -gt $installerBytes.Length) {
  throw "The Windows installer has an invalid PE header."
}
$optionalHeaderMagic = [BitConverter]::ToUInt16($installerBytes, $optionalHeaderOffset)
$dataDirectoryOffset = switch ($optionalHeaderMagic) {
  0x10b { $optionalHeaderOffset + 96 }
  0x20b { $optionalHeaderOffset + 112 }
  default { throw "The Windows installer has unsupported PE optional-header magic 0x$($optionalHeaderMagic.ToString('x'))." }
}
$certificateDirectoryOffset = $dataDirectoryOffset + (4 * 8)
if ($certificateDirectoryOffset + 8 -gt $installerBytes.Length) {
  throw "The Windows installer has an incomplete PE certificate-table directory."
}
$certificateTableAddress = [BitConverter]::ToUInt32($installerBytes, $certificateDirectoryOffset)
$certificateTableSize = [BitConverter]::ToUInt32($installerBytes, $certificateDirectoryOffset + 4)
$authenticodeStatus = if ($certificateTableAddress -eq 0 -and $certificateTableSize -eq 0) { "NotSigned" } else { "Signed" }
if ($authenticodeStatus -ne "NotSigned") {
  throw "OpenKiwi Windows installers are intentionally unsigned, but Authenticode reported status: $authenticodeStatus."
}

if (-not $SkipLaunchSmoke) {
  $process = Start-Process -FilePath $binaryPath -PassThru
  try {
    Start-Sleep -Seconds 5
    if ($process.HasExited) {
      throw "OpenKiwi exited during the Windows launch smoke test with code $($process.ExitCode)."
    }
  } finally {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
  }
}

Copy-Item -LiteralPath $installerPath -Destination (Join-Path $outputDirectory $installerName)
Copy-Item -LiteralPath $signaturePath -Destination (Join-Path $outputDirectory "$installerName.sig")

$installerStream = [System.IO.File]::OpenRead($installerPath)
$sha256Algorithm = [System.Security.Cryptography.SHA256]::Create()
try {
  $sha256 = ([BitConverter]::ToString($sha256Algorithm.ComputeHash($installerStream))).Replace("-", "").ToLowerInvariant()
} finally {
  $sha256Algorithm.Dispose()
  $installerStream.Dispose()
}
$buildInfo = [ordered]@{
  version = $version
  commit = $head
  platform = "windows-x86_64"
  architecture = "x64"
  installer = $installerName
  signature = "$installerName.sig"
  sha256 = $sha256
  authenticodeStatus = $authenticodeStatus
  peSubsystem = "WindowsGui"
  builtAt = [DateTime]::UtcNow.ToString("o")
  dirty = [bool]$dirtyTree
}
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $outputDirectory "build-info.json"), ($buildInfo | ConvertTo-Json), $utf8WithoutBom)

$updaterSignature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
$releaseManifest = [ordered]@{
  version = $version
  notes = "OpenKiwi for Windows $version"
  pub_date = [DateTime]::UtcNow.ToString("o")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $updaterSignature
      url = "https://github.com/$releaseRepository/releases/download/v$version/$installerName"
    }
  }
}
[System.IO.File]::WriteAllText((Join-Path $outputDirectory "latest.json"), ($releaseManifest | ConvertTo-Json -Depth 5), $utf8WithoutBom)

Write-Output "Prepared OpenKiwi $version Windows release assets in $outputDirectory"
Get-ChildItem -LiteralPath $outputDirectory | Sort-Object Name | ForEach-Object { Write-Output "- $($_.Name)" }
Write-Warning "The installer is updater-signed but intentionally not Authenticode-signed. Windows SmartScreen may show Unknown publisher."

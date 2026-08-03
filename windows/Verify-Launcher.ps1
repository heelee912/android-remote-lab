[CmdletBinding()]
param(
    [string] $SourcePath,
    [string] $ExecutablePath,
    [string] $ManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $SourcePath) { $SourcePath = Join-Path $PSScriptRoot 'CompanionRelayLauncher.cs' }
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $PSScriptRoot 'CompanionRelayLauncher.exe' }
if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot 'CompanionRelayLauncher.manifest.json' }
$source = [IO.Path]::GetFullPath($SourcePath)
$executable = [IO.Path]::GetFullPath($ExecutablePath)
$manifest = Get-Content -Raw -LiteralPath ([IO.Path]::GetFullPath($ManifestPath)) | ConvertFrom-Json
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$executableHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -ne $manifest.sourceSha256) { throw 'Launcher source hash does not match its manifest' }
if ($executableHash -ne $manifest.executableSha256) { throw 'Launcher executable hash does not match its manifest' }

$bytes = [IO.File]::ReadAllBytes($executable)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
if ($subsystem -ne 2 -or $manifest.peSubsystem -ne 'windows-gui') {
    throw 'Launcher is not a Windows GUI-subsystem executable'
}

"Launcher verification: PASS ($executableHash)"

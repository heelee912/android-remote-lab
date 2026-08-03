[CmdletBinding()]
param(
    [string] $SourcePath,
    [string] $OutputPath,
    [string] $ManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256 {
    param([Parameter(Mandatory)] [string] $Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Get-CanonicalTextSha256 {
    param([Parameter(Mandatory)] [string] $Path)
    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n")
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

if (-not $SourcePath) { $SourcePath = Join-Path $PSScriptRoot 'CompanionRelayLauncher.cs' }
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot 'CompanionRelayLauncher.exe' }
if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot 'CompanionRelayLauncher.manifest.json' }
$source = [IO.Path]::GetFullPath($SourcePath)
$output = [IO.Path]::GetFullPath($OutputPath)
$manifest = [IO.Path]::GetFullPath($ManifestPath)
$csc = (Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64" -Recurse -Filter csc.exe |
    Sort-Object FullName -Descending | Select-Object -First 1).FullName
if (-not $csc) { throw 'The Windows .NET Framework C# compiler was not found' }

New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
& $csc /nologo /target:winexe /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "C# compiler failed with exit code $LASTEXITCODE" }

$bytes = [IO.File]::ReadAllBytes($output)
if ($bytes.Length -lt 512 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw 'Launcher is not a valid PE image'
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$optionalHeader = $peOffset + 24
$subsystem = [BitConverter]::ToUInt16($bytes, $optionalHeader + 68)
if ($subsystem -ne 2) { throw "Launcher PE subsystem is $subsystem; expected Windows GUI (2)" }

$value = [ordered]@{
    schemaVersion = 1
    sourceSha256 = Get-CanonicalTextSha256 $source
    executableSha256 = Get-Sha256 $output
    compilerFileVersion = (Get-Item -LiteralPath $csc).VersionInfo.FileVersion
    peSubsystem = 'windows-gui'
}
[IO.File]::WriteAllText(
    $manifest,
    ($value | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false))
$value | ConvertTo-Json

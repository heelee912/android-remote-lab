[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$')] [string] $PackageName,
    [Parameter(Mandatory)] [string] $OutputPath,
    [string] $Serial
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$adb = (Get-Command adb.exe -ErrorAction Stop).Source
$deviceLines = @(& $adb devices | Select-Object -Skip 1)
$devices = @($deviceLines | ForEach-Object {
    if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
})
if ($Serial) {
    if ($Serial -notin $devices) { throw "Authorized ADB device '$Serial' is not connected" }
    $target = $Serial
} else {
    if ($devices.Count -ne 1) {
        throw "Expected exactly one authorized ADB device; found $($devices.Count). Pass -Serial when needed."
    }
    $target = $devices[0]
}

$pidText = (& $adb -s $target shell pidof $PackageName 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($pidText)) {
    throw "Package '$PackageName' is not running on ADB device '$target'"
}
$processId = ($pidText -split '\s+')[0]
$lines = @(& $adb -s $target logcat -d -v threadtime --pid=$processId)
if ($LASTEXITCODE -ne 0) { throw 'adb logcat failed' }

$destination = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $destination
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[IO.File]::WriteAllLines($destination, [string[]]$lines, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
    ok = $true
    packageName = $PackageName
    serial = $target
    processId = [int]$processId
    output = $destination
    lineCount = $lines.Count
} | ConvertTo-Json -Depth 4

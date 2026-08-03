[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$')] [string] $PackageName,
    [Parameter(Mandatory)] [string] $OutputDirectory,
    [ValidateRange(1, 30)] [int] $LeaseMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$session = 'smoke-' + [guid]::NewGuid().ToString('N')
$screenshot = Join-Path $output ($PackageName + '-screen.png')
$snapshotBefore = Join-Path $output ($PackageName + '-snapshot-before.json')
$snapshotAfter = Join-Path $output ($PackageName + '-snapshot-after.json')

function Get-PropertyValue {
    param([object] $Object, [string] $Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Save-Snapshot {
    param([string] $Name, [string] $Path)
    $result = arlab device snapshot -i --session $Name --json | ConvertFrom-Json
    $data = Get-PropertyValue $result 'data'
    if ($null -eq $data) { throw "Snapshot response did not contain data" }
    [System.IO.File]::WriteAllText(
        $Path,
        ($result | ConvertTo-Json -Depth 30),
        [System.Text.UTF8Encoding]::new($false))
    return $result
}

function Assert-Foreground {
    param([object] $SnapshotResult, [string] $Label)
    $data = Get-PropertyValue $SnapshotResult 'data'
    $rootPackage = [string](Get-PropertyValue $data 'rootPackageName')
    if ([string]::IsNullOrWhiteSpace($rootPackage)) {
        $nodes = @(Get-PropertyValue $data 'nodes')
        $packages = @($nodes | ForEach-Object { Get-PropertyValue $_ 'packageName' } |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
        if ($packages.Count -eq 1) { $rootPackage = [string]$packages[0] }
    }
    if ($rootPackage -ne $PackageName) {
        throw "$Label foreground package is '$rootPackage'; expected '$PackageName'"
    }
}

$doctor = arlab doctor --repair --json | ConvertFrom-Json
$allowedStates = @('READY', 'CONNECTED_UNVERIFIED')
if ($doctor.state -notin $allowedStates) {
    throw "Android Remote Lab is not ready: $($doctor.state)"
}

try {
    arlab session start $LeaseMinutes | Out-Null
    $openResult = arlab device open $PackageName --json | ConvertFrom-Json
    $openData = Get-PropertyValue $openResult 'data'
    $openResponse = Get-PropertyValue $openData 'result'
    if ((Get-PropertyValue $openResponse 'launched') -ne $true) {
        throw "Android did not confirm that package launch was requested"
    }
    Start-Sleep -Milliseconds 1200
    $before = Save-Snapshot ($session + '-before') $snapshotBefore
    Assert-Foreground $before 'Pre-capture'

    $screenshotResult = arlab device screenshot $screenshot --json | ConvertFrom-Json
    $screenshotData = Get-PropertyValue $screenshotResult 'data'
    foreach ($field in @('activeWindowBefore', 'activeWindowAfter')) {
        $window = Get-PropertyValue $screenshotData $field
        $capturedPackage = [string](Get-PropertyValue $window 'packageName')
        if (-not [string]::IsNullOrWhiteSpace($capturedPackage) -and $capturedPackage -ne $PackageName) {
            throw "Screenshot $field package is '$capturedPackage'; expected '$PackageName'"
        }
    }

    $after = Save-Snapshot ($session + '-after') $snapshotAfter
    Assert-Foreground $after 'Post-capture'
    [pscustomobject]@{
        ok = $true
        doctorState = $doctor.state
        packageName = $PackageName
        device = $doctor.device
        snapshotBefore = $snapshotBefore
        snapshotAfter = $snapshotAfter
        screenshot = $screenshot
    } | ConvertTo-Json -Depth 6
} finally {
    arlab session stop 2>$null | Out-Null
}

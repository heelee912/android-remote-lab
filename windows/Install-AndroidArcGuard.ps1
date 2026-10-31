param(
    [Parameter(Mandatory = $true)][string]$DeviceId,
    [string]$ApkPath = (Join-Path $PSScriptRoot '..\android\arcguard\build\outputs\apk\debug\arcguard-debug.apk')
)

$ErrorActionPreference = 'Stop'
if (-not $env:ANDROID_REMOTE_LAB_OWNER -and -not $env:CODEX_THREAD_ID) {
    $env:ANDROID_REMOTE_LAB_OWNER = "arcguard-install-$PID"
}
$pairedTv = Join-Path $env:LOCALAPPDATA 'AndroidRemoteLab\webos-client-key.json'
if (-not (Test-Path -LiteralPath $pairedTv)) { throw 'Pair the LG TV with ARLab first.' }
if (-not (Test-Path -LiteralPath $ApkPath)) { throw 'Build :arcguard:assembleDebug first.' }
$remote = '/data/local/tmp/arcguard-' + [guid]::NewGuid().ToString('N') + '.json'
$sessionStarted = $false
$pushed = $false

function Invoke-Arlab([string[]]$Arguments, [string]$Operation) {
    $response = & arlab @Arguments
    $exitCode = $LASTEXITCODE
    $result = $response | ConvertFrom-Json
    if ($exitCode -ne 0 -or -not $result.ok) {
        throw "$Operation failed: $($result.error.message) $($result.data.result.stderr)"
    }
    if ($result.data.result -and $result.data.result.exitCode -ne 0) {
        throw "$Operation failed: $($result.data.result.stderr)"
    }
    return $result
}

function Invoke-DeviceAdb([string[]]$Arguments, [string]$Operation) {
    return Invoke-Arlab -Arguments (@('device', 'adb', '--device', $DeviceId, '--json', '--') + $Arguments) -Operation $Operation
}

try {
    Invoke-Arlab -Arguments @('doctor', '--repair', '--background', '--device', $DeviceId, '--json') -Operation 'Preflight' | Out-Null
    Invoke-Arlab -Arguments @('session', 'start', '--background', '--device', $DeviceId, '--json') -Operation 'Session start' | Out-Null
    $sessionStarted = $true
    Invoke-DeviceAdb -Arguments @('install', '-r', (Resolve-Path -LiteralPath $ApkPath).Path) -Operation 'Install' | Out-Null
    Invoke-DeviceAdb -Arguments @('push', $pairedTv, $remote) -Operation 'Private configuration transfer' | Out-Null
    $pushed = $true
    Invoke-DeviceAdb -Arguments @('shell', 'run-as', 'lab.arcguard', 'mkdir', '-p', 'files') -Operation 'Create private storage' | Out-Null
    Invoke-DeviceAdb -Arguments @('shell', 'run-as', 'lab.arcguard', 'cp', $remote, 'files/webos-client-key.json') -Operation 'Save private configuration' | Out-Null
    Invoke-DeviceAdb -Arguments @('shell', 'run-as', 'lab.arcguard', 'chmod', '600', 'files/webos-client-key.json') -Operation 'Protect private configuration' | Out-Null
    Invoke-DeviceAdb -Arguments @('shell', 'appops', 'set', 'lab.arcguard', 'SCHEDULE_EXACT_ALARM', 'allow') -Operation 'Exact alarm access' | Out-Null
    $launch = Invoke-DeviceAdb -Arguments @('shell', 'am', 'start', '-n', 'lab.arcguard/.MainActivity') -Operation 'Guard start'
    if ($launch.data.result.stdout -notmatch 'Starting:') { throw 'Android did not confirm guard start.' }
    [pscustomobject]@{ installed = $true; configured = $true; started = $true; deviceId = $DeviceId }
} finally {
    if ($sessionStarted) {
        if ($pushed) {
            try { Invoke-DeviceAdb -Arguments @('shell', 'rm', '-f', $remote) -Operation 'Remove transfer copy' | Out-Null }
            catch { Write-Warning 'Temporary configuration cleanup failed; retry from ADB.' }
        }
        & arlab session stop --device $DeviceId --json | Out-Null
    }
}

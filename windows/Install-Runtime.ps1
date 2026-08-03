[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $PackageRoot,
    [string] $RelayHost,
    [ValidateRange(1, 65535)] [int] $PublicPort = 10000,
    [string] $ImportState,
    [string] $ReplaceTaskName,
    [switch] $System,
    [switch] $NoFunnel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Copy-WithRetry {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            return
        } catch [System.IO.IOException] {
            if ($attempt -eq 40) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

$base = Join-Path $env:LOCALAPPDATA 'AndroidRemoteLab'
$runtime = Join-Path $base 'runtime'
$state = Join-Path $base 'state'
$configPath = Join-Path $base 'config.json'
$taskName = 'AndroidRemoteLabRelay'
$node = (Get-Command node.exe -ErrorAction Stop).Source

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($ReplaceTaskName -and $ReplaceTaskName -ne $taskName) {
    Stop-ScheduledTask -TaskName $ReplaceTaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $ReplaceTaskName -ErrorAction SilentlyContinue | Out-Null
}
Start-Sleep -Milliseconds 500

if (-not $RelayHost) {
    $tailscale = tailscale status --json | ConvertFrom-Json
    $RelayHost = ([string]$tailscale.Self.DNSName).TrimEnd('.')
}
if (-not $RelayHost -or $RelayHost -match '[/\\:]') {
    throw 'A DNS relay host is required. Pass --host to arlab setup.'
}

New-Item -ItemType Directory -Path $runtime, $state -Force | Out-Null
if ($ImportState) {
    $resolvedImport = (Resolve-Path -LiteralPath $ImportState -ErrorAction Stop).Path
    foreach ($name in 'devices.json', 'pending-enrollment.json') {
        $source = Join-Path $resolvedImport $name
        if (Test-Path -LiteralPath $source) {
            $destination = Join-Path $state $name
            if ([System.IO.Path]::GetFullPath($source) -ne [System.IO.Path]::GetFullPath($destination)) {
                Copy-Item -LiteralPath $source -Destination $destination -Force
            }
        }
    }
}
Copy-WithRetry (Join-Path $PackageRoot 'src\relay.js') (Join-Path $runtime 'relay.js')
Copy-WithRetry (Join-Path $PackageRoot 'src\config.js') (Join-Path $runtime 'config.js')
Copy-WithRetry (Join-Path $PackageRoot 'windows\CompanionRelayLauncher.exe') (Join-Path $runtime 'CompanionRelayLauncher.exe')

$config = [ordered]@{
    schemaVersion = 1
    runtimeDir = $runtime
    stateDir = $state
    relayHost = $RelayHost
    publicPort = $PublicPort
    ingressPort = 7001
    apiPort = 7011
    taskName = $taskName
}
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $base '/inheritance:r' '/grant:r' "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect runtime state ACL.' }

$launcher = Join-Path $runtime 'CompanionRelayLauncher.exe'
$arguments = '"{0}" "{1}"' -f $configPath, $node
$action = New-ScheduledTaskAction -Execute $launcher -Argument $arguments -WorkingDirectory $runtime
if ($System) {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $trigger = New-ScheduledTaskTrigger -AtStartup
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Windowless Android Remote Lab relay supervisor.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

if (-not $NoFunnel) {
    & tailscale.exe funnel --bg --yes --tls-terminated-tcp $PublicPort "tcp://127.0.0.1:7001" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale Funnel configuration failed.' }
}

[pscustomobject]@{
    ok = $true
    config = $configPath
    endpoint = "${RelayHost}:$PublicPort"
    task = $taskName
    mode = $(if ($System) { 'system-startup' } else { 'user-logon' })
} | ConvertTo-Json

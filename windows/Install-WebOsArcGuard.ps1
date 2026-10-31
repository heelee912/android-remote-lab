[CmdletBinding()]
param([switch]$Remove)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'AndroidRemoteLab-WebOsArcGuard'
if ($Remove) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    [pscustomobject]@{ taskName = $taskName; installed = $false } | ConvertTo-Json -Compress
    return
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$packageRoot = (& npm root -g).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not locate the globally installed ARLab package' }
$cliPath = Join-Path $packageRoot 'android-remote-lab\bin\arlab.mjs'
if (-not (Test-Path -LiteralPath $cliPath)) { throw "ARLab CLI is missing at $cliPath" }

$launcherSource = Join-Path $PSScriptRoot 'WebOsArcGuardLauncher.exe'
$launcherManifest = Join-Path $PSScriptRoot 'WebOsArcGuardLauncher.manifest.json'
$launcherVerifier = Join-Path $PSScriptRoot 'Verify-Launcher.ps1'
if (-not (Test-Path -LiteralPath $launcherSource)) { throw "ARC guard launcher is missing at $launcherSource" }
& $launcherVerifier -SourcePath (Join-Path $PSScriptRoot 'WebOsArcGuardLauncher.cs') `
    -ExecutablePath $launcherSource -ManifestPath $launcherManifest | Out-Null
$launcherHash = (Get-FileHash -LiteralPath $launcherSource -Algorithm SHA256).Hash.ToLowerInvariant()
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'AndroidRemoteLab\runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$launcherPath = Join-Path $runtimeDirectory "WebOsArcGuardLauncher-$($launcherHash.Substring(0, 16)).exe"
if (-not (Test-Path -LiteralPath $launcherPath)) {
    Copy-Item -LiteralPath $launcherSource -Destination $launcherPath
}
if ((Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $launcherHash) {
    throw "Installed ARC guard launcher hash differs from package at $launcherPath"
}

$action = New-ScheduledTaskAction -Execute $launcherPath `
    -Argument "`"$nodePath`" `"$cliPath`"" -WorkingDirectory $packageRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description 'Read LG HDMI ARC status without changing TV audio' `
    -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    taskName = $taskName
    installed = $true
    nextRunTime = $info.NextRunTime
    lastTaskResult = $info.LastTaskResult
} | ConvertTo-Json -Compress

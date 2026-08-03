[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$files = @(
    Get-ChildItem -LiteralPath (Join-Path $root 'windows'), (Join-Path $root 'skills') `
        -Recurse -File -Filter '*.ps1'
)
if ($files.Count -eq 0) { throw 'No PowerShell files were found' }

foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors)
    if ($errors.Count -gt 0) {
        throw "$($file.FullName): $($errors[0].Message)"
    }
}

"PowerShell validation: PASS ($($files.Count) files)"

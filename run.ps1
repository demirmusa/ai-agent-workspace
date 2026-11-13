[CmdletBinding()]
param(
    [switch]$NoDesktop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Handle native exit codes explicitly on both Windows PowerShell 5.1 and PowerShell 7.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-RunNpm {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host ("Running npm {0}..." -f ($Arguments -join ' '))
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw ("npm {0} failed with exit code {1}." -f ($Arguments -join ' '), $LASTEXITCODE)
    }
}

$runExitCode = 0
$locationPushed = $false
try {
    Push-Location -LiteralPath (Join-Path $PSScriptRoot 'src')
    $locationPushed = $true

    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) {
        throw 'Node.js is not installed or is not on PATH. Install Node.js 22.13 or newer, then retry.'
    }
    $nodeVersionText = (& $nodeCommand.Source --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$') {
        throw 'Could not determine the Node.js version. Node.js 22.13 or newer is required.'
    }
    $nodeVersion = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    if ($nodeVersion -lt [version]'22.13.0') {
        throw ("Node.js {0} is too old. Node.js 22.13 or newer is required by the desktop dependencies." -f $nodeVersion)
    }

    # Prefer the native Windows launcher; npm.ps1 may be blocked by execution policy.
    $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npmCommand) {
        $npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $npmCommand) {
        throw 'npm is not installed or is not on PATH. Install npm with Node.js, then retry.'
    }

    Invoke-RunNpm -Executable $npmCommand.Source -Arguments @('install')
    Invoke-RunNpm -Executable $npmCommand.Source -Arguments @('link')
    Invoke-RunNpm -Executable $npmCommand.Source -Arguments @('run', 'build')
    Write-Host 'Build complete: dependencies installed, CLI linked, and project built.'

    if (-not $NoDesktop) {
        Invoke-RunNpm -Executable $npmCommand.Source -Arguments @('run', 'desktop:start')
    } else {
        Write-Host 'Skipped the desktop app (-NoDesktop).'
    }
} catch {
    [Console]::Error.WriteLine(("Run failed: {0}" -f $_.Exception.Message))
    $runExitCode = 1
} finally {
    if ($locationPushed) {
        Pop-Location
    }
}

if ($runExitCode -ne 0) {
    exit $runExitCode
}

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,

  [switch]$RunSourceChecks
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsHostVerification.psm1') -Force

$result = Invoke-WindowsHostPreflightCollection `
  -RepositoryRoot $RepositoryRoot `
  -OutputRoot $OutputRoot `
  -RunSourceChecks:$RunSourceChecks

Write-Output "Windows host preflight written to $($result.RecordPath)"
Write-Output "Classification: HOST_COLLECTED_UNREVIEWED"
Write-Output "Source checks: $($result.SourceChecks)"
if (-not $result.Success) {
  Write-Error 'One or more requested source checks failed. The failed evidence was preserved.'
  exit 1
}

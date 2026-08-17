[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputRoot,

  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,

  [string]$UserProfileRoot = $env:USERPROFILE,

  [string]$TempRoot = $env:TEMP
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsHostVerification.psm1') -Force

$result = New-WindowsHostEvidenceBundle `
  -InputRoot $InputRoot `
  -OutputRoot $OutputRoot `
  -RepositoryRoot $RepositoryRoot `
  -UserProfileRoot $UserProfileRoot `
  -TempRoot $TempRoot

Write-Output "Redacted host evidence bundle written to $($result.OutputRoot)"
Write-Output "Included files: $($result.IncludedFiles)"
Write-Output "Excluded files: $($result.ExcludedFiles)"
Write-Output 'Classification: HOST_COLLECTED_UNREVIEWED'

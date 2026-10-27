$ErrorActionPreference = "Stop"

function Invoke-RestMethod {
  param($Uri, $Method, $Headers, $ContentType, $Body)
  $global:CapturedHeartbeat = $Body | ConvertFrom-Json
  return [pscustomobject]@{ accepted = $true }
}

$scriptPath = Join-Path $PSScriptRoot "..\scripts\send-station-heartbeat.ps1"

& $scriptPath `
  -ApiKey "test-key" `
  -BaseUrl "http://test.invalid" `
  -ActiveChannels "outlet-1,outlet-2", "dc-type-c" `
  -RelayChannels "outlet-1", "dc-type-c" | Out-Null

if (-not $CapturedHeartbeat.channels."outlet-1".inUse) { throw "outlet-1 should be active" }
if (-not $CapturedHeartbeat.channels."outlet-2".inUse) { throw "outlet-2 should be active" }
if (-not $CapturedHeartbeat.channels."dc-type-c".inUse) { throw "dc-type-c should be active" }
if (-not $CapturedHeartbeat.channels."outlet-1".relayOn) { throw "outlet-1 relay should be on" }
if ($CapturedHeartbeat.channels."outlet-2".relayOn) { throw "outlet-2 relay should be off" }
if (-not $CapturedHeartbeat.channels."dc-type-c".relayOn) { throw "dc-type-c relay should be on" }

& $scriptPath `
  -ApiKey "test-key" `
  -BaseUrl "http://test.invalid" `
  -ActiveChannel "wireless-pad" `
  -RelayChannel "match" | Out-Null

if (-not $CapturedHeartbeat.channels."wireless-pad".inUse) { throw "Legacy active channel should still work" }
if (-not $CapturedHeartbeat.channels."wireless-pad".relayOn) { throw "Legacy relay match should still work" }

Write-Output "Multi-channel and legacy heartbeat parameter tests passed."

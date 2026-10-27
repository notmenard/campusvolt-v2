param(
  [Parameter(Mandatory = $true)]
  [string]$ApiKey,

  [string]$BaseUrl = "https://campusvolt-v2.vercel.app",

  [string]$StationId = "station-01",

  [string]$LastAppliedCommandId = "",

  [ValidateSet("none", "outlet-1", "outlet-2", "dc-type-c", "dc-micro-usb", "dc-lightning", "wireless-pad")]
  [string]$ActiveChannel = "outlet-1",

  [ValidateSet("match", "none", "outlet-1", "outlet-2", "dc-type-c", "dc-micro-usb", "dc-lightning", "wireless-pad")]
  [string]$RelayChannel = "match",

  [string[]]$ActiveChannels,

  [string[]]$RelayChannels
)

$channelIds = @(
  "outlet-1",
  "outlet-2",
  "dc-type-c",
  "dc-micro-usb",
  "dc-lightning",
  "wireless-pad"
)

function Resolve-ChannelSelection {
  param(
    [string[]]$Values,
    [bool]$AllowMatch = $false
  )

  $tokens = @(
    $Values |
      ForEach-Object { $_ -split "," } |
      ForEach-Object { $_.Trim().ToLowerInvariant() } |
      Where-Object { $_ }
  )

  if ($tokens.Count -eq 0) {
    throw "At least one channel ID, 'none', or 'match' must be provided."
  }
  if ($tokens -contains "match") {
    if (-not $AllowMatch -or $tokens.Count -ne 1) {
      throw "'match' must be used by itself and is only valid for relay channels."
    }
    return [pscustomobject]@{ MatchActive = $true; Channels = @() }
  }
  if ($tokens -contains "none") {
    if ($tokens.Count -ne 1) {
      throw "'none' cannot be combined with channel IDs."
    }
    return [pscustomobject]@{ MatchActive = $false; Channels = @() }
  }

  $invalidChannels = @($tokens | Where-Object { $channelIds -notcontains $_ } | Select-Object -Unique)
  if ($invalidChannels.Count -gt 0) {
    throw "Unknown channel ID(s): $($invalidChannels -join ', ')."
  }

  return [pscustomobject]@{
    MatchActive = $false
    Channels = @($tokens | Select-Object -Unique)
  }
}

$activeSelection = if ($PSBoundParameters.ContainsKey("ActiveChannels")) {
  Resolve-ChannelSelection -Values $ActiveChannels
} else {
  Resolve-ChannelSelection -Values @($ActiveChannel)
}

$relaySelection = if ($PSBoundParameters.ContainsKey("RelayChannels")) {
  Resolve-ChannelSelection -Values $RelayChannels -AllowMatch $true
} else {
  Resolve-ChannelSelection -Values @($RelayChannel) -AllowMatch $true
}

$selectedActiveChannels = @($activeSelection.Channels)
$selectedRelayChannels = if ($relaySelection.MatchActive) {
  $selectedActiveChannels
} else {
  @($relaySelection.Channels)
}

$channels = @{}
foreach ($channelId in $channelIds) {
  $isActive = $selectedActiveChannels -contains $channelId
  $isRelayOn = $selectedRelayChannels -contains $channelId
  $isAc = $channelId.StartsWith("outlet-")
  $voltage = if ($isAc) { 220.0 } else { 5.1 }
  $watts = if ($isActive -and $isRelayOn) { if ($isAc) { 42.0 } else { 9.0 } } else { 0.0 }
  $channels[$channelId] = @{
    inUse = $isActive
    watts = $watts
    voltageV = $voltage
    currentA = if ($isActive) { $watts / $voltage } else { 0.0 }
    relayOn = $isRelayOn
    fault = $null
  }
}

$payload = @{
  schemaVersion = 1
  stationId = $StationId
  messageId = "manual-$([guid]::NewGuid().ToString('N'))"
  sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  firmwareVersion = "pre-hardware-test"
  rssi = -55
  channels = $channels
  telemetry = @{
    battery = @{
      connected = $true
      soc = 82.5
      voltageV = 13.31
      currentA = 8.4
      powerW = 111.8
      temperatureC = 31.2
      protection = "normal"
      status = "charging"
      ratedCapacityAh = 100
      ratedEnergyWh = 1280
      remainingAh = 82.5
      remainingEnergyWh = 1056
      healthPercent = 98
      cycleCount = 42
      cellMinVoltageV = 3.31
      cellMaxVoltageV = 3.34
      cellDeltaMv = 30
    }
    solar = @{
      powerW = 285
      energyTodayWh = 1800
      peakPowerW = 450
      panelVoltageV = 18.6
      controllerState = "charging"
    }
  }
} | ConvertTo-Json -Depth 5

if ($LastAppliedCommandId) {
  $payloadObject = $payload | ConvertFrom-Json
  $payloadObject | Add-Member -NotePropertyName lastAppliedCommandId -NotePropertyValue $LastAppliedCommandId
  $payload = $payloadObject | ConvertTo-Json -Depth 5
}

$headers = @{ Authorization = "Bearer $ApiKey" }
$response = Invoke-RestMethod `
  -Uri "$($BaseUrl.TrimEnd('/'))/api/station-status" `
  -Method Post `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

$response | ConvertTo-Json -Depth 6

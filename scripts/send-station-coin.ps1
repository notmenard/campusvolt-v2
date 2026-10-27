param(
    [Parameter(Mandatory = $true)]
    [string]$CollectionId,

    [ValidateSet(1, 5, 10, 20)]
    [int]$Denomination = 1,

    [ValidateRange(1, 100)]
    [int]$PulseCount = 1,

    [string]$ApiKey = $env:CAMPUSVOLT_STATION_API_KEY,
    [string]$BaseUrl = "http://localhost:5500",
    [string]$EventId = ""
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw "Set CAMPUSVOLT_STATION_API_KEY or pass -ApiKey."
}

if ([string]::IsNullOrWhiteSpace($EventId)) {
    $EventId = "powershell-coin-$([guid]::NewGuid().ToString('N'))"
}

$body = @{
    collectionId = $CollectionId
    eventId = $EventId
    denomination = $Denomination
    pulseCount = $PulseCount
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "$($BaseUrl.TrimEnd('/'))/api/station-coins" `
    -Headers @{ Authorization = "Bearer $ApiKey" } `
    -ContentType "application/json" `
    -Body $body

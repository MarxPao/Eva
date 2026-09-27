$port = New-Object System.IO.Ports.SerialPort "COM7", 115200, "None", 8, "One"
$port.DtrEnable = $true
$port.RtsEnable = $false
$port.ReadTimeout = 5000

try {
    $port.Open()
    # Dá um pulso no RTS para resetar o ESP32 e ver o boot do início
    $port.RtsEnable = $true
    Start-Sleep -Milliseconds 150
    $port.RtsEnable = $false
    
    $start = Get-Date
    while ((Get-Date) - $start -lt [TimeSpan]::FromSeconds(8)) {
        if ($port.BytesToRead -gt 0) {
            Write-Host $port.ReadExisting() -NoNewline
        }
        Start-Sleep -Milliseconds 50
    }
} catch {
    Write-Host "Erro serial: " $_.Exception.Message
} finally {
    if ($port.IsOpen) { $port.Close() }
}

$port = New-Object System.IO.Ports.SerialPort "COM8", 115200, "None", 8, "One"
$port.DtrEnable = $false
$port.RtsEnable = $false
$port.ReadTimeout = 4000
try {
    $port.Open()
    $start = Get-Date
    while ((Get-Date) - $start -lt [TimeSpan]::FromSeconds(4)) {
        if ($port.BytesToRead -gt 0) {
            Write-Host $port.ReadExisting() -NoNewline
        }
        Start-Sleep -Milliseconds 100
    }
} catch {
    Write-Host "Erro: " $_.Exception.Message
} finally {
    if ($port.IsOpen) {
        $port.Close()
    }
}

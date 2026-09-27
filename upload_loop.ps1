$esptool = "C:\Users\rafae\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.0\esptool.exe"
$arduino = "C:\Program Files\Arduino CLI\arduino-cli.exe"

Write-Host "Monitorando COM5 para gravação (60 segundos)..."
for ($i = 0; $i -lt 40; $i++) {
    $out = & $esptool --port COM5 --chip esp32s3 chip-id 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host ">>> ESP32-S3 DETECTADO EM MODO DOWNLOAD! Iniciando gravação..."
        & $arduino upload -p COM5 --fqbn esp32:esp32:esp32s3 eva_arduino
        Write-Host ">>> GRAVAÇÃO CONCLUÍDA COM SUCESSO!"
        exit 0
    }
    Write-Host "Tentativa $($i + 1): aguardando BOOT + RST..."
    Start-Sleep -Seconds 1
}
Write-Host "Tempo limite esgotado."
exit 1

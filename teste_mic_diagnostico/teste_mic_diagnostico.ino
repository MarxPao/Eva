/*
 * ============================================================================
 * EVA — TESTE DIAGNÓSTICO DE MICROFONE I2S (ESP32-S3)
 * ============================================================================
 * Placa: ESP32-S3 DevKit
 * Microfone: MEMS I2S (MS3625 / INMP441 / ICS-43434)
 * 
 * Funciona independente de "USB CDC On Boot" estar ativado ou desativado,
 * pois transmite tanto para Serial (USB nativo) quanto Serial0 (UART CH343 COM7).
 * ============================================================================
 */

#include <Arduino.h>
#include "driver/i2s.h"
#include <math.h>

#define I2S_SD_PIN    13
#define I2S_WS_PIN    1
#define I2S_SCK_PIN   2
#define SAMPLE_RATE   16000
#define BUFFER_PAIRS  256

// Buffer para captura estéreo (Left + Right intercalados)
int32_t rawBuffer[BUFFER_PAIRS * 2];

// Macro para garantir impressão tanto na Serial USB quanto na Serial0 (COM7)
#define LOG_PRINTLN(x) do { Serial.println(x); Serial0.println(x); } while(0)
#define LOG_PRINTF(...) do { Serial.printf(__VA_ARGS__); Serial0.printf(__VA_ARGS__); } while(0)

void initI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT, // Captura ambos os canais (Stereo)
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD_PIN
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    LOG_PRINTF("[ERRO] Falha ao instalar driver I2S: 0x%04x\n", err);
    return;
  }

  err = i2s_set_pin(I2S_NUM_0, &pin_config);
  if (err != ESP_OK) {
    LOG_PRINTF("[ERRO] Falha ao configurar pinos I2S: 0x%04x\n", err);
    return;
  }

  LOG_PRINTLN(">> Driver I2S inicializado com sucesso.");
}

void setup() {
  // Inicializa ambas as portas para garantir que o monitor serial nunca fique em branco
  Serial.begin(115200);
  Serial0.begin(115200);
  delay(1200);

  LOG_PRINTLN("\n\n==================================================");
  LOG_PRINTLN("     DIAGNÓSTICO DE MICROFONE I2S — ESP32-S3      ");
  LOG_PRINTLN("==================================================");
  LOG_PRINTF("Pinos: SD=GPIO%d | WS=GPIO%d | SCK=GPIO%d\n", I2S_SD_PIN, I2S_WS_PIN, I2S_SCK_PIN);
  LOG_PRINTLN("--------------------------------------------------");

  initI2S();
  LOG_PRINTLN("Aguardando sinal de áudio... Fale perto do mic ou estale os dedos!\n");
}

void loop() {
  size_t bytesRead = 0;
  esp_err_t res = i2s_read(I2S_NUM_0, rawBuffer, sizeof(rawBuffer), &bytesRead, portMAX_DELAY);

  if (res != ESP_OK || bytesRead == 0) {
    delay(100);
    return;
  }

  size_t pairs = (bytesRead / sizeof(int32_t)) / 2;
  double sumL = 0, sumR = 0;
  int nonZeroCount = 0;

  for (size_t i = 0; i < pairs; i++) {
    int32_t sampleL = rawBuffer[i * 2]     >> 14;
    int32_t sampleR = rawBuffer[i * 2 + 1] >> 14;

    sumL += sampleL;
    sumR += sampleR;

    if (rawBuffer[i * 2] != 0 || rawBuffer[i * 2 + 1] != 0) {
      nonZeroCount++;
    }
  }

  double meanL = sumL / pairs;
  double meanR = sumR / pairs;

  double sqDiffL = 0, sqDiffR = 0;
  for (size_t i = 0; i < pairs; i++) {
    double acL = (rawBuffer[i * 2]     >> 14) - meanL;
    double acR = (rawBuffer[i * 2 + 1] >> 14) - meanR;
    sqDiffL += acL * acL;
    sqDiffR += acR * acR;
  }

  float rmsL = sqrt(sqDiffL / pairs);
  float rmsR = sqrt(sqDiffR / pairs);

  static unsigned long lastPrint = 0;
  if (millis() - lastPrint >= 300) {
    lastPrint = millis();

    if (nonZeroCount == 0) {
      LOG_PRINTLN("[SILÊNCIO TOTAL - 0.0] Todos os bits lidos são ZERO.");
      LOG_PRINTLN("  -> Verifique: Pino SD no GPIO 13, VDD em 3.3V e GND.");
    } 
    else if (rmsL > 3.0 && rmsR < 2.0) {
      LOG_PRINTF("✅ [CANAL ESQUERDO ATIVO] RMS: %.1f | (L/R no GND OK!)\n", rmsL);
    } 
    else if (rmsR > 3.0 && rmsL < 2.0) {
      LOG_PRINTF("⚠️ [CANAL DIREITO ATIVO] RMS: %.1f | (L/R em 3.3V/solto! Ligue L/R no GND).\n", rmsR);
    } 
    else {
      LOG_PRINTF("[SINAL DETECTADO] RMS Left: %.1f | RMS Right: %.1f\n", rmsL, rmsR);
    }
  }
}

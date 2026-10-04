/*
 * ============================================================================
 * EVA — Firmware ESP32-S3 (Streaming de Áudio, VAD & Ciclo de Voz Whisper)
 * ============================================================================
 * Pinos do Microfone I2S:
 *   - SD  (Serial Data):  GPIO 13
 *   - WS  (Word Select):  GPIO 1
 *   - SCK (Serial Clock): GPIO 2
 *   - L/R:                GND (Canal Esquerdo / Left)
 *   - VDD:                3.3V
 *   - GND:                GND
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include "driver/i2s.h"
#include <math.h>
#include "esp_system.h"

// Configurações de Rede
const char* WIFI_SSID = "CMA";
const char* WIFI_PASS = "clsma1976";
const char* SERVER_HOST = "192.168.2.146";
const uint16_t SERVER_PORT = 8080;
const char* SERVER_VOICE_URL = "http://192.168.2.146:8080/api/pipeline/voice";

// ============================================================================
// Configuração de Pinos: Compatibilidade ESP32 Clássico vs ESP32-S3
// ============================================================================
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  // ESP32-S3
  #define I2S_SD_PIN   13
  #define I2S_WS_PIN   1
  #define I2S_SCK_PIN  2
  #define LED_PIN      48
  #define LOG_PRINTLN(x) do { Serial.println(x); Serial0.println(x); } while(0)
  #define LOG_PRINTF(...) do { Serial.printf(__VA_ARGS__); Serial0.printf(__VA_ARGS__); } while(0)
#else
  // ESP32 Clássico (WROOM-32, DOIT DevKit v1, etc.)
  #include "BluetoothA2DPSource.h"
  #include "esp_coexist.h"
  #include "esp_bt.h"
  #define I2S_SD_PIN   32  // Serial Data / DOUT (compartilhado por ambos os microfones)
  #define I2S_WS_PIN   15  // Word Select / LRCLK (compartilhado)
  #define I2S_SCK_PIN  14  // Serial Clock / BCLK (compartilhado)
  #define LED_PIN      2   // LED Azul onboard padrão do ESP32 clássico
  #define LOG_PRINTLN(x) Serial.println(x)
  #define LOG_PRINTF(...) Serial.printf(__VA_ARGS__)

// ============================================================================
// Diagnóstico e Instrumentação de Memória / Reset (Etapa 0)
// ============================================================================
const char* getResetReasonString(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:   return "POWERON (Liguei na tomada/USB)";
    case ESP_RST_EXT:       return "EXT (Pino EN / Botão Reset)";
    case ESP_RST_SW:        return "SW (Reboot por software)";
    case ESP_RST_PANIC:     return "PANIC (Crash/Exception)";
    case ESP_RST_INT_WDT:   return "INT_WDT (Watchdog de Interrupção)";
    case ESP_RST_TASK_WDT:  return "TASK_WDT (Task Watchdog travou)";
    case ESP_RST_WDT:       return "WDT (Outro Watchdog)";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP (Acordou do sono profundo)";
    case ESP_RST_BROWNOUT:  return "BROWNOUT (Queda de tensão na fonte!)";
    case ESP_RST_SDIO:      return "SDIO (Reset SDIO)";
    default:                return "UNKNOWN / OUTRO";
  }
}

void printMemoryReport(const char* tag) {
  LOG_PRINTF("[MEM][%s] PSRAM: %s | FreeHeap: %u bytes (%.1f KB) | MaxAllocHeap: %u bytes (%.1f KB)\n",
             tag,
             psramFound() ? "sim" : "não",
             (unsigned int)ESP.getFreeHeap(),
             ESP.getFreeHeap() / 1024.0f,
             (unsigned int)ESP.getMaxAllocHeap(),
             ESP.getMaxAllocHeap() / 1024.0f);
}

  // 1 = liga A2DP para a caixa de som com o ID 'BT-SPEAKER'; 0 = Bluetooth desligado
  #define BT_ENABLED 1
  const char* BT_SPEAKER_NAME = "BT-SPEAKER";
  static esp_bd_addr_t targetBtMac = {0};
  static bool hasTargetMac = false;

  // Ring Buffer de Áudio TTS para Transmissão Bluetooth A2DP (8KB = ~93ms a 44.1kHz mono 16-bit)
  #define TTS_BUFFER_SIZE (8 * 1024)
  static uint8_t* ttsRingBuffer = nullptr;
  static volatile size_t ttsHead = 0;
  static volatile size_t ttsTail = 0;
  static portMUX_TYPE ttsMux = portMUX_INITIALIZER_UNLOCKED;

  size_t ttsBufferPush(const uint8_t* data, size_t len) {
    if (ttsRingBuffer == nullptr || len == 0) return 0;
    portENTER_CRITICAL(&ttsMux);
    size_t currentTail = ttsTail;
    size_t currentHead = ttsHead;

    size_t availableSpace = (currentTail > currentHead)
        ? (currentTail - currentHead - 1)
        : (TTS_BUFFER_SIZE - currentHead + currentTail - 1);

    size_t toWrite = (len > availableSpace) ? availableSpace : len;
    if (toWrite == 0) {
      portEXIT_CRITICAL(&ttsMux);
      return 0;
    }

    size_t firstPart = (currentHead + toWrite <= TTS_BUFFER_SIZE) ? toWrite : (TTS_BUFFER_SIZE - currentHead);
    size_t secondPart = toWrite - firstPart;

    memcpy(ttsRingBuffer + currentHead, data, firstPart);
    if (secondPart > 0) {
      memcpy(ttsRingBuffer, data + firstPart, secondPart);
    }

    ttsHead = (currentHead + toWrite) % TTS_BUFFER_SIZE;
    portEXIT_CRITICAL(&ttsMux);
    return toWrite;
  }

  size_t ttsBufferPop(uint8_t* dest, size_t maxLen) {
    if (ttsRingBuffer == nullptr || maxLen == 0) return 0;
    portENTER_CRITICAL(&ttsMux);
    size_t currentTail = ttsTail;
    size_t currentHead = ttsHead;

    size_t availableBytes = (currentHead >= currentTail)
        ? (currentHead - currentTail)
        : (TTS_BUFFER_SIZE - currentTail + currentHead);

    size_t toRead = (maxLen > availableBytes) ? availableBytes : maxLen;
    if (toRead == 0) {
      portEXIT_CRITICAL(&ttsMux);
      return 0;
    }

    size_t firstPart = (currentTail + toRead <= TTS_BUFFER_SIZE) ? toRead : (TTS_BUFFER_SIZE - currentTail);
    size_t secondPart = toRead - firstPart;

    memcpy(dest, ttsRingBuffer + currentTail, firstPart);
    if (secondPart > 0) {
      memcpy(dest + firstPart, ttsRingBuffer, secondPart);
    }

    ttsTail = (currentTail + toRead) % TTS_BUFFER_SIZE;
    portEXIT_CRITICAL(&ttsMux);
    return toRead;
  }

  void ttsBufferClear() {
    portENTER_CRITICAL(&ttsMux);
    ttsHead = 0;
    ttsTail = 0;
    portEXIT_CRITICAL(&ttsMux);
  }

  size_t ttsBufferAvailable() {
    if (ttsRingBuffer == nullptr) return 0;
    portENTER_CRITICAL(&ttsMux);
    size_t count = (ttsHead >= ttsTail) ? (ttsHead - ttsTail) : (TTS_BUFFER_SIZE - ttsTail + ttsHead);
    portEXIT_CRITICAL(&ttsMux);
    return count;
  }

  size_t ttsBufferFreeSpace() {
    if (ttsRingBuffer == nullptr) return 0;
    portENTER_CRITICAL(&ttsMux);
    size_t currentTail = ttsTail;
    size_t currentHead = ttsHead;
    size_t freeSpace = (currentTail > currentHead)
        ? (currentTail - currentHead - 1)
        : (TTS_BUFFER_SIZE - currentHead + currentTail - 1);
    portEXIT_CRITICAL(&ttsMux);
    return freeSpace;
  }

  BluetoothA2DPSource a2dp_source;
  static volatile bool isBtSpeakerConnected = false;
  static volatile bool newScanDevice = false;
  static char lastScanMac[18] = {0};
  static char lastScanName[36] = {0};
  static volatile int lastScanRssi = 0;

  int32_t a2dp_data_callback(Frame* data, int32_t len) {
    // Processa amostras PCM Mono 16-bit (44.1kHz) do ring buffer e expande para Estéreo (L=R)
    size_t framesDone = 0;
    while (framesDone < (size_t)len) {
      size_t batch = ((size_t)len - framesDone > 256) ? 256 : ((size_t)len - framesDone);
      int16_t monoBuf[256];
      size_t bytesRead = ttsBufferPop((uint8_t*)monoBuf, batch * sizeof(int16_t));
      size_t samplesRead = bytesRead / sizeof(int16_t);

      for (size_t i = 0; i < samplesRead; i++) {
        data[framesDone + i].channel1 = monoBuf[i];
        data[framesDone + i].channel2 = monoBuf[i];
      }
      for (size_t i = samplesRead; i < batch; i++) {
        data[framesDone + i].channel1 = 0;
        data[framesDone + i].channel2 = 0;
      }
      framesDone += batch;
    }
    return len;
  }

  bool bt_ssid_callback(const char* ssid, esp_bd_addr_t address, int rssi) {
    static esp_bd_addr_t lastLoggedBda = {0};
    static unsigned long lastLogMs = 0;
    bool isSame = (memcmp(lastLoggedBda, address, ESP_BD_ADDR_LEN) == 0);
    if (!isSame || (millis() - lastLogMs > 2000)) {
      memcpy(lastLoggedBda, address, ESP_BD_ADDR_LEN);
      lastLogMs = millis();
      snprintf(lastScanMac, sizeof(lastScanMac), "%02X:%02X:%02X:%02X:%02X:%02X",
               address[0], address[1], address[2], address[3], address[4], address[5]);
      if (ssid && strlen(ssid) > 0) {
        strncpy(lastScanName, ssid, sizeof(lastScanName) - 1);
        lastScanName[sizeof(lastScanName) - 1] = '\0';
      } else {
        strncpy(lastScanName, "<aguardando>", sizeof(lastScanName) - 1);
      }
      lastScanRssi = rssi;
      newScanDevice = true;

      LOG_PRINTF("[BT-SCAN] 📡 MAC: %s | Nome: '%s' | RSSI: %d dBm\n",
                 lastScanMac, lastScanName, rssi);
    }

    // 1. Match direto se um MAC foi explicitamente configurado pelo usuário
    if (hasTargetMac && memcmp(targetBtMac, address, ESP_BD_ADDR_LEN) == 0) {
      LOG_PRINTF("\n[BT-SCAN] 🎯 ALVO ENCONTRADO POR MAC CONFIGURADO (%s)! Conectando A2DP...\n", lastScanMac);
      return true;
    }

    // 2. Match por Nome do dispositivo (case-insensitive) para caixas de som comuns
    if (ssid != nullptr && strlen(ssid) > 0) {
      if (strcasestr(ssid, "BT-SPEAKER") != nullptr ||
          strcasestr(ssid, "BT_SPEAKER") != nullptr ||
          strcasestr(ssid, "SPEAKER") != nullptr ||
          strcasestr(ssid, "SOUNDCORE") != nullptr ||
          strcasestr(ssid, "MINI") != nullptr ||
          strcasestr(ssid, "CAIXA") != nullptr ||
          strcasestr(ssid, "SOM") != nullptr ||
          strcasestr(ssid, "BOOMBOX") != nullptr ||
          strcasestr(ssid, "JBL") != nullptr ||
          strcasestr(ssid, "AUDIO") != nullptr ||
          strcasestr(ssid, "MUSIC") != nullptr ||
          strcasestr(ssid, "WIRELESS") != nullptr ||
          strcasestr(ssid, "BOX") != nullptr) {
        LOG_PRINTF("\n[BT-SCAN] 🎯 ALVO ENCONTRADO POR NOME: '%s' (%s)! Conectando A2DP...\n", ssid, lastScanMac);
        return true;
      }
    }
    return false;
  }

  static volatile bool btStateChanged = false;
  extern unsigned long speakerMuteUntil;
  void a2dp_connection_state_changed(esp_a2d_connection_state_t state, void* obj) {
    if (state == ESP_A2D_CONNECTION_STATE_CONNECTED) {
      isBtSpeakerConnected = true;
      btStateChanged = true;
      LOG_PRINTLN("\n=======================================================");
      LOG_PRINTLN("[BT-A2DP] ✅ CONECTADO COM SUCESSO À CAIXA DE SOM BLUETOOTH!");
      LOG_PRINTLN("=======================================================\n");
    } else if (state == ESP_A2D_CONNECTION_STATE_DISCONNECTED) {
      isBtSpeakerConnected = false;
      btStateChanged = true;
      ttsBufferClear();
      speakerMuteUntil = 0;
      LOG_PRINTLN("\n[BT-A2DP] ⚠️ Caixa de som desconectada. Buffer TTS limpo e VAD 100% ativo.");
    }
  }
#endif

#define I2S_SAMPLE_RATE     16000
#define BUFFER_PAIRS        256 // 256 pares (512 samples) = 16ms por leitura

// Gravação de voz: até 2.0 segundos local (fallback HTTP) e até 10.0s via WebSocket
#define MAX_RECORD_SECONDS        2.0f
#define MAX_RECORD_SAMPLES        (int)(16000 * MAX_RECORD_SECONDS) // 32.000 amostras
#define MAX_STREAM_RECORD_SAMPLES 160000 // Até 10.0 segundos de fala contínua via WebSocket
#define WAV_HEADER_SIZE           44
#define MAX_RECORD_BYTES          (WAV_HEADER_SIZE + MAX_RECORD_SAMPLES * 2) // 64.044 bytes

WebSocketsClient webSocket;
int32_t audioBuffer[BUFFER_PAIRS * 2]; // Captura Stereo (Left/Right mic)

uint8_t* wavBuffer = nullptr;
uint32_t maxRecordSamples = 64000;
uint32_t recordedSamples = 0;

enum MicState {
  STATE_IDLE,
  STATE_RECORDING,
  STATE_SENDING
};
MicState micState = STATE_IDLE;
int voiceDetectFrames = 0;
int silenceFrames = 0;
unsigned long lastPostTime = 0;

// VAD & Calibração Acústica de Alta Precisão (Rejeição de Ruído e Baixa Latência)
#define NOISE_FLOOR_RMS           400.0f
#define VAD_THRESHOLD_RMS         700.0f   // Fala humana clara (conversacional = 700-2500 RMS)
#define VAD_SILENCE_RMS           480.0f   // Fim da fala (RMS cai abaixo de 480; evita cortar consoantes/fala suave)
#define VAD_TRIGGER_FRAMES        3        // 3 frames consecutivos (~48ms de voz sustentada)
#define VAD_SILENCE_FRAMES_END    88       // 88 frames de silêncio (~1408ms): espera o usuário terminar a frase
#define MIN_SPEECH_FRAMES         4        // Pelo menos 4 frames (~64ms) de energia de voz
#define MIN_RECORDED_SAMPLES      4800     // Pelo menos 300ms gravados

// Limiar e sensibilidade para interrupção de fala legítima (Barge-In) durante reprodução da EVA
#define VAD_BARGE_IN_THRESHOLD_RMS 4200.0f // Exige voz alta próxima ao microfone para superar o som da caixa
#define VAD_BARGE_IN_TRIGGER_FRAMES 6      // ~96ms de voz alta sustentada para Barge-In

// Pré-roll circular de ~128ms (8 blocos de 256 amostras) para garantir captura integral do "Eva"
#define PREROLL_FRAMES            8
#define PREROLL_SAMPLES           (PREROLL_FRAMES * BUFFER_PAIRS)
int16_t prerollBuffer[PREROLL_SAMPLES];
int prerollHead = 0;
int speechFramesCount = 0;

// Streaming de Áudio em Chunks (T1 - P0 Latency Optimization)
#define CHUNK_SAMPLES             1024  // 64ms a 16kHz
#define CHUNK_BYTES               (CHUNK_SAMPLES * sizeof(int16_t)) // 2048 bytes
int16_t streamChunkBuffer[CHUNK_SAMPLES];
size_t streamChunkIndex = 0;
uint32_t streamDroppedChunks = 0;
static int16_t linPreroll[PREROLL_SAMPLES];

unsigned long speakerMuteUntil = 0;

void sendBluetoothCommand(const String& cmd) {
  LOG_PRINTF("[BT-CMD] %s\n", cmd.c_str());
}

void fillWavHeader(uint8_t* header, uint32_t pcmDataBytes) {
  if (header == nullptr) return;
  uint32_t totalDataLen = pcmDataBytes;
  uint32_t totalFileLen = totalDataLen + 36;
  uint32_t sampleRate = 16000;
  uint16_t channels = 1;
  uint16_t bitsPerSample = 16;
  uint32_t byteRate = sampleRate * channels * (bitsPerSample / 8);
  uint16_t blockAlign = channels * (bitsPerSample / 8);

  header[0] = 'R'; header[1] = 'I'; header[2] = 'F'; header[3] = 'F';
  header[4] = (uint8_t)(totalFileLen & 0xff);
  header[5] = (uint8_t)((totalFileLen >> 8) & 0xff);
  header[6] = (uint8_t)((totalFileLen >> 16) & 0xff);
  header[7] = (uint8_t)((totalFileLen >> 24) & 0xff);
  header[8] = 'W'; header[9] = 'A'; header[10] = 'V'; header[11] = 'E';
  header[12] = 'f'; header[13] = 'm'; header[14] = 't'; header[15] = ' ';
  header[16] = 16; header[17] = 0; header[18] = 0; header[19] = 0;
  header[20] = 1; header[21] = 0; // PCM
  header[22] = (uint8_t)channels; header[23] = 0;
  header[24] = (uint8_t)(sampleRate & 0xff);
  header[25] = (uint8_t)((sampleRate >> 8) & 0xff);
  header[26] = (uint8_t)((sampleRate >> 16) & 0xff);
  header[27] = (uint8_t)((sampleRate >> 24) & 0xff);
  header[28] = (uint8_t)(byteRate & 0xff);
  header[29] = (uint8_t)((byteRate >> 8) & 0xff);
  header[30] = (uint8_t)((byteRate >> 16) & 0xff);
  header[31] = (uint8_t)((byteRate >> 24) & 0xff);
  header[32] = (uint8_t)blockAlign; header[33] = 0;
  header[34] = (uint8_t)bitsPerSample; header[35] = 0;
  header[36] = 'd'; header[37] = 'a'; header[38] = 't'; header[39] = 'a';
  header[40] = (uint8_t)(totalDataLen & 0xff);
  header[41] = (uint8_t)((totalDataLen >> 8) & 0xff);
  header[42] = (uint8_t)((totalDataLen >> 16) & 0xff);
  header[43] = (uint8_t)((totalDataLen >> 24) & 0xff);
}

void sendVoiceToBackend(unsigned long t0_cutoff = 0) {
  if (wavBuffer == nullptr) {
    LOG_PRINTLN("[EVA] ⚠️ wavBuffer é nulo, ignorando HTTP POST.");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    LOG_PRINTLN("[EVA] Wi-Fi desconectado. Cancelando envio de áudio.");
    return;
  }
  if (recordedSamples < MIN_RECORDED_SAMPLES) { // menos de 0.5s de gravação
    LOG_PRINTF("[EVA] Áudio muito curto (%u amostras). Descartado.\n", recordedSamples);
    return;
  }

  uint32_t pcmBytes = recordedSamples * 2;
  fillWavHeader(wavBuffer, pcmBytes);
  uint32_t totalWavBytes = WAV_HEADER_SIZE + pcmBytes;

  LOG_PRINTF("[EVA] 🚀 Enviando %u bytes (%.2fs de áudio WAV) para EVA via HTTP POST...\n", 
             totalWavBytes, (float)recordedSamples / 16000.0f);

  HTTPClient http;
  http.begin(SERVER_VOICE_URL);
  http.addHeader("Content-Type", "audio/wav");
  if (t0_cutoff > 0) {
    http.addHeader("X-VAD-Cutoff-Elapsed-Ms", String(millis() - t0_cutoff));
  }
  http.setTimeout(15000); // 15s para dar tempo ao Whisper STT + LLM + TTS

  int httpCode = http.POST(wavBuffer, totalWavBytes);
  if (httpCode == HTTP_CODE_OK || httpCode == 200) {
    String response = http.getString();
    LOG_PRINTF("[EVA] 🤖 Resposta recebida da EVA (HTTP %d):\n%s\n", httpCode, response.c_str());

    // 1. Envia a resposta verbal da EVA via Bluetooth Serial
    int replyIdx = response.indexOf("\"reply\":");
    if (replyIdx >= 0) {
      int replyStart = response.indexOf("\"", replyIdx + 8);
      if (replyStart >= 0) {
        int replyEnd = response.indexOf("\"", replyStart + 1);
        if (replyEnd > replyStart) {
          String replyText = response.substring(replyStart + 1, replyEnd);
          sendBluetoothCommand("EVA:" + replyText);
        }
      }
    }

    // 2. Extrai e envia execuções de ferramentas/comandos IoT via Bluetooth Serial
    int toolIdx = response.indexOf("\"toolExecutions\":");
    if (toolIdx >= 0) {
      int toolEnd = response.indexOf("]", toolIdx);
      if (toolEnd > toolIdx) {
        String toolsJson = response.substring(toolIdx, toolEnd + 1);
        LOG_PRINTF("[BT] ⚙️ Comando de ferramenta detectado: %s\n", toolsJson.c_str());
        sendBluetoothCommand("CMD:" + toolsJson);
      }
    }

    int durIdx = response.indexOf("\"durationMs\":");
    if (durIdx >= 0) {
      unsigned long dur = response.substring(durIdx + 13).toInt();
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
      if (dur >= 2000 && dur <= 60000 && isBtSpeakerConnected) {
        speakerMuteUntil = millis() + dur + 500;
        LOG_PRINTF("[AEC] 🔇 Mudo ativado pela resposta da EVA: %lu ms.\n", dur + 500);
      }
#else
      if (dur >= 2000 && dur <= 60000) {
        speakerMuteUntil = millis() + dur + 500;
        LOG_PRINTF("[AEC] 🔇 Mudo ativado pela resposta da EVA: %lu ms.\n", dur + 500);
      }
#endif
    }
  } else {
    LOG_PRINTF("[EVA] ⚠️ Erro HTTP ao enviar voz: %d (%s)\n", httpCode, http.errorToString(httpCode).c_str());
  }
  http.end();

  // Limpa o DMA buffer do I2S para não processar eco antigo
  i2s_zero_dma_buffer(I2S_NUM_0);
}

void i2sMicInit() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
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
    LOG_PRINTF("[I2S] ERRO na instalação do driver: 0x%04x\n", err);
    return;
  }

  err = i2s_set_pin(I2S_NUM_0, &pin_config);
  if (err != ESP_OK) {
    LOG_PRINTF("[I2S] ERRO ao atribuir pinos: 0x%04x\n", err);
    return;
  }

  LOG_PRINTLN("[I2S] Microfone inicializado com captura estéreo.");
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      LOG_PRINTF("[WebSocket] ⚠️ Desconectado do servidor EVA. Motivo: '%s' (len: %u)\n", payload ? (char*)payload : "nenhum", (unsigned int)length);
      break;
    case WStype_ERROR:
      LOG_PRINTF("[WebSocket] ❌ Erro de conexão: %s\n", payload ? (char*)payload : "");
      break;
    case WStype_CONNECTED: {
      LOG_PRINTLN("[WebSocket] ✅ CONECTADO COM SUCESSO AO BACKEND EVA!");
      printMemoryReport("AFTER_WS_CONNECT");
      webSocket.sendTXT("{\"level\":0,\"rms\":0.0}");
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
      bool curConnected = a2dp_source.is_connected();
      char btInitJson[96];
      snprintf(btInitJson, sizeof(btInitJson), "{\"type\":\"bt_state\",\"connected\":%s,\"deviceName\":\"%s\"}",
               curConnected ? "true" : "false", BT_SPEAKER_NAME);
      webSocket.sendTXT(btInitJson);

      char flowJson[64];
      snprintf(flowJson, sizeof(flowJson), "{\"type\":\"flow_control\",\"free_bytes\":%u}", (unsigned int)ttsBufferFreeSpace());
      webSocket.sendTXT(flowJson);
#endif
      break;
    }
    case WStype_BIN: {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
      // Áudio PCM 44.1kHz Mono 16-bit recebido para tocar na caixa Bluetooth
      if (isBtSpeakerConnected && payload != nullptr && length > 0) {
        ttsBufferPush(payload, length);
        char flowJson[64];
        snprintf(flowJson, sizeof(flowJson), "{\"type\":\"flow_control\",\"free_bytes\":%u}", (unsigned int)ttsBufferFreeSpace());
        webSocket.sendTXT(flowJson);
      } else {
        ttsBufferClear();
      }
#endif
      break;
    }
    case WStype_TEXT: {
      String msg = String((char*)payload);
      if (msg.indexOf("\"interrupt\"") >= 0) {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
        ttsBufferClear();
#endif
        speakerMuteUntil = 0;
        LOG_PRINTLN("[BARGE-IN] ⚡ Interrupção de fala recebida! Buffer A2DP limpo e VAD reativado imediatamente.");
      } else if (msg.indexOf("\"cmd\":\"connect_bt\"") >= 0 || msg.indexOf("\"connect_bt\"") >= 0) {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
        int macIdx = msg.indexOf("\"mac\":\"");
        if (macIdx >= 0) {
          String macStr = msg.substring(macIdx + 7, macIdx + 24);
          unsigned int b[6];
          if (sscanf(macStr.c_str(), "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) == 6) {
            for (int i = 0; i < 6; i++) targetBtMac[i] = (uint8_t)b[i];
            hasTargetMac = true;
            LOG_PRINTF("[BT-A2DP] 🔄 Conectando diretamente ao MAC alvo: %s\n", macStr.c_str());
            a2dp_source.connect_to(targetBtMac);
          }
        } else {
          LOG_PRINTLN("[BT-A2DP] 🔄 Iniciando varredura e pareamento de caixas Bluetooth...");
          a2dp_source.cancel_discovery();
          esp_bt_gap_start_discovery(ESP_BT_INQ_MODE_GENERAL_INQUIRY, 10, 0);
        }
#endif
      } else if (msg.indexOf("\"cmd\":\"scan_bt\"") >= 0 || msg.indexOf("\"scan_bt\"") >= 0) {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
        LOG_PRINTLN("[BT-A2DP] 📡 Varredura solicitada. Iniciando busca GAP...");
        a2dp_source.cancel_discovery();
        esp_bt_gap_start_discovery(ESP_BT_INQ_MODE_GENERAL_INQUIRY, 10, 0);
#endif
      } else if (msg.indexOf("\"cmd\":\"get_bt_status\"") >= 0 || msg.indexOf("\"get_bt_status\"") >= 0) {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
        bool curConnected = a2dp_source.is_connected();
        char btStatusJson[96];
        snprintf(btStatusJson, sizeof(btStatusJson), "{\"type\":\"bt_state\",\"connected\":%s,\"deviceName\":\"%s\"}",
                 curConnected ? "true" : "false", BT_SPEAKER_NAME);
        webSocket.sendTXT(btStatusJson);
#endif
      } else if (msg.indexOf("\"tts_start\"") >= 0) {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
        ttsBufferClear();
        char flowJson[64];
        snprintf(flowJson, sizeof(flowJson), "{\"type\":\"flow_control\",\"free_bytes\":%u}", (unsigned int)ttsBufferFreeSpace());
        webSocket.sendTXT(flowJson);
#endif
        LOG_PRINTLN("[TTS] 🔊 Início de reprodução TTS via Bluetooth A2DP...");
      } else if (msg.indexOf("\"tts_end\"") >= 0) {
        LOG_PRINTLN("[TTS] 🔈 Fim do streaming de áudio TTS.");
      } else if (msg.indexOf("\"cmd\":\"speaking_start\"") >= 0 || msg.indexOf("\"speaking_start\"") >= 0 ||
                 (msg.indexOf("\"cmd\":\"speaker\"") >= 0 && msg.indexOf("true") >= 0)) {
        unsigned long dur = 5000;
        int durIdx = msg.indexOf("\"durationMs\":");
        if (durIdx >= 0) {
          unsigned long parsed = msg.substring(durIdx + 13).toInt();
          if (parsed >= 500 && parsed <= 120000) dur = parsed;
        }
        // Folga de ~500ms por causa do buffer interno da caixinha Bluetooth
        speakerMuteUntil = millis() + dur + 500;
        LOG_PRINTF("[AEC] 🔊 EVA falando (speaking_start). Janela com folga BT: %lu ms.\n", dur + 500);
      } else if (msg.indexOf("\"cmd\":\"speaking_end\"") >= 0 || msg.indexOf("\"speaking_end\"") >= 0 ||
                 (msg.indexOf("\"cmd\":\"speaker\"") >= 0 && msg.indexOf("false") >= 0)) {
        bool isInterrupt = (msg.indexOf("\"interrupt\":true") >= 0 || msg.indexOf("\"interrupt\": true") >= 0);
        if (isInterrupt) {
          speakerMuteUntil = 0;
          ttsBufferClear();
          LOG_PRINTLN("[AEC] ⚡ Interrupção de fala (Barge-In). VAD reativado imediatamente.");
        } else {
          // Mantém folga de 500ms para permitir que os últimos bytes no buffer interno da caixinha terminem de tocar
          speakerMuteUntil = millis() + 500;
          LOG_PRINTLN("[AEC] 🔈 EVA finalizou fala (speaking_end). Folga de 500ms para esvaziar buffer BT.");
        }
      } else if (msg.indexOf("\"cmd\":\"conversation_log\"") >= 0) {
        int statusIdx = msg.indexOf("\"status\":");
        String status = "";
        if (statusIdx >= 0) {
          int sStart = msg.indexOf("\"", statusIdx + 9);
          int sEnd = msg.indexOf("\"", sStart + 1);
          if (sStart >= 0 && sEnd > sStart) status = msg.substring(sStart + 1, sEnd);
        }

        int userIdx = msg.indexOf("\"user\":");
        String user = "";
        if (userIdx >= 0) {
          int uStart = msg.indexOf("\"", userIdx + 7);
          int uEnd = msg.indexOf("\"", uStart + 1);
          if (uStart >= 0 && uEnd > uStart) user = msg.substring(uStart + 1, uEnd);
        }

        if (status == "answered") {
          int replyIdx = msg.indexOf("\"reply\":");
          String reply = "";
          if (replyIdx >= 0) {
            int rStart = msg.indexOf("\"", replyIdx + 8);
            int rEnd = msg.indexOf("\"", rStart + 1);
            if (rStart >= 0 && rEnd > rStart) reply = msg.substring(rStart + 1, rEnd);
          }
          int latIdx = msg.indexOf("\"latencyMs\":");
          long lat = 0;
          if (latIdx >= 0) lat = msg.substring(latIdx + 12).toInt();

          LOG_PRINTLN("\n================== [CONVERSAÇÃO EVA] ==================");
          LOG_PRINTF("👤 USUÁRIO: \"%s\"\n", user.c_str());
          LOG_PRINTF("🤖 EVA:     \"%s\"\n", reply.c_str());
          LOG_PRINTF("⏱️ LATÊNCIA: %ld ms\n", lat);
          LOG_PRINTLN("=======================================================\n");
        } else if (status == "ignored_ambient") {
          LOG_PRINTF("[VAD] 🛡️ Áudio ambiente ignorado (sem 'Eva'): \"%s\"\n", user.c_str());
        }
      }
      break;
    }
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  Serial0.begin(115200);
#endif
  delay(1000);

  esp_reset_reason_t rstReason = esp_reset_reason();
  LOG_PRINTF("\n[RESET REASON] 🔍 Motivo do boot: %d (%s)\n", (int)rstReason, getResetReasonString(rstReason));
  printMemoryReport("BOOT");

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  esp_bt_controller_mem_release(ESP_BT_MODE_BLE);
#endif

  LOG_PRINTLN("\n==================================");
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  LOG_PRINTLN("    EVA — ESP32-S3 VOICE ENGINE   ");
#else
  LOG_PRINTLN("    EVA — ESP32 CLASSIC VOICE ENGINE");
#endif
  LOG_PRINTLN("==================================");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  i2sMicInit();

  LOG_PRINTF("[WiFi] Conectando a: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 50) {
    delay(300);
    LOG_PRINTLN(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    LOG_PRINTLN("\n[WiFi] Conectado!");
    LOG_PRINTF("[WiFi] IP do ESP32: %s\n", WiFi.localIP().toString().c_str());
    LOG_PRINTF("[EVA] Backend: %s\n", SERVER_VOICE_URL);

    // Auto-registro dinâmico de IP no servidor EVA
    HTTPClient regHttp;
    String regUrl = "http://192.168.2.146:8080/api/esp32/register?ip=" + WiFi.localIP().toString();
    regHttp.begin(regUrl);
    regHttp.setTimeout(2500);
    int regCode = regHttp.GET();
    if (regCode == 200) {
      LOG_PRINTLN("[EVA] ✅ Registrado com sucesso no servidor!");
    }
    regHttp.end();
  } else {
    LOG_PRINTLN("\n[WiFi] Falha ao conectar. Operando modo offline.");
  }

  webSocket.begin(SERVER_HOST, SERVER_PORT, "/api/esp32/ws", "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(1500);
  LOG_PRINTF("[WebSocket] Cliente configurado para ws://%s:%u/api/esp32/ws\n", SERVER_HOST, SERVER_PORT);

  // Estabelece a conexão WebSocket inicial com heap livre abundante (>150KB) antes do Bluedroid
  unsigned long wsStart = millis();
  while (!webSocket.isConnected() && millis() - wsStart < 2500) {
    webSocket.loop();
    delay(50);
  }
  if (webSocket.isConnected()) {
    LOG_PRINTLN("[WebSocket] ✅ Conexão WebSocket estabelecida no boot!");
    printMemoryReport("AFTER_WS_CONNECT");
  } else {
    LOG_PRINTLN("[WebSocket] ⏳ Handshake em andamento; continuará no loop principal.");
  }

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
  ttsRingBuffer = (uint8_t*)malloc(TTS_BUFFER_SIZE);
  if (ttsRingBuffer != nullptr) {
    LOG_PRINTF("[MEM] ✅ Buffer A2DP alocado: %d bytes (%.1f KB)\n", TTS_BUFFER_SIZE, TTS_BUFFER_SIZE / 1024.0);
  }

#if BT_ENABLED
  a2dp_source.set_ssp_enabled(true);
  a2dp_source.set_ssid_callback(bt_ssid_callback);
  a2dp_source.set_on_connection_state_changed(a2dp_connection_state_changed);
  a2dp_source.set_auto_reconnect(true, 3);
  a2dp_source.start(BT_SPEAKER_NAME, a2dp_data_callback);
  LOG_PRINTF("[BT-A2DP] 🎵 A2DP Source iniciado buscando '%s' (SSP ativo)...\n", BT_SPEAKER_NAME);
  printMemoryReport("AFTER_A2DP_START");
#else
  LOG_PRINTLN("[BT-A2DP] ⏸️ Bluetooth DESLIGADO (BT_ENABLED=0) para estabilizar Wi-Fi.");
  printMemoryReport("AFTER_A2DP_SKIPPED");
#endif
#endif

  size_t freeHeap = esp_get_free_heap_size();
  LOG_PRINTF("[MEM] 🏁 Setup concluído! Heap livre pós-BT: %u bytes\n", freeHeap);
  printMemoryReport("SETUP_DONE");
}

void loop() {
  webSocket.loop();

  static unsigned long lastMemReport = 0;
  if (millis() - lastMemReport >= 5000) {
    lastMemReport = millis();
    printMemoryReport("RUN_5S");
  }

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  static unsigned long lastFlowReport = 0;
  static size_t lastReportedFree = 0;
  if (isBtSpeakerConnected && (ttsBufferAvailable() > 0 || millis() - lastFlowReport < 400)) {
    if (millis() - lastFlowReport >= 30) {
      size_t curFree = ttsBufferFreeSpace();
      if (abs((long)curFree - (long)lastReportedFree) >= 512 && webSocket.isConnected()) {
        lastFlowReport = millis();
        lastReportedFree = curFree;
        char flowJson[64];
        snprintf(flowJson, sizeof(flowJson), "{\"type\":\"flow_control\",\"free_bytes\":%u}", (unsigned int)curFree);
        webSocket.sendTXT(flowJson);
      }
    }
  }

  static unsigned long lastBtCheck = 0;
  if (millis() - lastBtCheck > 1500) {
    lastBtCheck = millis();
    bool curBtConn = a2dp_source.is_connected();
    if (curBtConn != isBtSpeakerConnected) {
      isBtSpeakerConnected = curBtConn;
      btStateChanged = true;
    }
    // Se desconectado, limpa qualquer resíduo do buffer TTS para não travar o VAD
    if (!isBtSpeakerConnected && ttsBufferAvailable() > 0) {
      ttsBufferClear();
    }
  }

  if (btStateChanged) {
    btStateChanged = false;
    if (webSocket.isConnected()) {
      char btJson[96];
      snprintf(btJson, sizeof(btJson), "{\"type\":\"bt_state\",\"connected\":%s,\"deviceName\":\"%s\"}",
               isBtSpeakerConnected ? "true" : "false", BT_SPEAKER_NAME);
      webSocket.sendTXT(btJson);
    }
    LOG_PRINTF("[BT-A2DP] 📡 Status: %s\n", isBtSpeakerConnected ? "CONECTADO" : "PROCURANDO");
  }

  if (newScanDevice) {
    newScanDevice = false;
    if (webSocket.isConnected()) {
      char scanJson[128];
      snprintf(scanJson, sizeof(scanJson), "{\"type\":\"bt_scan\",\"mac\":\"%s\",\"name\":\"%s\",\"rssi\":%d}",
               lastScanMac, lastScanName, lastScanRssi);
      webSocket.sendTXT(scanJson);
    }
  }
#endif

  size_t bytesRead = 0;
  esp_err_t res = i2s_read(I2S_NUM_0, audioBuffer, sizeof(audioBuffer), &bytesRead, portMAX_DELAY);

  // Variáveis estáticas de controle de canal e filtro DC-Blocker
  static int activeMicChannel = 0; // 0 = Left, 1 = Right
  static float dcBlockerX = 0.0f;
  static float dcBlockerY = 0.0f;

  if (res == ESP_OK && bytesRead > 0) {
    size_t pairs = (bytesRead / sizeof(int32_t)) / 2;
    double sumL = 0, sumR = 0;
    int nonZero = 0;

    for (size_t i = 0; i < pairs; i++) {
      int32_t sL = audioBuffer[i * 2]     >> 14;
      int32_t sR = audioBuffer[i * 2 + 1] >> 14;
      sumL += sL;
      sumR += sR;
      if (audioBuffer[i * 2] != 0 || audioBuffer[i * 2 + 1] != 0) {
        nonZero++;
      }
    }

    double meanL = sumL / pairs;
    double meanR = sumR / pairs;
    double sqDiffL = 0, sqDiffR = 0;

    for (size_t i = 0; i < pairs; i++) {
      double acL = (audioBuffer[i * 2]     >> 14) - meanL;
      double acR = (audioBuffer[i * 2 + 1] >> 14) - meanR;
      sqDiffL += acL * acL;
      sqDiffR += acR * acR;
    }

    float rmsL = sqrt(sqDiffL / pairs);
    float rmsR = sqrt(sqDiffR / pairs);

    // INMP441 Mono: trava automaticamente no canal com microfone ativo.
    // NUNCA misturar com o canal flutuante para evitar ruído estático e corte de amplitude.
    if (rmsL > rmsR * 2.0f && rmsL > 150.0f) {
      activeMicChannel = 0;
    } else if (rmsR > rmsL * 2.0f && rmsR > 150.0f) {
      activeMicChannel = 1;
    }

    float activeRms = (activeMicChannel == 0) ? rmsL : rmsR;

    // Normaliza para 0 - 100% com filtro de piso de ruído
    int level = 0;
    if (activeRms > NOISE_FLOOR_RMS) {
      level = (int)(((activeRms - NOISE_FLOOR_RMS) / 1600.0f) * 100.0f);
      level = constrain(level, 0, 100);
    }

    // =========================================================================
    // MÁQUINA DE ESTADOS DO VAD (GRAVAÇÃO E ENVIO DE VOZ PARA O WHISPER)
    // =========================================================================
    // Suporte a Barge-In (Interrupção de Fala):
    // A captação VAD permanece ativa para que o usuário possa interromper com 'eva:'.
    // O backend descarta automaticamente qualquer eco que não contenha a palavra 'eva'.
    
    // Alimenta buffer circular de pré-roll (últimos 192ms) quando em repouso
    if (micState == STATE_IDLE) {
      for (size_t i = 0; i < pairs; i++) {
        int32_t raw = (activeMicChannel == 0) ? (audioBuffer[i * 2] >> 14) : (audioBuffer[i * 2 + 1] >> 14);

        // Filtro IIR DC-Blocker (corte ~13Hz): remove DC bias e ruídos de baixa frequência
        float x = (float)raw;
        float y = x - dcBlockerX + 0.995f * dcBlockerY;
        dcBlockerX = x;
        dcBlockerY = y;
        int32_t val = (int32_t)y;

        if (val > 32767) val = 32767;
        if (val < -32768) val = -32768;
        prerollBuffer[(prerollHead + i) % PREROLL_SAMPLES] = (int16_t)val;
      }
      prerollHead = (prerollHead + pairs) % PREROLL_SAMPLES;

      // Limiar dinâmico de VAD com AEC: se a EVA estiver falando (pelo tempo do speaking_start ou buffer com dados),
      // eleva o limiar para 4200 RMS para que o som da caixa não dispare o microfone, mas permitindo Barge-In legítimo
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
      bool isSpeakerActive = (millis() < speakerMuteUntil) || (isBtSpeakerConnected && ttsBufferAvailable() > 0);
#else
      bool isSpeakerActive = (millis() < speakerMuteUntil);
#endif
      float currentVadThreshold = isSpeakerActive ? VAD_BARGE_IN_THRESHOLD_RMS : VAD_THRESHOLD_RMS;
      uint8_t requiredTriggerFrames = isSpeakerActive ? VAD_BARGE_IN_TRIGGER_FRAMES : VAD_TRIGGER_FRAMES;

      // Fala humana sustentada detectada (RMS >= currentVadThreshold)
      if (activeRms >= currentVadThreshold) {
        voiceDetectFrames++;
        if (voiceDetectFrames >= requiredTriggerFrames) {
          if (isSpeakerActive) {
            LOG_PRINTF("[BARGE-IN] ⚡ Interrupção por voz alta durante fala da EVA (RMS: %.1f >= %.1f). Silenciando áudio!\n",
                       activeRms, currentVadThreshold);
            ttsBufferClear();     // Limpa o buffer local de áudio para não vazar eco na gravação
            speakerMuteUntil = 0; // Libera o microfone para gravar o usuário com máxima sensibilidade
          }
          micState = STATE_RECORDING;
          silenceFrames = 0;
          speechFramesCount = requiredTriggerFrames;
          streamChunkIndex = 0;
          digitalWrite(LED_PIN, HIGH);
          LOG_PRINTLN("[EVA] 🎙️ Fala humana detectada! Gravando e transmitindo...");
          webSocket.sendTXT("{\"type\":\"hw_status\",\"state\":\"recording\"}");

          // Copia o pré-roll para não perder o início da primeira palavra
          if (wavBuffer != nullptr) {
            int16_t* pcm16 = (int16_t*)(wavBuffer + WAV_HEADER_SIZE);
            for (int i = 0; i < PREROLL_SAMPLES; i++) {
              int16_t sample = prerollBuffer[(prerollHead + i) % PREROLL_SAMPLES];
              pcm16[i] = sample;
              linPreroll[i] = sample;
            }
          } else {
            for (int i = 0; i < PREROLL_SAMPLES; i++) {
              linPreroll[i] = prerollBuffer[(prerollHead + i) % PREROLL_SAMPLES];
            }
          }
          recordedSamples = PREROLL_SAMPLES;

          // Inicia streaming contínuo no WebSocket (T1 - P0)
          if (webSocket.isConnected()) {
            webSocket.sendTXT("{\"type\":\"audio_stream_start\"}");
            webSocket.sendBIN((uint8_t*)linPreroll, PREROLL_SAMPLES * sizeof(int16_t));
          }
        }
      } else {
        voiceDetectFrames = 0;
      }
    }

    if (micState == STATE_RECORDING) {
      for (size_t i = 0; i < pairs; i++) {
        int32_t raw = (activeMicChannel == 0) ? (audioBuffer[i * 2] >> 14) : (audioBuffer[i * 2 + 1] >> 14);

        // Filtro IIR DC-Blocker
        float x = (float)raw;
        float y = x - dcBlockerX + 0.995f * dcBlockerY;
        dcBlockerX = x;
        dcBlockerY = y;
        int32_t val = (int32_t)y;

        if (val > 32767) val = 32767;
        if (val < -32768) val = -32768;
        int16_t sample = (int16_t)val;

        if (wavBuffer != nullptr && recordedSamples < maxRecordSamples) {
          int16_t* pcm16 = (int16_t*)(wavBuffer + WAV_HEADER_SIZE);
          pcm16[recordedSamples] = sample;
        }
        recordedSamples++;

        streamChunkBuffer[streamChunkIndex++] = sample;
        if (streamChunkIndex >= CHUNK_SAMPLES) {
          if (webSocket.isConnected()) {
            // Backpressure: envia se o heap tiver pelo menos 4KB livres
            if (esp_get_free_heap_size() >= 4096) {
              webSocket.sendBIN((uint8_t*)streamChunkBuffer, CHUNK_BYTES);
            } else {
              streamDroppedChunks++;
            }
          }
          streamChunkIndex = 0;
        }
      }

      // Contabiliza frames que possuem energia real de fala
      if (activeRms >= VAD_SILENCE_RMS) {
        speechFramesCount++;
      }

      // Fim da fala por silêncio rápido (RMS < VAD_SILENCE_RMS = 550)
      if (activeRms < VAD_SILENCE_RMS) {
        silenceFrames++;
        if (silenceFrames >= VAD_SILENCE_FRAMES_END && recordedSamples >= MIN_RECORDED_SAMPLES) {
          micState = STATE_SENDING;
        }
      } else {
        silenceFrames = 0;
      }

      uint32_t limitSamples = (webSocket.isConnected()) ? MAX_STREAM_RECORD_SAMPLES : maxRecordSamples;
      if (recordedSamples >= limitSamples) {
        micState = STATE_SENDING;
      }
    }

    if (micState == STATE_SENDING) {
      unsigned long t0_cutoff = millis();
      digitalWrite(LED_PIN, LOW);

      // Validação anti-falso-positivo: descarta se não houver fala real suficiente
      if (speechFramesCount < MIN_SPEECH_FRAMES || recordedSamples < MIN_RECORDED_SAMPLES) {
        LOG_PRINTF("[VAD] ⚠️ Descartado ruído impulsivo/estalo (%d frames de voz, %u amostras).\n",
                   speechFramesCount, recordedSamples);
        if (webSocket.isConnected()) {
          webSocket.sendTXT("{\"type\":\"audio_stream_cancel\"}");
        }
        micState = STATE_IDLE;
        voiceDetectFrames = 0;
        silenceFrames = 0;
        speechFramesCount = 0;
        streamChunkIndex = 0;
        webSocket.sendTXT("{\"type\":\"hw_status\",\"state\":\"idle\"}");
      } else {
        if (webSocket.isConnected()) {
          // Flush do chunk residual final (se houver amostras pendentes)
          if (streamChunkIndex > 0) {
            webSocket.sendBIN((uint8_t*)streamChunkBuffer, streamChunkIndex * sizeof(int16_t));
            streamChunkIndex = 0;
          }
          unsigned long t_upload_complete = millis();
          char endMsg[160];
          snprintf(endMsg, sizeof(endMsg),
                   "{\"type\":\"audio_stream_end\",\"t0\":%lu,\"t_upload_complete\":%lu,\"samples\":%u,\"dropped\":%u}",
                   t0_cutoff, t_upload_complete, recordedSamples, streamDroppedChunks);
          webSocket.sendTXT(endMsg);

          LOG_PRINTF("[STREAM T1] ⚡ Áudio finalizado! Cutoff -> Upload: %lu ms (%u amostras, %u descartes)\n",
                     t_upload_complete - t0_cutoff, recordedSamples, streamDroppedChunks);

          lastPostTime = millis();
          micState = STATE_IDLE;
          voiceDetectFrames = 0;
          silenceFrames = 0;
          speechFramesCount = 0;
          streamDroppedChunks = 0;
        } else {
          // Fallback HTTP POST caso nenhum cliente WebSocket esteja conectado
          if (wavBuffer != nullptr) {
            webSocket.sendTXT("{\"type\":\"hw_status\",\"state\":\"sending\"}");
            sendVoiceToBackend(t0_cutoff);
          } else {
            LOG_PRINTLN("[EVA] ⚠️ Sem cliente WebSocket conectado e sem buffer WAV; gravação descartada.");
          }
          lastPostTime = millis();
          micState = STATE_IDLE;
          voiceDetectFrames = 0;
          silenceFrames = 0;
          speechFramesCount = 0;
          streamChunkIndex = 0;
          streamDroppedChunks = 0;
        }
      }
    }

    // Telemetria via WebSocket a cada ~200ms (reduz tráfego de rede e previne colisões com Bluetooth/Wi-Fi)
    static unsigned long lastWs = 0;
    if (webSocket.isConnected() && millis() - lastWs > 200 && micState != STATE_SENDING) {
      lastWs = millis();
      char jsonMsg[110];
      snprintf(jsonMsg, sizeof(jsonMsg), "{\"level\":%d,\"rms\":%.1f,\"rmsL\":%.1f,\"rmsR\":%.1f,\"nz\":%d,\"st\":\"%s\"}",
               level, activeRms, rmsL, rmsR, nonZero, 
               (micState == STATE_RECORDING ? "rec" : (micState == STATE_SENDING ? "send" : "idle")));
      webSocket.sendTXT(jsonMsg);
    }

    // Log na Serial a cada 1000ms
    static unsigned long lastSerial = 0;
    if (millis() - lastSerial > 1000 && micState == STATE_IDLE) {
      lastSerial = millis();
      if (nonZero == 0) {
        LOG_PRINTLN("[MIC] SINAL ZERO (0.0). Verifique pinos SD/SCK/WS/VDD.");
      } else {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
        bool btConn = a2dp_source.is_connected();
#else
        bool btConn = false;
#endif
        LOG_PRINTF("[EVA-HW] IP: %s | BT: %s | RMS: %.1f | Vol: %d%%\n", 
                   WiFi.localIP().toString().c_str(),
                   btConn ? "CONECTADO (BT-SPEAKER)" : "PROCURANDO BT-SPEAKER...",
                   activeRms, level);
      }
    }
  }

  // Auto-reconectar Wi-Fi com debounce seguro
  static bool wasConnected = true;
  static unsigned long disconnectStart = 0;

  if (WiFi.status() != WL_CONNECTED) {
    if (disconnectStart == 0) {
      disconnectStart = millis();
    } else if (millis() - disconnectStart > 5000 && wasConnected) {
      wasConnected = false;
      LOG_PRINTLN("[WiFi] ⚠️ Wi-Fi desconectado por mais de 5s. Tentando reconectar...");
      WiFi.reconnect();
    }
  } else {
    disconnectStart = 0;
    if (!wasConnected) {
      wasConnected = true;
      LOG_PRINTF("[WiFi] ✅ Conexão restabelecida! IP: %s\n", WiFi.localIP().toString().c_str());
      webSocket.begin(SERVER_HOST, SERVER_PORT, "/api/esp32/ws", "");
    }
  }
}

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
#include <WebSocketsServer.h>
#include "driver/i2s.h"
#include <math.h>

// Configurações de Rede
const char* WIFI_SSID = "Julimara";
const char* WIFI_PASS = "julimara13";
const char* SERVER_VOICE_URL = "http://192.168.100.38:8080/api/pipeline/voice";

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
  #include "BluetoothSerial.h"
  #define I2S_SD_PIN   32  // Serial Data / DOUT (compartilhado por ambos os microfones)
  #define I2S_WS_PIN   15  // Word Select / LRCLK (compartilhado)
  #define I2S_SCK_PIN  14  // Serial Clock / BCLK (compartilhado)
  #define LED_PIN      2   // LED Azul onboard padrão do ESP32 clássico
  #define LOG_PRINTLN(x) Serial.println(x)
  #define LOG_PRINTF(...) Serial.printf(__VA_ARGS__)

  BluetoothSerial SerialBT;
  const char* BT_DEVICE_NAME = "EVA_Assistant";
#endif

#define I2S_SAMPLE_RATE     16000
#define BUFFER_PAIRS        256 // 256 pares (512 samples) = 16ms por leitura

// Gravação de voz: até 3.5 segundos a 16kHz 16-bit mono
#define MAX_RECORD_SECONDS  3.5f
#define MAX_RECORD_SAMPLES  (int)(16000 * MAX_RECORD_SECONDS) // 56.000 amostras
#define WAV_HEADER_SIZE     44
#define MAX_RECORD_BYTES    (WAV_HEADER_SIZE + MAX_RECORD_SAMPLES * 2) // 112.044 bytes

WebSocketsServer webSocket = WebSocketsServer(80);
int32_t audioBuffer[BUFFER_PAIRS * 2]; // Captura Stereo (Left mic)
uint8_t* wavBuffer = nullptr;
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
#define NOISE_FLOOR_RMS           450.0f
#define VAD_THRESHOLD_RMS         1150.0f  // Exige fala real clara (voz humana = 1200-3000 RMS)
#define VAD_SILENCE_RMS           620.0f   // Fim da fala (acima do ruído ambiente, abaixo da fala)
#define VAD_TRIGGER_FRAMES        7        // 7 frames consecutivos (~112ms de voz sustentada)
#define VAD_SILENCE_FRAMES_END    18       // 18 frames de silêncio (~288ms para envio ultrarrápido)
#define MIN_SPEECH_FRAMES         10       // Pelo menos 10 frames (~160ms) de energia de voz no áudio
#define MIN_RECORDED_SAMPLES      8000     // Pelo menos 0.5s de áudio gravado

// Pré-roll circular de 192ms (12 blocos de 256 amostras) para não perder o início da fala
#define PREROLL_FRAMES            12
#define PREROLL_SAMPLES           (PREROLL_FRAMES * BUFFER_PAIRS)
int16_t prerollBuffer[PREROLL_SAMPLES];
int prerollHead = 0;
int speechFramesCount = 0;

// Streaming de Áudio em Chunks (T1 - P0 Latency Optimization)
#define CHUNK_SAMPLES             2048  // 128ms a 16kHz
#define CHUNK_BYTES               (CHUNK_SAMPLES * sizeof(int16_t)) // 4096 bytes
int16_t streamChunkBuffer[CHUNK_SAMPLES];
size_t streamChunkIndex = 0;
uint32_t streamDroppedChunks = 0;
static int16_t linPreroll[PREROLL_SAMPLES];

unsigned long speakerMuteUntil = 0;

void sendBluetoothCommand(const String& cmd) {
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  if (SerialBT.hasClient()) {
    SerialBT.println(cmd);
    LOG_PRINTF("[BT] 📤 Comando enviado via Bluetooth: %s\n", cmd.c_str());
  } else {
    SerialBT.println(cmd);
    LOG_PRINTF("[BT] 📤 Comando no buffer Bluetooth (sem cliente ativo): %s\n", cmd.c_str());
  }
#endif
}

void fillWavHeader(uint8_t* header, uint32_t pcmDataBytes) {
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
      if (dur >= 2000 && dur <= 60000) {
        speakerMuteUntil = millis() + dur;
        LOG_PRINTF("[AEC] 🔇 Mudo ativado pela resposta da EVA: %lu ms.\n", dur);
      }
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

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      LOG_PRINTF("[WebSocket] Cliente #%u desconectado.\n", num);
      break;
    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(num);
      LOG_PRINTF("[WebSocket] Cliente #%u conectado de %d.%d.%d.%d\n", num, ip[0], ip[1], ip[2], ip[3]);
      webSocket.sendTXT(num, "{\"level\":0,\"rms\":0.0}");
      break;
    }
    case WStype_TEXT: {
      String msg = String((char*)payload);
      if (msg.indexOf("\"interrupt\"") >= 0) {
        speakerMuteUntil = 0;
        LOG_PRINTLN("[BARGE-IN] ⚡ Interrupção de fala recebida! VAD reativado imediatamente.");
      } else if (msg.indexOf("\"cmd\":\"speaker\"") >= 0 || msg.indexOf("\"speaker\"") >= 0) {
        if (msg.indexOf("true") >= 0) {
          unsigned long dur = 5000;
          int durIdx = msg.indexOf("\"durationMs\":");
          if (durIdx >= 0) {
            unsigned long parsed = msg.substring(durIdx + 13).toInt();
            if (parsed >= 1000 && parsed <= 60000) dur = parsed;
          }
          speakerMuteUntil = millis() + dur;
          LOG_PRINTF("[AEC] 🔊 Alto-falante ativo. Janela de áudio: %lu ms.\n", dur);
        } else {
          speakerMuteUntil = 0;
          LOG_PRINTLN("[AEC] 🔈 Alto-falante finalizado. VAD pronto.");
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

  LOG_PRINTLN("\n==================================");
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  LOG_PRINTLN("    EVA — ESP32-S3 VOICE ENGINE   ");
#else
  LOG_PRINTLN("    EVA — ESP32 CLASSIC VOICE ENGINE");
#endif
  LOG_PRINTLN("==================================");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Aloca buffer de áudio WAV para gravação
  wavBuffer = (uint8_t*)malloc(MAX_RECORD_BYTES);
  if (wavBuffer != nullptr) {
    LOG_PRINTF("[MEM] Buffer de voz alocado: %d bytes (%.1f KB)\n", MAX_RECORD_BYTES, MAX_RECORD_BYTES / 1024.0);
  } else {
    LOG_PRINTLN("[MEM] ERRO CRÍTICO ao alocar buffer de voz!");
  }

  i2sMicInit();

  LOG_PRINTF("[WiFi] Conectando a: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 35) {
    delay(300);
    LOG_PRINTLN(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    LOG_PRINTLN("\n[WiFi] Conectado!");
    LOG_PRINTF("[WiFi] IP do ESP32: %s\n", WiFi.localIP().toString().c_str());
    LOG_PRINTF("[EVA] Backend: %s\n", SERVER_VOICE_URL);
  } else {
    LOG_PRINTLN("\n[WiFi] Falha ao conectar. Operando modo offline.");
  }

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  LOG_PRINTLN("[WebSocket] Servidor escutando na porta 80.");

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  SerialBT.begin(BT_DEVICE_NAME);
  LOG_PRINTF("[BT] 🔵 Bluetooth Classic Serial iniciado como '%s'. Pronto para pareamento.\n", BT_DEVICE_NAME);
#endif
}

void loop() {
  webSocket.loop();

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  if (SerialBT.available()) {
    String btIncoming = SerialBT.readStringUntil('\n');
    btIncoming.trim();
    if (btIncoming.length() > 0) {
      LOG_PRINTF("[BT] 📥 Comando recebido via Bluetooth: %s\n", btIncoming.c_str());
      SerialBT.printf("ACK:%s\n", btIncoming.c_str());
    }
  }
#endif

  size_t bytesRead = 0;
  esp_err_t res = i2s_read(I2S_NUM_0, audioBuffer, sizeof(audioBuffer), &bytesRead, portMAX_DELAY);

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
    float activeRms = (rmsL >= rmsR) ? rmsL : rmsR;

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
    if (wavBuffer != nullptr) {
      if (false) {
        // Reservado para mute manual estrito
      } else {
        // Alimenta buffer circular de pré-roll (últimos 192ms) quando em repouso
        if (micState == STATE_IDLE) {
          for (size_t i = 0; i < pairs; i++) {
            int32_t valL = audioBuffer[i * 2] >> 13;
            int32_t valR = audioBuffer[i * 2 + 1] >> 13;
            // Mixagem inteligente de 2 microfones (ou seleção automática do canal ativo se apenas 1 estiver ligado)
            int32_t val = (rmsL > 50.0f && rmsR > 50.0f) ? ((valL + valR) / 2) : ((rmsL >= rmsR) ? valL : valR);
            if (val > 32767) val = 32767;
            if (val < -32768) val = -32768;
            prerollBuffer[(prerollHead + i) % PREROLL_SAMPLES] = (int16_t)val;
          }
          prerollHead = (prerollHead + pairs) % PREROLL_SAMPLES;

          // Fala humana sustentada detectada (RMS >= VAD_THRESHOLD_RMS = 1150)
          if (activeRms >= VAD_THRESHOLD_RMS) {
            voiceDetectFrames++;
            if (voiceDetectFrames >= VAD_TRIGGER_FRAMES) { // ~112ms de fala sustentada
              micState = STATE_RECORDING;
              silenceFrames = 0;
              speechFramesCount = VAD_TRIGGER_FRAMES;
              streamChunkIndex = 0;
              digitalWrite(LED_PIN, HIGH);
              LOG_PRINTLN("[EVA] 🎙️ Fala humana detectada! Gravando e transmitindo...");
              webSocket.broadcastTXT("{\"type\":\"hw_status\",\"state\":\"recording\"}");

              // Copia o pré-roll para não perder o início da primeira palavra
              int16_t* pcm16 = (int16_t*)(wavBuffer + WAV_HEADER_SIZE);
              for (int i = 0; i < PREROLL_SAMPLES; i++) {
                int16_t sample = prerollBuffer[(prerollHead + i) % PREROLL_SAMPLES];
                pcm16[i] = sample;
                linPreroll[i] = sample;
              }
              recordedSamples = PREROLL_SAMPLES;

              // Inicia streaming contínuo no WebSocket (T1 - P0)
              if (webSocket.connectedClients() > 0) {
                webSocket.broadcastTXT("{\"type\":\"audio_stream_start\"}");
                webSocket.broadcastBIN((uint8_t*)linPreroll, PREROLL_SAMPLES * sizeof(int16_t));
              }
            }
          } else {
            voiceDetectFrames = 0;
          }
        }

        if (micState == STATE_RECORDING) {
          int16_t* pcm16 = (int16_t*)(wavBuffer + WAV_HEADER_SIZE);
          for (size_t i = 0; i < pairs; i++) {
            int32_t valL = audioBuffer[i * 2] >> 13;
            int32_t valR = audioBuffer[i * 2 + 1] >> 13;
            int32_t val = (rmsL > 50.0f && rmsR > 50.0f) ? ((valL + valR) / 2) : ((rmsL >= rmsR) ? valL : valR);
            if (val > 32767) val = 32767;
            if (val < -32768) val = -32768;
            int16_t sample = (int16_t)val;

            if (recordedSamples < MAX_RECORD_SAMPLES) {
              pcm16[recordedSamples++] = sample;
            }

            streamChunkBuffer[streamChunkIndex++] = sample;
            if (streamChunkIndex >= CHUNK_SAMPLES) {
              if (webSocket.connectedClients() > 0) {
                // Backpressure: verifica memória livre no heap antes de enviar
                if (esp_get_free_heap_size() >= 24576) {
                  webSocket.broadcastBIN((uint8_t*)streamChunkBuffer, CHUNK_BYTES);
                } else {
                  streamDroppedChunks++;
                }
              }
              streamChunkIndex = 0;
            }
          }

          // Contabiliza frames que possuem energia real de fala
          if (activeRms >= 950.0f) {
            speechFramesCount++;
          }

          // Fim da fala por silêncio rápido (RMS < VAD_SILENCE_RMS = 620)
          if (activeRms < VAD_SILENCE_RMS) {
            silenceFrames++;
            if (silenceFrames >= VAD_SILENCE_FRAMES_END && recordedSamples >= MIN_RECORDED_SAMPLES) {
              micState = STATE_SENDING;
            }
          } else {
            silenceFrames = 0;
          }

          if (recordedSamples >= MAX_RECORD_SAMPLES) {
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
            if (webSocket.connectedClients() > 0) {
              webSocket.broadcastTXT("{\"type\":\"audio_stream_cancel\"}");
            }
            micState = STATE_IDLE;
            voiceDetectFrames = 0;
            silenceFrames = 0;
            speechFramesCount = 0;
            streamChunkIndex = 0;
            webSocket.broadcastTXT("{\"type\":\"hw_status\",\"state\":\"idle\"}");
          } else {
            if (webSocket.connectedClients() > 0) {
              // Flush do chunk residual final (se houver amostras pendentes)
              if (streamChunkIndex > 0) {
                webSocket.broadcastBIN((uint8_t*)streamChunkBuffer, streamChunkIndex * sizeof(int16_t));
                streamChunkIndex = 0;
              }
              unsigned long t_upload_complete = millis();
              char endMsg[160];
              snprintf(endMsg, sizeof(endMsg),
                       "{\"type\":\"audio_stream_end\",\"t0\":%lu,\"t_upload_complete\":%lu,\"samples\":%u,\"dropped\":%u}",
                       t0_cutoff, t_upload_complete, recordedSamples, streamDroppedChunks);
              webSocket.broadcastTXT(endMsg);

              LOG_PRINTF("[STREAM T1] ⚡ Áudio finalizado! Cutoff -> Upload: %lu ms (%u amostras, %u descartes)\n",
                         t_upload_complete - t0_cutoff, recordedSamples, streamDroppedChunks);

              lastPostTime = millis();
              micState = STATE_IDLE;
              voiceDetectFrames = 0;
              silenceFrames = 0;
              speechFramesCount = 0;
            } else {
              // Fallback HTTP POST caso nenhum cliente WebSocket esteja conectado
              webSocket.broadcastTXT("{\"type\":\"hw_status\",\"state\":\"sending\"}");
              sendVoiceToBackend(t0_cutoff);
              lastPostTime = millis();
              micState = STATE_IDLE;
              voiceDetectFrames = 0;
              silenceFrames = 0;
              speechFramesCount = 0;
              streamChunkIndex = 0;
            }
          }
        }
      }
    }

    // Telemetria via WebSocket a cada ~50ms
    static unsigned long lastWs = 0;
    if (millis() - lastWs > 50 && micState != STATE_SENDING) {
      lastWs = millis();
      char jsonMsg[110];
      snprintf(jsonMsg, sizeof(jsonMsg), "{\"level\":%d,\"rms\":%.1f,\"rmsL\":%.1f,\"rmsR\":%.1f,\"nz\":%d,\"st\":\"%s\"}",
               level, activeRms, rmsL, rmsR, nonZero, 
               (micState == STATE_RECORDING ? "rec" : (micState == STATE_SENDING ? "send" : "idle")));
      webSocket.broadcastTXT(jsonMsg);
    }

    // Log na Serial a cada 500ms
    static unsigned long lastSerial = 0;
    if (millis() - lastSerial > 500 && micState == STATE_IDLE) {
      lastSerial = millis();
      if (nonZero == 0) {
        LOG_PRINTLN("[MIC] SINAL ZERO (0.0). Verifique pinos SD/SCK/WS/VDD.");
      } else {
        LOG_PRINTF("[MIC] RMS: %.1f | Vol: %d%% | nz: %d | Estado: IDLE (Pronto para ouvir)\n", 
                   activeRms, level, nonZero);
      }
    }
  }

  // Auto-reconectar Wi-Fi se cair
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastRec = 0;
    if (millis() - lastRec > 8000) {
      lastRec = millis();
      WiFi.reconnect();
    }
  }
}

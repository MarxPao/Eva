/*
 * ============================================================================
 * EVA — Firmware ESP32 Microfone de Voz (Streaming I2S, VAD & WebSocket PC)
 * ============================================================================
 * Pinos do Microfone I2S (INMP441):
 *   - SD  (Serial Data):  GPIO 32 (ESP32 Clássico) / GPIO 13 (ESP32-S3)
 *   - WS  (Word Select):  GPIO 25 (ESP32 Clássico) / GPIO 1  (ESP32-S3)
 *   - SCK (Serial Clock): GPIO 14 (ESP32 Clássico) / GPIO 2  (ESP32-S3)
 *   - L/R:                GND (Canal Esquerdo / Left) ou VDD (Direito)
 *   - VDD:                3.3V
 *   - GND:                GND
 *
 * Modo de Operação:
 *   - Entrada de Áudio: Microfone INMP441 no ESP32 transmitindo via WebSocket
 *   - Saída de Áudio: Alto-falantes do PC / Navegador Web (sem Bluetooth no ESP32)
 *   - RAM: Bluetooth 100% desativado para máxima estabilidade e heap livre (~170KB+)
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include "driver/i2s_std.h"
#include "esp_task_wdt.h"
#include <math.h>
#include "esp_system.h"
#include <Preferences.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <DNSServer.h>

// Configurações Dinâmicas de Rede e Servidor (NVS / mDNS)
Preferences preferences;
String wifiSsid = "CMA";
String wifiPass = "clsma1976";
String serverHost = "192.168.2.146";
uint16_t serverPort = 8080;
String serverVoiceUrl = "http://192.168.2.146:8080/api/pipeline/voice";

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
  #include "esp_bt.h"
  #include "rom/gpio.h"
  #include "soc/gpio_sig_map.h"
  #define I2S_SD_PIN   32  // Serial Data / DOUT
  #define I2S_WS_PIN   25  // Word Select / LRCLK (movido do GPIO 15 para 25; evita strapping pin)
  #define I2S_SCK_PIN  14  // Serial Clock / BCLK
  #define LED_PIN      2   // LED Azul onboard padrão do ESP32 clássico
  #define LOG_PRINTLN(x) Serial.println(x)
  #define LOG_PRINTF(...) Serial.printf(__VA_ARGS__)
#endif

// ============================================================================
// Diagnóstico e Instrumentação de Memória / Reset
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
  LOG_PRINTF("[MEM][%s] PSRAM: %s | FreeHeap: %u B (%.1f KB) | MinFree: %u B (%.1f KB) | MaxAlloc: %u B (%.1f KB)\n",
             tag,
             psramFound() ? "sim" : "não",
             (unsigned int)ESP.getFreeHeap(),
             ESP.getFreeHeap() / 1024.0f,
             (unsigned int)ESP.getMinFreeHeap(),
             ESP.getMinFreeHeap() / 1024.0f,
             (unsigned int)ESP.getMaxAllocHeap(),
             ESP.getMaxAllocHeap() / 1024.0f);
}

// Janela de cancelamento acústico de eco (AEC): quando a EVA fala no PC, elevamos o limiar VAD
unsigned long speakerMuteUntil = 0;

#define I2S_SAMPLE_RATE           16000
#define BUFFER_PAIRS              256 // 256 pares (512 samples) = 16ms por leitura
#define MAX_STREAM_RECORD_SAMPLES 160000 // Até 10.0 segundos de fala contínua via WebSocket

static i2s_chan_handle_t rx_chan = NULL;
WebSocketsClient webSocket;
int32_t audioBuffer[BUFFER_PAIRS * 2]; // Captura Stereo (Left/Right mic)
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

// Tempo de silêncio pós-fala otimizado para resposta imediata (~384ms)
#define VAD_SILENCE_TIMEOUT_MS    380      // Constante única configurável em milissegundos
#define VAD_SILENCE_FRAMES_END    (VAD_SILENCE_TIMEOUT_MS / 16) // 24 frames (~384ms)
#define MIN_SPEECH_FRAMES         4        // Pelo menos 4 frames (~64ms) de energia de voz
#define MIN_RECORDED_SAMPLES      4800     // Pelo menos 300ms gravados

// Limiar para interrupção de fala legítima (Barge-In) enquanto a EVA fala no alto-falante do PC
#define VAD_BARGE_IN_THRESHOLD_RMS 4200.0f
#define VAD_BARGE_IN_TRIGGER_FRAMES 6      // ~96ms de voz alta sustentada para Barge-In

// Pré-roll circular de ~64ms (4 blocos de 256 amostras)
#define PREROLL_FRAMES            4
#define PREROLL_SAMPLES           (PREROLL_FRAMES * BUFFER_PAIRS)
int16_t prerollBuffer[PREROLL_SAMPLES];
int prerollHead = 0;
int speechFramesCount = 0;

// Streaming de Áudio em Chunks Ultra-rápidos (32ms a 16kHz)
#define CHUNK_SAMPLES             512
#define CHUNK_BYTES               (CHUNK_SAMPLES * sizeof(int16_t)) // 1024 bytes
int16_t streamChunkBuffer[CHUNK_SAMPLES];
size_t streamChunkIndex = 0;
uint32_t streamDroppedChunks = 0;
static int16_t linPreroll[PREROLL_SAMPLES];

void i2sMicInit() {
  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan_cfg.dma_desc_num = 4;
  chan_cfg.dma_frame_num = 256;
  esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &rx_chan);
  if (err != ESP_OK) {
    LOG_PRINTF("[I2S] ERRO ao alocar canal I2S STD: 0x%04x\n", err);
    return;
  }

  i2s_std_config_t std_cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(I2S_SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)I2S_SCK_PIN,
      .ws = (gpio_num_t)I2S_WS_PIN,
      .dout = I2S_GPIO_UNUSED,
      .din = (gpio_num_t)I2S_SD_PIN,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };

  err = i2s_channel_init_std_mode(rx_chan, &std_cfg);
  if (err != ESP_OK) {
    LOG_PRINTF("[I2S] ERRO na inicialização modo STD: 0x%04x\n", err);
    return;
  }

  err = i2s_channel_enable(rx_chan);
  if (err != ESP_OK) {
    LOG_PRINTF("[I2S] ERRO ao habilitar canal I2S STD: 0x%04x\n", err);
    return;
  }

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  // Espelhamento de transição via GPIO Matrix:
  // Roteia o clock WS também no GPIO 15, garantindo funcionamento caso o pino físico seja 15.
  pinMode(15, OUTPUT);
  gpio_matrix_out(15, I2S0I_WS_OUT_IDX, false, false);
#endif

  LOG_PRINTLN("[I2S] ✅ Microfone INMP441 inicializado com sucesso!");
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      LOG_PRINTF("[WebSocket] ⚠️ Desconectado do servidor EVA. Motivo: '%s'\n", payload ? (char*)payload : "nenhum");
      break;
    case WStype_ERROR:
      LOG_PRINTF("[WebSocket] ❌ Erro de conexão: %s\n", payload ? (char*)payload : "");
      break;
    case WStype_CONNECTED: {
      LOG_PRINTLN("[WebSocket] ✅ CONECTADO COM SUCESSO AO BACKEND EVA NO PC!");
      printMemoryReport("AFTER_WS_CONNECT");
      webSocket.sendTXT("{\"level\":0,\"rms\":0.0}");
      break;
    }
    case WStype_BIN:
      // Sem reprodução de áudio local no ESP32 (áudio sai no PC)
      break;
    case WStype_TEXT: {
      String msg = String((char*)payload);
      if (msg.indexOf("\"interrupt\"") >= 0) {
        speakerMuteUntil = 0;
        LOG_PRINTLN("[BARGE-IN] ⚡ Interrupção de fala recebida! VAD reativado imediatamente.");
      } else if (msg.indexOf("\"cmd\":\"speaking_start\"") >= 0 || msg.indexOf("\"speaking_start\"") >= 0 ||
                 (msg.indexOf("\"cmd\":\"speaker\"") >= 0 && msg.indexOf("true") >= 0)) {
        unsigned long dur = 5000;
        int durIdx = msg.indexOf("\"durationMs\":");
        if (durIdx >= 0) {
          unsigned long parsed = msg.substring(durIdx + 13).toInt();
          if (parsed >= 500 && parsed <= 120000) dur = parsed;
        }
        speakerMuteUntil = millis() + dur + 300;
        LOG_PRINTF("[AEC] 🔊 EVA falando no PC (speaking_start). Janela de eco: %lu ms.\n", dur + 300);
      } else if (msg.indexOf("\"cmd\":\"speaking_end\"") >= 0 || msg.indexOf("\"speaking_end\"") >= 0 ||
                 (msg.indexOf("\"cmd\":\"speaker\"") >= 0 && msg.indexOf("false") >= 0)) {
        bool isInterrupt = (msg.indexOf("\"interrupt\":true") >= 0 || msg.indexOf("\"interrupt\": true") >= 0);
        if (isInterrupt) {
          speakerMuteUntil = 0;
          LOG_PRINTLN("[AEC] ⚡ Interrupção de fala (Barge-In). VAD reativado imediatamente.");
        } else {
          speakerMuteUntil = millis() + 200;
          LOG_PRINTLN("[AEC] 🔈 EVA finalizou fala no PC (speaking_end).");
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

// ============================================================================
// Conectividade, NVS, mDNS e Portal Cativo
// ============================================================================
void updateServerUrls() {
  serverVoiceUrl = "http://" + serverHost + ":" + String(serverPort) + "/api/pipeline/voice";
}

void initPreferences() {
  preferences.begin("eva_cfg", false);
  if (!preferences.isKey("ssid")) {
    preferences.putString("ssid", "CMA");
    preferences.putString("pass", "clsma1976");
    preferences.putString("server_ip", "192.168.2.146");
    preferences.putUInt("server_port", 8080);
    LOG_PRINTLN("[NVS] 💾 Valores padrão salvos na memória não-volátil.");
  }
  wifiSsid = preferences.getString("ssid", "CMA");
  wifiPass = preferences.getString("pass", "clsma1976");
  serverHost = preferences.getString("server_ip", "192.168.2.146");
  serverPort = preferences.getUInt("server_port", 8080);
  preferences.end();

  updateServerUrls();

  LOG_PRINTF("[NVS] 📂 Configurações carregadas: SSID='%s' | Server='%s:%u'\n",
             wifiSsid.c_str(), serverHost.c_str(), serverPort);
}

void runCaptivePortal() {
  LOG_PRINTLN("\n=======================================================");
  LOG_PRINTLN("[PORTAL] 🌐 INICIANDO MODO PORTAL CATIVO (SoftAP)");
  LOG_PRINTLN("[PORTAL] SSID: EVA-Assistant-Setup | IP: 192.168.4.1");
  LOG_PRINTLN("=======================================================\n");

  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_AP);
  IPAddress apIp(192, 168, 4, 1);
  WiFi.softAPConfig(apIp, apIp, IPAddress(255, 255, 255, 0));
  WiFi.softAP("EVA-Assistant-Setup");

  DNSServer dnsServer;
  dnsServer.start(53, "*", apIp);

  WebServer webServer(80);

  int n = WiFi.scanNetworks();
  String optionsHtml = "";
  for (int i = 0; i < n; ++i) {
    optionsHtml += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }

  webServer.on("/", HTTP_GET, [&webServer, &optionsHtml]() {
    String html = "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<title>EVA Setup</title><style>"
      "body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:20px;text-align:center;}"
      ".card{background:#161b22;max-width:400px;margin:0 auto;padding:24px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);}"
      "h2{color:#58a6ff;margin-top:0;}label{display:block;text-align:left;margin:12px 0 4px;font-size:13px;color:#8b949e;}"
      "input,select{width:100%;box-sizing:border-box;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#fff;margin-bottom:8px;}"
      "button{width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:bold;cursor:pointer;margin-top:12px;}"
      "</style></head><body><div class='card'>"
      "<h2>Configurar EVA</h2>"
      "<form method='POST' action='/save'>"
      "<label>Rede Wi-Fi:</label><select name='ssid' id='ssid_sel' onchange='if(this.value)document.getElementById(\"ssid_inp\").value=this.value'>"
      "<option value=''>-- Selecione uma rede encontrada --</option>" + optionsHtml + "</select>"
      "<input type='text' name='ssid_manual' id='ssid_inp' placeholder='Ou digite o nome da rede (SSID)'>"
      "<label>Senha do Wi-Fi:</label><input type='password' name='pass' placeholder='Senha'>"
      "<label>IP do Servidor EVA (PC):</label><input type='text' name='server_ip' value='" + serverHost + "'>"
      "<label>Porta:</label><input type='number' name='server_port' value='" + String(serverPort) + "'>"
      "<button type='submit'>Salvar e Reiniciar</button></form></div></body></html>";
    webServer.send(200, "text/html", html);
  });

  webServer.on("/save", HTTP_POST, [&webServer]() {
    String reqSsid = webServer.arg("ssid_manual");
    if (reqSsid.length() == 0) reqSsid = webServer.arg("ssid");
    String reqPass = webServer.arg("pass");
    String reqIp   = webServer.arg("server_ip");
    String reqPort = webServer.arg("server_port");

    preferences.begin("eva_cfg", false);
    if (reqSsid.length() > 0) preferences.putString("ssid", reqSsid);
    if (reqPass.length() > 0) preferences.putString("pass", reqPass);
    if (reqIp.length() > 0)   preferences.putString("server_ip", reqIp);
    if (reqPort.length() > 0) preferences.putUInt("server_port", reqPort.toInt());
    preferences.end();

    String successHtml = "<!DOCTYPE html><html><body style='font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:50px;'>"
      "<h2>✅ Configurações salvas!</h2><p>O ESP32 está reiniciando e conectará à sua rede.</p></body></html>";
    webServer.send(200, "text/html", successHtml);
    delay(1000);
    ESP.restart();
  });

  webServer.begin();

  while (true) {
    dnsServer.processNextRequest();
    webServer.handleClient();
    delay(5);
  }
}

void resolveMdnsServer() {
  LOG_PRINTLN("[mDNS] 🔍 Buscando servidor 'eva.local' na rede via mDNS...");
  if (!MDNS.begin("eva-esp32")) {
    LOG_PRINTLN("[mDNS] ⚠️ Falha ao inicializar respondedor mDNS.");
  } else {
    LOG_PRINTLN("[mDNS] ✅ Respondedor mDNS iniciado como 'eva-esp32.local'.");
  }

  IPAddress resolvedIp = MDNS.queryHost("eva", 2500);
  if (resolvedIp != INADDR_NONE && resolvedIp[0] != 0) {
    serverHost = resolvedIp.toString();
    updateServerUrls();
    LOG_PRINTF("[mDNS] 🎯 Servidor 'eva.local' localizado com sucesso! IP: %s\n", serverHost.c_str());
  } else {
    LOG_PRINTF("[mDNS] ⚠️ Servidor 'eva.local' não respondeu na busca. Usando fallback configurado: %s\n", serverHost.c_str());
  }

  // Libera imediatamente os recursos UDP e memória do mDNS
  MDNS.end();
  LOG_PRINTLN("[mDNS] 🛑 MDNS.end() chamado; memória liberada com sucesso.");
}

void setup() {
  Serial.begin(115200);
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  Serial0.begin(115200);
#endif
  delay(1000);

  esp_reset_reason_t rstReason = esp_reset_reason();
  LOG_PRINTF("\n[RESET REASON] 🔍 Motivo do boot: %d (%s)\n", (int)rstReason, getResetReasonString(rstReason));
  printMemoryReport("01_BOOT_START");

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
  // Libera TODA a memória reservada de hardware Bluetooth (Classic + BLE) de volta pro Heap
  printMemoryReport("02_BEFORE_BT_RELEASE");
  esp_bt_controller_mem_release(ESP_BT_MODE_BTDM);
  printMemoryReport("02_AFTER_BT_RELEASE");
#endif

  LOG_PRINTLN("\n==================================");
  LOG_PRINTLN("    EVA — ESP32 VOICE ENGINE (PC) ");
  LOG_PRINTLN("==================================");

  printMemoryReport("03_BEFORE_NVS");
  initPreferences();
  printMemoryReport("03_AFTER_NVS");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  printMemoryReport("04_BEFORE_I2S");
  i2sMicInit();
  printMemoryReport("04_AFTER_I2S");

  printMemoryReport("05_BEFORE_WIFI");
  LOG_PRINTF("[WiFi] Conectando a: %s\n", wifiSsid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 35) {
    delay(300);
    LOG_PRINTLN(".");
    retries++;
  }

  if (WiFi.status() != WL_CONNECTED) {
    LOG_PRINTLN("\n[WiFi] ⚠️ Falha ao conectar no Wi-Fi configurado. Iniciando Portal Cativo...");
    runCaptivePortal();
  }

  LOG_PRINTLN("\n[WiFi] Conectado!");
  LOG_PRINTF("[WiFi] IP do ESP32: %s\n", WiFi.localIP().toString().c_str());
  printMemoryReport("05_AFTER_WIFI");

  printMemoryReport("06_BEFORE_MDNS");
  resolveMdnsServer();
  printMemoryReport("06_AFTER_MDNS");
  LOG_PRINTF("[EVA] Backend: %s\n", serverVoiceUrl.c_str());

  // Auto-registro dinâmico de IP no servidor EVA
  HTTPClient regHttp;
  String regUrl = "http://" + serverHost + ":" + String(serverPort) + "/api/esp32/register?ip=" + WiFi.localIP().toString();
  regHttp.begin(regUrl);
  regHttp.setTimeout(2500);
  int regCode = regHttp.GET();
  if (regCode == 200) {
    LOG_PRINTLN("[EVA] ✅ Registrado com sucesso no servidor!");
  }
  regHttp.end();

  printMemoryReport("07_BEFORE_WS");
  webSocket.begin(serverHost.c_str(), serverPort, "/api/esp32/ws", "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(1500);
  LOG_PRINTF("[WebSocket] Cliente configurado para ws://%s:%u/api/esp32/ws\n", serverHost.c_str(), serverPort);

  // Estabelece a conexão WebSocket inicial
  unsigned long wsStart = millis();
  while (!webSocket.isConnected() && millis() - wsStart < 2500) {
    webSocket.loop();
    delay(50);
  }
  if (webSocket.isConnected()) {
    LOG_PRINTLN("[WebSocket] ✅ Conexão WebSocket estabelecida no boot!");
  } else {
    LOG_PRINTLN("[WebSocket] ⏳ Handshake em andamento; continuará no loop principal.");
  }
  printMemoryReport("07_AFTER_WS");

  size_t freeHeap = esp_get_free_heap_size();
  LOG_PRINTF("[MEM] 🏁 Setup concluído! Heap livre: %u bytes (%.1f KB)\n", freeHeap, freeHeap / 1024.0f);
  printMemoryReport("SETUP_DONE");

  // Configuração do Task Watchdog (TWDT) - Timeout de 15 segundos
  esp_task_wdt_config_t twdt_config = {
    .timeout_ms = 15000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
    .trigger_panic = true
  };
  esp_err_t wdtErr = esp_task_wdt_reconfigure(&twdt_config);
  if (wdtErr != ESP_OK) {
    esp_task_wdt_init(&twdt_config);
  }
  esp_task_wdt_add(NULL);
  LOG_PRINTLN("[WDT] 🛡️ Task Watchdog ativo (15s timeout) na task principal.");
}

void loop() {
  esp_task_wdt_reset();
  webSocket.loop();

  static unsigned long lastMemReport = 0;
  if (millis() - lastMemReport >= 5000) {
    lastMemReport = millis();
    printMemoryReport("RUN_5S");
  }

  size_t bytesRead = 0;
  esp_err_t res = i2s_channel_read(rx_chan, audioBuffer, sizeof(audioBuffer), &bytesRead, pdMS_TO_TICKS(20));

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

    // INMP441 Mono: seleciona o canal com sinal ativo
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

      // Limiar dinâmico de VAD com AEC (se a EVA estiver falando no PC, eleva para 4200 RMS para Barge-In)
      bool isSpeakerActive = (millis() < speakerMuteUntil);
      float currentVadThreshold = isSpeakerActive ? VAD_BARGE_IN_THRESHOLD_RMS : VAD_THRESHOLD_RMS;
      uint8_t requiredTriggerFrames = isSpeakerActive ? VAD_BARGE_IN_TRIGGER_FRAMES : VAD_TRIGGER_FRAMES;

      // Fala humana sustentada detectada
      if (activeRms >= currentVadThreshold) {
        voiceDetectFrames++;
        if (voiceDetectFrames >= requiredTriggerFrames) {
          if (isSpeakerActive) {
            LOG_PRINTF("[BARGE-IN] ⚡ Interrupção por voz alta durante fala da EVA (RMS: %.1f >= %.1f)!\n",
                       activeRms, currentVadThreshold);
            speakerMuteUntil = 0;
          }
          micState = STATE_RECORDING;
          silenceFrames = 0;
          speechFramesCount = requiredTriggerFrames;
          streamChunkIndex = 0;
          digitalWrite(LED_PIN, HIGH);
          LOG_PRINTLN("[EVA] 🎙️ Fala humana detectada! Gravando e transmitindo...");
          webSocket.sendTXT("{\"type\":\"hw_status\",\"state\":\"recording\"}");

          // Copia o pré-roll para não perder o início da fala
          for (int i = 0; i < PREROLL_SAMPLES; i++) {
            linPreroll[i] = prerollBuffer[(prerollHead + i) % PREROLL_SAMPLES];
          }
          recordedSamples = PREROLL_SAMPLES;

          // Inicia streaming contínuo no WebSocket para o backend
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

        float x = (float)raw;
        float y = x - dcBlockerX + 0.995f * dcBlockerY;
        dcBlockerX = x;
        dcBlockerY = y;
        int32_t val = (int32_t)y;

        if (val > 32767) val = 32767;
        if (val < -32768) val = -32768;
        int16_t sample = (int16_t)val;
        recordedSamples++;

        streamChunkBuffer[streamChunkIndex++] = sample;
        if (streamChunkIndex >= CHUNK_SAMPLES) {
          if (webSocket.isConnected()) {
            if (esp_get_free_heap_size() >= 4096) {
              webSocket.sendBIN((uint8_t*)streamChunkBuffer, CHUNK_BYTES);
            } else {
              streamDroppedChunks++;
            }
          }
          streamChunkIndex = 0;
        }
      }

      // Contabiliza frames com energia real de fala
      if (activeRms >= VAD_SILENCE_RMS) {
        speechFramesCount++;
      }

      // Fim da fala por silêncio
      if (activeRms < VAD_SILENCE_RMS) {
        silenceFrames++;
        if (silenceFrames >= VAD_SILENCE_FRAMES_END && recordedSamples >= MIN_RECORDED_SAMPLES) {
          micState = STATE_SENDING;
        }
      } else {
        silenceFrames = 0;
      }

      if (recordedSamples >= MAX_STREAM_RECORD_SAMPLES) {
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
          webSocket.sendTXT("{\"type\":\"hw_status\",\"state\":\"idle\"}");
        }
        micState = STATE_IDLE;
        voiceDetectFrames = 0;
        silenceFrames = 0;
        speechFramesCount = 0;
        streamChunkIndex = 0;
      } else {
        if (webSocket.isConnected()) {
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
          LOG_PRINTLN("[EVA] ⚠️ Sem cliente WebSocket conectado; gravação descartada.");
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

    // Telemetria via WebSocket a cada ~200ms
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
        LOG_PRINTF("[EVA-HW] IP: %s | RMS: %.1f | Vol: %d%% | Heap: %u B\n", 
                   WiFi.localIP().toString().c_str(),
                   activeRms, level, (unsigned int)ESP.getFreeHeap());
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
      webSocket.begin(serverHost.c_str(), serverPort, "/api/esp32/ws", "");
    }
  }
}

# EVA — Assistente de Voz & Interface de Áudio

Sistema de captura de áudio e visualização responsiva em tempo real com **ESP32-S3** e **Interface Web**.

---

## 📁 Estrutura do Projeto

```
wise-pascal/
├── index.html        # Interface web (HTML/CSS/JS puro) com animação da EVA e cliente WebSocket
├── eva_arduino.ino   # Firmware ESP32-S3 (Arduino IDE) com driver I2S e servidor WebSocket
└── README.md         # Documentação técnica e instruções de montagem
```

---

## 1. Interface Web (`index.html`)

Página única sem dependências externas:
- **Visual:** Bolinha verde sálvia com iluminação volumétrica e 3 anéis concêntricos pulsantes (respiração idle).
- **Conectividade:** Conecta via WebSocket direto no ESP32 (`ws://<IP>/ws`).
- **Reatividade:** Recebe o nível de volume (0 a 100) em tempo real e interpola suavemente o tamanho e o brilho via filtro passa-baixa em `requestAnimationFrame`.
- **Extras incluídos:**
  - Persistência do último IP configurado no `localStorage`.
  - Modo simulação (botão **Simular** ou `simulate()` no console) para testar visualmente sem hardware.
  - Reconexão automática em caso de queda do WebSocket.
  - Indicador de nível e suporte visual para wake-word.

### Como rodar:
Basta abrir o arquivo [index.html](file:///c:/Users/rafae/Documents/antigravity/wise-pascal/index.html) em qualquer navegador moderno (Chrome, Edge, Firefox, Safari).

---

## 2. Firmware ESP32 Clássico (`eva_arduino.ino`)

### Placa e Componentes:
- **Placa alvo:** ESP32 Clássico (ESP32-WROOM-32 / DOIT DevKit v1)
- **Microfone:** 1x MEMS I2S (INMP441 com captura estéreo L/R)
- **Saída de Áudio:** Caixinha de som Bluetooth A2DP (`BT-SPEAKER`)
- **Pinagem Canônica do Hardware:**

| Pino Microfone INMP441 | Pino ESP32 (WROOM-32) | Função I2S | Status / Observações |
| :--- | :--- | :--- | :--- |
| **SCK / BCLK** | **GPIO 14** | Serial Clock (Bit Clock) | Saída digital I2S Master |
| **WS / LRCLK** | **GPIO 25** *(novo)* | Word Select (Left/Right Clock) | **Recomendado:** pino livre sem strapping (DAC1/Digital) |
| **WS / LRCLK (legado)** | **GPIO 15** *(espelho)* | Word Select (compatibilidade) | Espelhado via GPIO Matrix para não quebrar setups anteriores |
| **SD / DOUT** | **GPIO 32** | Serial Data In | Entrada digital de áudio do microfone |
| **L/R** | **GND** | Seleção de Canal | GND = Canal Esquerdo (Left) / 3.3V = Direito (Right) |
| **VDD** | **3.3V** | Alimentação | Tensão regulada 3.3V do ESP32 |
| **GND** | **GND** | Terra Comum | GND unificado |
| **LED Onboard** | **GPIO 2** | Status / VAD | Acende durante a captura de voz |

> [!TIP]
> **Migração do Pino WS (GPIO 15 ➔ GPIO 25)**:
> O firmware agora utiliza o **GPIO 25** como pino primário para o `WS / LRCLK`. Para comodidade em bancada, o sinal de clock é simultaneamente espelhado no **GPIO 15** via hardware GPIO Matrix (`gpio_matrix_out`), permitindo que você conecte no GPIO 25 ou mantenha no GPIO 15 sem interrupção de funcionamento. Recomendamos conectar no **GPIO 25** para isolar completamente os pinos de strapping do bootloader.

---

### ⚠️ Mapa de Restrições e Conflitos de Pinos no ESP32

Ao expandir o hardware com novos sensores ou atuadores, respeite as restrições arquiteturais do WROOM-32:

1. **Pinos de Flash SPI Integrada (PROIBIDO O USO)**:
   - **GPIO 6 a 11** (`CLK`, `CMD`, `SD0`, `SD1`, `SD2`, `SD3`): Conectados internamente à memória flash SPI do chip. Tocar nestes pinos causa crash imediato do sistema (`Guru Meditation / SPI_FAST_FLASH_BOOT error`).
2. **Pinos de Bootstrapping (Cuidado com Pulls externos no Power-on)**:
   - **GPIO 0**: Determina se o ESP32 entra em modo de gravação UART (LOW) ou execução normal (HIGH).
   - **GPIO 2**: Conectado ao LED onboard em muitas placas. Deve permanecer LOW durante gravação em alguns modelos.
   - **GPIO 12 (MTDI)**: Seleciona a voltagem de alimentação da flash (3.3V vs 1.8V). **NUNCA** coloque pull-up nesta linha, pois forçar nível HIGH faz o chip tentar alimentar a flash com 1.8V e falha o boot.
   - **GPIO 15 (MTDO)**: Controla se as mensagens da ROM de boot são impressas ou suprimidas. Motivo pelo qual migramos o clock do microfone para o GPIO 25.
3. **Pinos do ADC2 (Conflito com Rádio Wi-Fi)**:
   - **GPIOs 0, 2, 4, 12, 13, 14, 15, 25, 26, 27**: Compartilham o conversor analógico SAR ADC2 com o rádio Wi-Fi.
   - *Regra*: Funções analógicas (`analogRead()`) nestes pinos **falham** quando o Wi-Fi está ligado. No entanto, o uso como **GPIO digital, I2S e PWM funciona normalmente**, pois não utilizam o SAR ADC2.
4. **Pinos Somente Entrada (Input-Only / GPI)**:
   - **GPIO 34, 35, 36 (VP), 39 (VN)**: Não possuem transistores de saída (output drivers) nem resistores de pull-up/pull-down internos. Só podem ser usados como sensores ou entradas digitais (nunca como SCK ou WS).

---

### Dependências e Compilação via RTK:
```bash
# Compilar firmware ESP32 (huge_app):
rtk err arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=921600 eva_arduino

# Gravação USB na COM8:
rtk err arduino-cli upload -p COM8 --fqbn esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=921600 eva_arduino
```

---

## 🎯 Próximos Passos
- Descoberta mDNS (`ws://eva.local:8080/api/esp32/ws`) com fallback de IP.
- SoftAP / Portal de provisionamento Wi-Fi para configuração de rede via celular.
- Persistência na NVS do endereço MAC da caixinha Bluetooth para pareamento instantâneo.

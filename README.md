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

## 2. Firmware ESP32-S3 (`eva_arduino.ino`)

### Placa e Componentes:
- **Placa alvo:** ESP32-S3 DevKit
- **Microfone:** 1x MEMS I2S (MS3625, INMP441, ICS-43434)
- **Pinagem Padrão:**

| Pino Microfone | Pino ESP32-S3 | Função |
| :--- | :--- | :--- |
| **SD / DOUT** | GPIO 13 | Serial Data |
| **WS / LRCLK** | GPIO 1 | Word Select |
| **SCK / BCLK** | GPIO 2 | Serial Clock |
| **L/R** | GND | Seleciona canal esquerdo |
| **VDD** | 3.3V | Alimentação |
| **GND** | GND | Terra |
| **LED Onboard** | GPIO 48 | Indicador de áudio/threshold |

### Dependências na Arduino IDE:
1. Instale o pacote de placas **esp32** da Espressif.
2. No Gerenciador de Bibliotecas, instale a biblioteca **WebSockets** (por *Markus Sattler*).
3. Selecione a placa **ESP32S3 Dev Module**.

### Passo a passo para gravação:
1. Abra [eva_arduino.ino](file:///c:/Users/rafae/Documents/antigravity/wise-pascal/eva_arduino.ino).
2. Modifique as linhas com suas credenciais de Wi-Fi:
   ```cpp
   const char* WIFI_SSID = "SEU_WIFI";
   const char* WIFI_PASS = "SUA_SENHA";
   ```
3. Compile e envie para o ESP32-S3.
4. Abra o Monitor Serial a `115200` bauds.
5. Copie o IP exibido (ex: `192.168.0.42`) e cole no campo de IP no [index.html](file:///c:/Users/rafae/Documents/antigravity/wise-pascal/index.html).

---

## 🎯 Próximos Passos
- Integrar motor de wake-word local (ex: Picovoice Porcupine ou microWakeWord) para substituir o limiar de amplitude.
- Suporte a mDNS (ex: `ws://eva.local/ws`) para descoberta automática de IP.

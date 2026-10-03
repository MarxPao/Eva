# AGENTS.md - Diretrizes Operacionais e Protocolo RTK

Este documento define as regras operacionais, comandos canônicos e o estado da arquitetura do projeto **EVA Voice Assistant** para agentes autônomos.

---

## ⚡ 1. PROTOCOLO RTK NA BUILD (OBRIGATÓRIO)

**Regra Absoluta:** NUNCA execute comandos brutos de build, teste ou git que gerem saídas longas no terminal. Utilize SEMPRE o prefixo `rtk`.

### Comandos de Build & Compilação
```bash
# Compilar firmware ESP32 (huge_app, particionamento rápido):
rtk err arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=921600 eva_arduino

# Gravação/Upload USB (COM8, 921600 baud, ~22s):
rtk err arduino-cli upload -p COM8 --fqbn esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=921600 eva_arduino
```

### Testes & Scripts Node.js
```bash
# Testes unitários (todos os 80 testes devem passar):
rtk npm test
rtk npx vitest run

# Build Node/TypeScript:
rtk npm run build
```

### Controle de Versão (Git)
```bash
rtk git status
rtk git diff
rtk git add <arquivos>
rtk git commit -m "<mensagem semântica>"
```

### Utilitários RTK
* `rtk err <cmd>`: Executa qualquer comando e exibe apenas erros/warnings caso ocorram.
* `rtk proxy <cmd>`: Executa comando bruto sem filtro quando necessário.
* `rtk gain`: Mostra economia acumulada de tokens da sessão.

---

## 🧭 2. ESTADO ATUAL DA ARQUITETURA

1. **Clima em Tempo Real (Open-Meteo):**
   * Ferramenta: `src/tools/low-risk/consultar-clima.ts` conectada à API Open-Meteo com `past_days=1`. Responde dados históricos reais de chuva e temperatura.
   * Endpoint Backend: `GET /api/weather?city=...` em `src/server.ts`.
   * Povoamento Frontend: `index.html` exibe clima atual e pílulas de previsão para os próximos 5 dias.
   * Localização Dinâmica: A cidade pode ser alterada clicando no card de clima (salva em `localStorage` como `eva_user_city`). Cidade padrão caso omitida: Juiz de Fora.

2. **Frontend & Interface Visual (`index.html`):**
   * Arco celeste (`.orb-aura-arc`) sobre a esfera e relógio restaurado conforme referência do design.
   * No **Modo Dia**, o Sol fica posicionado no ápice central do arco.
   * No **Modo Noite**, a Lua fica posicionada na curva superior direita do arco.
   * Alternância suave ao clicar no astro celeste.

3. **Saída de Áudio Bluetooth & ESP32 (`eva_arduino/eva_arduino.ino`):**
   * Dispositivo alvo configurado: **`BT-SPEAKER`** (`#define BT_ENABLED 1`).
   * VAD ajustado para 88 frames de silêncio (~1.4s) para evitar cortes precoces durante a fala.
   * WebSocket em `/api/esp32/ws`.

---

## 📋 3. INSTRUÇÕES PARA NOVAS TAREFAS

1. Antes de iniciar qualquer alteração, verifique a saúde da suíte com `rtk npm test`.
2. Para compilar e subir firmware para o ESP32, use o script `rtk err arduino-cli ...`.
3. Manter compatibilidade com testes unitários (21 arquivos / 80 testes).
4. Próxima funcionalidade planejada: módulo introdutório / onboarding para cada usuário configurar sua localização e preferências.

# TTS Pipeline — Technical Debt & Roadmap

## Estado Atual (Prototipação / MVP)
No momento, a EVA utiliza **Microsoft Edge-TTS** (`msedge-tts`) para sintetização de voz em português brasileiro (`pt-BR-FranciscaNeural` / `pt-BR-AntonioNeural`).

### Por que Edge-TTS no MVP?
- **Custo zero:** Sem necessidade de faturamento de cartão de crédito no início do desenvolvimento.
- **Boa prosódia em PT-BR:** Voz natural comparada a engines tradicionais locais (ex: eSpeak).
- **Facilidade de integração rápida:** Permite validar o loop de hardware e interação sem overhead de infraestrutura externa.

### Dívida Técnica Explícita & Riscos
1. **API Não-Oficial:** A biblioteca utiliza a conexão WebSocket de leitura em voz alta do Edge. A Microsoft pode alterar ou bloquear o endpoint a qualquer momento sem aviso prévio.
2. **Latência de TTFB:** A latência inicial pode variar entre 500ms e 1500ms dependendo da rota de rede, o que excede a meta de latência de conversa fluida (< 800ms total).
3. **Falta de Streaming Baixa Latência Chank-a-Chunk para ESP32:** O Edge-TTS não fornece streaming ultra-rápido de tokens em tempo real com controle de clock de áudio.

---

## Roadmap para Produção: Migração para Cartesia Sonic

Para a versão de produção comercial da EVA:
- **Provedor Alvo:** **Cartesia Sonic** (ou ElevenLabs Flash / Deepgram Aura).
- **Meta de Latência:** TTFB inferior a 100ms em streaming WebSocket.
- **Formato de Saída:** PCM 16-bit / 24kHz diretamente empacotado para o DAC/I2S do ESP32.
- **Isolamento de Arquitetura:** A implementação respeita a interface `TTSProvider` definida em `src/core/providers/types.ts`. A troca de Edge-TTS para Cartesia exigirá apenas a ativação do adapter `CartesiaTTSProvider` sem qualquer alteração na engine ou nas ferramentas do agente.

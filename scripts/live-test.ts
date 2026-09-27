import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDefaultAgentEngine } from '../src/core/agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carrega .env manualmente de forma segura
const envPath = path.join(__dirname, '..', '.env');
const env: Record<string, string> = {};
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        env[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim();
      }
    }
  }
}

async function runLiveTest() {
  const apiKey = process.env.GROQ_API_KEY || env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY não encontrada no .env');
    process.exit(1);
  }

  console.log('--- Iniciando Teste Real do EVA Agent Engine com Groq (qwen/qwen3.8-27b) ---');

  const engine = createDefaultAgentEngine({
    groqApiKey: apiKey,
    groqModel: process.env.GROQ_MODEL || env.GROQ_MODEL || 'qwen/qwen3.8-27b',
  });

  const prompt = 'Olá EVA! Qual a previsão do tempo para São Paulo para os próximos 2 dias?';
  console.log(`\n[USUÁRIO]: "${prompt}"`);

  const result = await engine.run(prompt, [], {
    onStep: (event) => {
      if (event.type === 'tool_call_start') {
        console.log(`  ➔ [TOOL CALL START]: ${event.toolName} com params:`, event.params);
      } else if (event.type === 'tool_call_finish') {
        console.log(`  ➔ [TOOL CALL FINISH]: ${event.toolName}`);
      }
    },
  });

  console.log(`\n[RESPOSTA DA EVA]:\n"${result.textResponse}"`);
  console.log('\n--- TELEMETRIA DA INTERAÇÃO ---');
  console.log(`- Ferramentas Executadas: ${result.toolExecutions.length}`);
  console.log(`- Provedor Utilizado: ${result.telemetry.providerUsed.llm}`);
  console.log(`- Fallback Acionado: ${result.telemetry.fallbackTriggered}`);
  console.log(`- Tokens Entrada: ${result.telemetry.costs.llm.inputTokens}`);
  console.log(`- Tokens Saída: ${result.telemetry.costs.llm.outputTokens}`);
  console.log(`- Custo Calculado: $${result.telemetry.costs.totalCostUSD.toFixed(8)} USD`);
  console.log(`- Latência Total: ${result.telemetry.latency.totalMs}ms`);
}

runLiveTest().catch(console.error);

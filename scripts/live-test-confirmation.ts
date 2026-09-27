import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDefaultAgentEngine } from '../src/core/agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function runConfirmationTest() {
  const apiKey = process.env.GROQ_API_KEY || env.GROQ_API_KEY;
  const engine = createDefaultAgentEngine({
    groqApiKey: apiKey!,
    groqModel: process.env.GROQ_MODEL || env.GROQ_MODEL || 'qwen/qwen3.8-27b',
  });

  console.log('\n--- Teste 1: Ação Crítica SEM Confirmação ---');
  const res1 = await engine.run('EVA, abre a fechadura da porta principal agora', []);
  console.log('Resposta da EVA:', res1.textResponse);
  console.log('Exige Confirmação:', res1.requiresConfirmation);
  console.log('Detalhes da Confirmação Pendente:', res1.pendingConfirmation);

  console.log('\n--- Teste 2: Ação Crítica COM Confirmação Concedida ---');
  const res2 = await engine.confirmAction(res1.pendingConfirmation!, res1.messages);
  console.log('Resposta da EVA:', res2.textResponse);
  console.log('Ferramentas Executadas:', res2.toolExecutions.map(t => `${t.toolName}: ${t.status}`));
}

runConfirmationTest().catch(console.error);

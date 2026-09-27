import { AgentEngine } from './agent-engine';
import { FallbackOrchestrator } from '../providers/fallback-orchestrator';
import { LLMProvider } from '../providers/types';
import { GroqLLMProvider } from '../providers/groq/groq-llm';
import { GeminiLLMProvider } from '../providers/gemini/gemini-llm';
import { createDefaultToolRegistry } from '../../tools';
import { ToolExecutor } from '../tools/tool-executor';
import { SafetyGate } from '../tools/safety-gate';
import { CostTracker } from '../instrumentation/cost-tracker';

export interface CreateAgentEngineOptions {
  groqApiKey: string;
  groqModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  systemPrompt?: string;
}

export function createDefaultAgentEngine(options: CreateAgentEngineOptions): AgentEngine {
  const primaryLLM = new GroqLLMProvider({
    apiKey: options.groqApiKey,
    model: options.groqModel || 'qwen/qwen3.8-27b',
  });

  const fallbackLLM = options.geminiApiKey
    ? new GeminiLLMProvider({
        apiKey: options.geminiApiKey,
        model: options.geminiModel || 'gemini-1.5-flash',
      })
    : undefined;

  const orchestrator = new FallbackOrchestrator<LLMProvider>(primaryLLM, fallbackLLM);
  const registry = createDefaultToolRegistry();
  const safetyGate = new SafetyGate();
  const executor = new ToolExecutor(registry, { safetyGate });
  const costTracker = new CostTracker();

  return new AgentEngine({
    llmOrchestrator: orchestrator,
    registry,
    executor,
    costTracker,
    systemPrompt: options.systemPrompt,
  });
}

export * from './types';
export * from './system-prompt';
export * from './agent-engine';

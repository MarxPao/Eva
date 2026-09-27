import { VoicePipeline } from './voice-pipeline';
import { createDefaultAgentEngine } from '../core/agent';
import { FallbackOrchestrator } from '../core/providers/fallback-orchestrator';
import { STTProvider, TTSProvider } from '../core/providers/types';
import { GroqSTTProvider } from '../core/providers/groq/groq-stt';
import { DeepgramSTTProvider } from '../core/providers/deepgram/deepgram-stt';
import { EdgeTTSProvider } from '../core/providers/tts/edge-tts';
import { CostTracker } from '../core/instrumentation/cost-tracker';

export interface CreateVoicePipelineOptions {
  groqApiKey: string;
  groqModel?: string;
  geminiApiKey?: string;
  deepgramApiKey?: string;
  systemPrompt?: string;
}

export function createDefaultVoicePipeline(options: CreateVoicePipelineOptions): VoicePipeline {
  const agentEngine = createDefaultAgentEngine({
    groqApiKey: options.groqApiKey,
    groqModel: options.groqModel || 'qwen/qwen3.8-27b',
    geminiApiKey: options.geminiApiKey,
    systemPrompt: options.systemPrompt,
  });

  const groqSTT = new GroqSTTProvider({
    apiKey: options.groqApiKey,
  });

  const deepgramKey = options.deepgramApiKey || process.env.DEEPGRAM_API_KEY;
  let primarySTT: STTProvider = groqSTT;
  let fallbackSTT: STTProvider | undefined = undefined;

  if (deepgramKey) {
    primarySTT = new DeepgramSTTProvider({ apiKey: deepgramKey, model: 'nova-2' });
    fallbackSTT = groqSTT;
  }

  const edgeTTS = new EdgeTTSProvider();

  const sttOrchestrator = new FallbackOrchestrator<STTProvider>(primarySTT, fallbackSTT);
  const ttsOrchestrator = new FallbackOrchestrator<TTSProvider>(edgeTTS);
  const costTracker = new CostTracker();

  return new VoicePipeline({
    agentEngine,
    sttOrchestrator,
    ttsOrchestrator,
    costTracker,
  });
}

export * from './voice-pipeline';

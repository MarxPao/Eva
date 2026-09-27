import { OpenAIToolDefinition } from '../tools/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  rawArguments: string;
  parsedArguments: Record<string, unknown>;
}

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: OpenAIToolDefinition[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface LLMCompletionResult {
  content: string | null;
  toolCalls?: ParsedToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  provider: string;
  model: string;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate(messages: ChatMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult>;
  isHealthy(): Promise<boolean>;
}

export interface STTOptions {
  language?: string;
  prompt?: string;
}

export interface STTResult {
  text: string;
  durationSeconds: number;
  provider: string;
  latencyMs: number;
}

export interface STTProvider {
  readonly name: string;
  transcribe(audioBuffer: Buffer, options?: STTOptions): Promise<STTResult>;
  isHealthy(): Promise<boolean>;
}

export interface TTSOptions {
  voice?: string;
  rate?: string;
  pitch?: string;
}

export interface TTSResult {
  audioBuffer: Buffer;
  characterCount: number;
  provider: string;
  latencyMs: number;
}

export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
  isHealthy(): Promise<boolean>;
}

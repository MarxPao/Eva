import { ChatMessage } from '../providers/types';
import { ConfirmationRequest, ToolExecutionResult } from '../tools/types';
import { InteractionTelemetry } from '../../domain/types';

export type AgentStepEventType =
  | 'thinking'
  | 'tool_call_start'
  | 'tool_call_finish'
  | 'confirmation_required'
  | 'completed'
  | 'error';

export interface AgentStepEvent {
  type: AgentStepEventType;
  toolName?: string;
  params?: unknown;
  result?: unknown;
  confirmation?: ConfirmationRequest;
  message?: string;
  timestamp: Date;
}

export interface InterruptedContext {
  previousPrompt: string;
  partialResponse?: string;
}

export interface AgentRunOptions {
  maxTurns?: number;
  confirmed?: boolean;
  pendingConfirmation?: ConfirmationRequest;
  interactionId?: string;
  userId?: string;
  temperature?: number;
  abortSignal?: AbortSignal;
  interruptedFrom?: InterruptedContext;
  onStep?: (event: AgentStepEvent) => void;
  onToken?: (token: string) => void;
  onSentence?: (sentence: string, index: number) => void;
}

export interface AgentRunResult {
  textResponse: string;
  requiresConfirmation: boolean;
  pendingConfirmation?: ConfirmationRequest;
  toolExecutions: ToolExecutionResult[];
  telemetry: InteractionTelemetry;
  messages: ChatMessage[];
}

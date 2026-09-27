import { type z } from 'zod';

export type ToolSensitivityLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolExecutionContext {
  interactionId: string;
  userId?: string;
  confirmed?: boolean;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ConfirmationRequest {
  toolName: string;
  prompt: string;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionResult<T = unknown> {
  toolName: string;
  status: 'success' | 'failure' | 'confirmation_required';
  data?: T;
  error?: string;
  confirmation?: ConfirmationRequest;
  executionTimeMs: number;
}

export interface OpenAIFunctionParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: OpenAIFunctionParameterSchema;
  };
}

export interface ToolDefinition<TParams = any, TResult = any> {
  name: string;
  description: string;
  sensitivity: ToolSensitivityLevel;
  requiresConfirmation: boolean;
  schema: z.ZodType<TParams>;
  confirmationPrompt?: (params: TParams) => string;
  execute: (params: TParams, context: ToolExecutionContext) => Promise<TResult>;
}

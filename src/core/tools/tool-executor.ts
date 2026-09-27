import { ToolRegistry } from './tool-registry';
import { SafetyGate } from './safety-gate';
import { ToolExecutionContext, ToolExecutionResult } from './types';
import {
  ToolNotFoundError,
  ToolValidationError,
  ToolExecutionTimeoutError,
} from '../../domain/errors';

export interface ToolExecutorOptions {
  defaultTimeoutMs?: number;
  safetyGate?: SafetyGate;
}

export class ToolExecutor {
  private readonly defaultTimeoutMs: number;
  private readonly safetyGate: SafetyGate;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {}
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.safetyGate = options.safetyGate ?? new SafetyGate();
  }

  /**
   * Executa uma ferramenta por nome, aplicando validação estrita de esquema (Zod),
   * verificação de segurança (SafetyGate/Human-in-the-loop) e timeout controlado.
   */
  public async execute<TResult = unknown>(
    toolName: string,
    rawParams: unknown,
    context: ToolExecutionContext,
    timeoutMs?: number
  ): Promise<ToolExecutionResult<TResult>> {
    const startTime = Date.now();
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    const tool = this.registry.get(toolName);
    if (!tool) {
      const notFoundErr = new ToolNotFoundError(toolName);
      return {
        toolName,
        status: 'failure',
        error: notFoundErr.message,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 1. Validação com Zod
    const parseResult = tool.schema.safeParse(rawParams);
    if (!parseResult.success) {
      const validationIssues = parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      }));
      const valError = new ToolValidationError(toolName, validationIssues);
      return {
        toolName,
        status: 'failure',
        error: valError.message,
        executionTimeMs: Date.now() - startTime,
      };
    }

    const validatedParams = parseResult.data;

    // 2. Verificação de SafetyGate (Human-in-the-loop para ações sensíveis)
    const safetyCheck = this.safetyGate.evaluate(tool, validatedParams, context);
    if (!safetyCheck.allowed && safetyCheck.confirmation) {
      return {
        toolName,
        status: 'confirmation_required',
        confirmation: safetyCheck.confirmation,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 3. Execução com Timeout
    let timer: NodeJS.Timeout | undefined;
    try {
      const executionPromise = tool.execute(validatedParams, context);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolExecutionTimeoutError(toolName, effectiveTimeout));
        }, effectiveTimeout);
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);

      return {
        toolName,
        status: 'success',
        data: result as TResult,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        toolName,
        status: 'failure',
        error: err?.message || String(err),
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

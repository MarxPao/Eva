import { ToolDefinition, ToolExecutionContext, ConfirmationRequest } from './types';

export interface SafetyCheckResult {
  allowed: boolean;
  confirmation?: ConfirmationRequest;
}

export class SafetyGate {
  /**
   * Avalia se a execução da ferramenta pode prosseguir ou se requer
   * confirmação explícita do usuário (Human-in-the-Loop).
   */
  public evaluate<TParams, TResult>(
    tool: ToolDefinition<TParams, TResult>,
    params: TParams,
    context: ToolExecutionContext
  ): SafetyCheckResult {
    // Se a ferramenta não requer confirmação prévia, está liberada
    if (!tool.requiresConfirmation) {
      return { allowed: true };
    }

    // Se o contexto já possui confirmação explícita positiva do usuário, permite executar
    if (context.confirmed === true) {
      return { allowed: true };
    }

    // Caso contrário, gera a solicitação de confirmação
    const prompt = tool.confirmationPrompt
      ? tool.confirmationPrompt(params)
      : `Atenção: A ação '${tool.name}' possui impacto crítico e precisa da sua confirmação expressa. Deseja autorizar?`;

    return {
      allowed: false,
      confirmation: {
        toolName: tool.name,
        prompt,
        parameters: (params as unknown) as Record<string, unknown>,
      },
    };
  }
}

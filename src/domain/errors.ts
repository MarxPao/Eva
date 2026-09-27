/**
 * Erros padronizados de domínio da EVA
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    if (typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, this.constructor);
    }
  }
}

export class ToolNotFoundError extends DomainError {
  constructor(public readonly toolName: string) {
    super(`Ferramenta '${toolName}' não está registrada no catálogo de ferramentas.`);
  }
}

export class ToolValidationError extends DomainError {
  constructor(
    public readonly toolName: string,
    public readonly validationErrors: Array<{ path: string; message: string }>
  ) {
    const errorDetails = validationErrors.map(e => `[${e.path}]: ${e.message}`).join('; ');
    super(`Falha de validação nos argumentos da ferramenta '${toolName}': ${errorDetails}`);
  }
}

export class ToolExecutionTimeoutError extends DomainError {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`A ferramenta '${toolName}' excedeu o tempo limite de execução (${timeoutMs}ms).`);
  }
}

export class ConfirmationRequiredError extends DomainError {
  constructor(public readonly toolName: string, public readonly prompt: string) {
    super(`A ferramenta '${toolName}' requer confirmação explícita do usuário: ${prompt}`);
  }
}

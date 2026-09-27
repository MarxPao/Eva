export interface FallbackResult<T> {
  result: T;
  providerUsed: string;
  fallbackTriggered: boolean;
  primaryError?: Error;
}

export class FallbackOrchestrator<TProvider extends { name: string }> {
  constructor(
    private readonly primary: TProvider,
    private readonly fallback?: TProvider
  ) {}

  /**
   * Executa uma ação no provedor primário. Se falhar e um fallback estiver configurado,
   * direciona a requisição para o fallback de forma transparente e instrumentada.
   */
  public async execute<TResult>(
    operation: (provider: TProvider) => Promise<TResult>,
    operationName: string = 'ProviderOperation'
  ): Promise<FallbackResult<TResult>> {
    try {
      const result = await operation(this.primary);
      return {
        result,
        providerUsed: this.primary.name,
        fallbackTriggered: false,
      };
    } catch (primaryErr: any) {
      console.warn(
        `[FallbackOrchestrator] Falha no provedor primário '${this.primary.name}' durante '${operationName}':`,
        primaryErr?.message || primaryErr
      );

      if (!this.fallback) {
        throw primaryErr;
      }

      console.info(
        `[FallbackOrchestrator] Acionando provedor de contingência (fallback) '${this.fallback.name}' para '${operationName}'...`
      );

      try {
        const fallbackResult = await operation(this.fallback);
        return {
          result: fallbackResult,
          providerUsed: this.fallback.name,
          fallbackTriggered: true,
          primaryError: primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr)),
        };
      } catch (fallbackErr: any) {
        console.error(
          `[FallbackOrchestrator] Falha crítica em ambos os provedores ('${this.primary.name}' e '${this.fallback.name}'):`,
          fallbackErr
        );
        throw new Error(
          `Falha em todos os provedores para '${operationName}'. Primário: [${primaryErr?.message}]. Fallback: [${fallbackErr?.message}]`
        );
      }
    }
  }

  public getPrimary(): TProvider {
    return this.primary;
  }

  public getFallback(): TProvider | undefined {
    return this.fallback;
  }
}

import { z } from 'zod';
import { ToolDefinition, OpenAIToolDefinition, OpenAIFunctionParameterSchema } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  /**
   * Registra uma ferramenta no catálogo.
   * Lança erro caso uma ferramenta com o mesmo nome já exista.
   */
  public register<TParams, TResult>(tool: ToolDefinition<TParams, TResult>): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('O nome da ferramenta deve ser uma string não vazia.');
    }

    if (this.tools.has(tool.name)) {
      throw new Error(`Ferramenta com o nome '${tool.name}' já está registrada.`);
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * Registra múltiplas ferramentas de uma vez.
   */
  public registerAll(tools: ToolDefinition<any, any>[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Obtém a definição de uma ferramenta pelo nome.
   */
  public get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Verifica se uma ferramenta está registrada.
   */
  public has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Retorna a lista com todas as ferramentas registradas.
   */
  public list(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Remove uma ferramenta do catálogo (útil para testes ou desativação dinâmica).
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Limpa todas as ferramentas registradas.
   */
  public clear(): void {
    this.tools.clear();
  }

  /**
   * Converte o catálogo registrado para o formato de ferramentas esperado
   * por modelos com function calling (OpenAI, Groq, Ollama).
   */
  public getFunctionDefinitions(): OpenAIToolDefinition[] {
    return this.list().map((tool) => {
      let rawSchema: Record<string, unknown> = {};

      try {
        if (typeof (z as any).toJSONSchema === 'function') {
          rawSchema = (z as any).toJSONSchema(tool.schema) as Record<string, unknown>;
        }
      } catch (err) {
        console.warn(`[ToolRegistry] Falha ao extrair JSON schema da ferramenta '${tool.name}':`, err);
      }

      // Remove metadados internos do JSON Schema ($schema) para compatibilidade estrita com OpenAI/Groq
      const { $schema, ...cleanParameters } = rawSchema;

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: (cleanParameters as OpenAIFunctionParameterSchema) || {
            type: 'object',
            properties: {},
          },
        },
      };
    });
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { ToolDefinition } from '../../src/core/tools/types';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  const dummyTool: ToolDefinition<{ text: string }, { echo: string }> = {
    name: 'eco_teste',
    description: 'Ferramenta simples para teste de eco',
    sensitivity: 'low',
    requiresConfirmation: false,
    schema: z.object({
      text: z.string().describe('Texto para ecoar'),
    }),
    execute: async (params) => ({ echo: params.text }),
  };

  it('deve registrar uma ferramenta com sucesso', () => {
    registry.register(dummyTool);
    expect(registry.has('eco_teste')).toBe(true);
    expect(registry.get('eco_teste')).toBe(dummyTool);
    expect(registry.list()).toHaveLength(1);
  });

  it('deve lançar erro ao tentar registrar ferramenta duplicada', () => {
    registry.register(dummyTool);
    expect(() => registry.register(dummyTool)).toThrowError(
      "Ferramenta com o nome 'eco_teste' já está registrada."
    );
  });

  it('deve lançar erro ao tentar registrar ferramenta com nome inválido', () => {
    expect(() =>
      registry.register({
        ...dummyTool,
        name: '',
      })
    ).toThrowError('O nome da ferramenta deve ser uma string não vazia.');
  });

  it('deve permitir desregistrar uma ferramenta', () => {
    registry.register(dummyTool);
    expect(registry.has('eco_teste')).toBe(true);
    const removed = registry.unregister('eco_teste');
    expect(removed).toBe(true);
    expect(registry.has('eco_teste')).toBe(false);
  });

  it('deve limpar todas as ferramentas registradas', () => {
    registry.register(dummyTool);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it('deve exportar especificações no formato de function calling compatível com OpenAI/Groq', () => {
    registry.register(dummyTool);
    const definitions = registry.getFunctionDefinitions();

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toEqual({
      type: 'function',
      function: {
        name: 'eco_teste',
        description: 'Ferramenta simples para teste de eco',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            text: expect.objectContaining({
              type: 'string',
              description: 'Texto para ecoar',
            }),
          }),
          required: ['text'],
        }),
      },
    });

    // Não deve conter a propriedade interna $schema na raiz de parameters
    expect(definitions[0].function.parameters).not.toHaveProperty('$schema');
  });
});

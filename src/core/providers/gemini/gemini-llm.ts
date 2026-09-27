import {
  LLMProvider,
  ChatMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  ParsedToolCall,
} from '../types';

export interface GeminiLLMOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class GeminiLLMProvider implements LLMProvider {
  public readonly name = 'gemini';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: GeminiLLMOptions) {
    if (!options.apiKey) {
      throw new Error('GeminiLLMProvider requer uma chave API válida (apiKey).');
    }
    this.apiKey = options.apiKey;
    this.model = options.model || 'gemini-1.5-flash';
    this.baseUrl = options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  public async generate(
    messages: ChatMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    const startTime = Date.now();

    // Separa mensagem de sistema (se houver) e mensagens de conversa
    let systemInstruction: string | undefined;
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = (systemInstruction ? systemInstruction + '\n' : '') + msg.content;
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
            parts.push({
              functionCall: {
                name: tc.function.name,
                args,
              },
            });
          }
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        let parsedResult: unknown = msg.content;
        try {
          parsedResult = JSON.parse(msg.content);
        } catch {
          parsedResult = { result: msg.content };
        }
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.name || 'tool_response',
                response: typeof parsedResult === 'object' && parsedResult !== null
                  ? parsedResult
                  : { response: parsedResult },
              },
            },
          ],
        });
      }
    }

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 500,
      },
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    if (options.tools && options.tools.length > 0) {
      const functionDeclarations = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
      payload.tools = [{ functionDeclarations }];
    }

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[GeminiLLMProvider] Erro na API (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let textContent: string | null = null;
    const toolCalls: ParsedToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        textContent = (textContent ? textContent + '\n' : '') + part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `gemini_call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: part.functionCall.name,
          rawArguments: JSON.stringify(part.functionCall.args || {}),
          parsedArguments: part.functionCall.args || {},
        });
      }
    }

    const latencyMs = Date.now() - startTime;

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      provider: this.name,
      model: this.model,
      latencyMs,
    };
  }

  public async isHealthy(): Promise<boolean> {
    try {
      const res = await this.generate([{ role: 'user', content: 'ping' }], { maxTokens: 5 });
      return res.content !== null;
    } catch {
      return false;
    }
  }
}

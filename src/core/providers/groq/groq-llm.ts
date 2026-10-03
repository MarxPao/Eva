import {
  LLMProvider,
  ChatMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  ParsedToolCall,
} from '../types';

export interface GroqLLMOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  defaultMaxTokens?: number;
}

export class GroqLLMProvider implements LLMProvider {
  public readonly name = 'groq';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;

  constructor(options: GroqLLMOptions) {
    if (!options.apiKey) {
      throw new Error('GroqLLMProvider requer uma chave API válida (apiKey).');
    }
    this.apiKey = options.apiKey;
    this.model = options.model || 'qwen/qwen3.8-27b';
    this.baseUrl = (options.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    this.defaultMaxTokens = options.defaultMaxTokens ?? 500;
  }

  public async generate(
    messages: ChatMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    const startTime = Date.now();

    const payload: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      temperature: options.temperature ?? 0.7,
      // Limita tokens máximos por padrão para evitar estouro de OTPM no free tier do Groq
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
    };

    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = 'auto';
    }

    if (options.onToken) {
      payload.stream = true;
    }

    let activeModel = this.model;
    payload.model = activeModel;

    let response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (response.status === 429 || response.status === 503) {
      const fallbackModel = (activeModel === 'qwen/qwen3.8-27b') ? 'openai/gpt-oss-20b' : 'qwen/qwen3.8-27b';
      console.warn(`[GroqLLMProvider] Rate limit / indisponibilidade (${response.status}) no modelo '${activeModel}'. Alternando automaticamente para '${fallbackModel}'...`);
      payload.model = fallbackModel;
      try {
        const retryRes = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: options.signal,
        });
        if (retryRes && retryRes.ok) {
          response = retryRes;
          activeModel = fallbackModel;
        } else if (retryRes) {
          response = retryRes;
        }
      } catch {}
    }

    if (!response.ok) {
      const errorText = await response.text();
      let parsedError: string;
      try {
        const errorJson = JSON.parse(errorText);
        parsedError = errorJson.error?.message || errorText;
      } catch {
        parsedError = errorText;
      }
      throw new Error(`[GroqLLMProvider] Erro na API (${response.status}): ${parsedError}`);
    }

    if (options.onToken && response.body) {
      let fullContent = '';
      const streamedToolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        if (options.signal?.aborted) return;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return;
        if (trimmed === 'data: [DONE]') return;
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              fullContent += delta.content;
              options.onToken!(delta.content);
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!streamedToolCalls[idx]) {
                  streamedToolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                }
                if (tc.id) streamedToolCalls[idx].id = tc.id;
                if (tc.function?.name) streamedToolCalls[idx].name = tc.function.name;
                if (tc.function?.arguments) streamedToolCalls[idx].arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      };

      const bodyAny = response.body as any;
      if (typeof bodyAny[Symbol.asyncIterator] === 'function') {
        for await (const chunk of bodyAny) {
          if (options.signal?.aborted) break;
          buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const l of lines) processLine(l);
        }
      } else if (typeof bodyAny.getReader === 'function') {
        const reader = bodyAny.getReader();
        while (true) {
          if (options.signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const l of lines) processLine(l);
        }
      }

      if (buffer.trim()) {
        processLine(buffer);
      }

      let toolCalls: ParsedToolCall[] | undefined;
      const tcKeys = Object.keys(streamedToolCalls).map(Number).sort((a, b) => a - b);
      if (tcKeys.length > 0) {
        toolCalls = tcKeys.map((k) => {
          const tc = streamedToolCalls[k];
          let parsed = {};
          try {
            parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {}
          return {
            id: tc.id,
            name: tc.name,
            rawArguments: tc.arguments,
            parsedArguments: parsed,
          };
        });
      }

      const latencyMs = Date.now() - startTime;
      return {
        content: fullContent || null,
        toolCalls,
        usage: {
          inputTokens: Math.max(1, Math.round(messages.reduce((acc, m) => acc + (m.content || '').length, 0) / 4)),
          outputTokens: Math.max(1, Math.round(fullContent.length / 4)),
        },
        provider: this.name,
        model: activeModel,
        latencyMs,
      };
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error('[GroqLLMProvider] Resposta inválida: nenhuma choice retornada.');
    }

    const message = choice.message;
    let toolCalls: ParsedToolCall[] | undefined;

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      toolCalls = message.tool_calls.map((tc: any) => {
        let parsed = {};
        try {
          parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          console.warn(`[GroqLLMProvider] Falha ao fazer parse de argumentos de tool: ${tc.function.arguments}`);
        }
        return {
          id: tc.id,
          name: tc.function.name,
          rawArguments: tc.function.arguments,
          parsedArguments: parsed,
        };
      });
    }

    const latencyMs = Date.now() - startTime;

    return {
      content: message.content ?? null,
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      provider: this.name,
      model: activeModel,
      latencyMs,
    };
  }

  public async isHealthy(): Promise<boolean> {
    try {
      const res = await this.generate(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 5 }
      );
      return res.content !== null;
    } catch {
      return false;
    }
  }

  /**
   * Pré-aquece a conexão HTTPS e handshake TLS com a API Groq.
   * Elimina overhead de DNS + TCP + TLS na primeira interação do usuário.
   */
  public async prewarm(): Promise<number> {
    const start = Date.now();
    try {
      await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch {}
    return Date.now() - start;
  }
}

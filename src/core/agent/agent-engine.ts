import { FallbackOrchestrator } from '../providers/fallback-orchestrator';
import { LLMProvider, ChatMessage } from '../providers/types';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutor } from '../tools/tool-executor';
import { ToolExecutionContext, ToolExecutionResult } from '../tools/types';
import { CostTracker } from '../instrumentation/cost-tracker';
import { EVA_SYSTEM_PROMPT, getEvaSystemPrompt, getDynamicTemporalContext } from './system-prompt';
import { cleanVoiceResponse } from './clean-response';
import { SentenceAccumulator } from './sentence-stream';
import { AgentRunOptions, AgentRunResult, AgentStepEvent } from './types';
import { InteractionTelemetry } from '../../domain/types';

export interface AgentEngineConfig {
  llmOrchestrator: FallbackOrchestrator<LLMProvider>;
  registry: ToolRegistry;
  executor: ToolExecutor;
  costTracker?: CostTracker;
  systemPrompt?: string;
}

export class AgentEngine {
  private readonly llmOrchestrator: FallbackOrchestrator<LLMProvider>;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly costTracker: CostTracker;
  private readonly systemPrompt: string;

  constructor(config: AgentEngineConfig) {
    this.llmOrchestrator = config.llmOrchestrator;
    this.registry = config.registry;
    this.executor = config.executor;
    this.costTracker = config.costTracker ?? new CostTracker();
    this.systemPrompt = config.systemPrompt ?? EVA_SYSTEM_PROMPT;
  }

  /**
   * Executa uma interação completa do usuário no loop de raciocínio da EVA.
   */
  public async run(
    userInput: string,
    history: ChatMessage[] = [],
    options: AgentRunOptions = {}
  ): Promise<AgentRunResult> {
    const startTime = Date.now();
    const interactionId = options.interactionId || `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const maxTurns = options.maxTurns ?? 5;

    const context: ToolExecutionContext = {
      interactionId,
      userId: options.userId,
      confirmed: options.confirmed,
      timestamp: new Date(),
    };

    // Monta o histórico de mensagens iniciando com o System Prompt da EVA
    const messages: ChatMessage[] = [];
    if (!history.some((m) => m.role === 'system')) {
      const activePrompt = this.systemPrompt === EVA_SYSTEM_PROMPT
        ? getEvaSystemPrompt()
        : `${this.systemPrompt}\n\n${getDynamicTemporalContext()}`;
      messages.push({ role: 'system', content: activePrompt });
    }
    messages.push(...history);
    messages.push({ role: 'user', content: userInput });

    const toolExecutions: ToolExecutionResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let fallbackTriggered = false;
    let lastProviderUsed = this.llmOrchestrator.getPrimary().name;
    let textResponse = '';
    let requiresConfirmation = false;
    let pendingConfirmation: AgentRunResult['pendingConfirmation'];

    const notify = (event: Omit<AgentStepEvent, 'timestamp'>) => {
      options.onStep?.({ ...event, timestamp: new Date() });
    };

    // Se há uma ação pendente que acabou de ser confirmada, executa o atuador físico
    if (options.confirmed && options.pendingConfirmation) {
      const pending = options.pendingConfirmation;
      notify({
        type: 'tool_call_start',
        toolName: pending.toolName,
        params: pending.parameters,
      });

      const execResult = await this.executor.execute(
        pending.toolName,
        pending.parameters,
        { ...context, confirmed: true }
      );

      toolExecutions.push(execResult);

      notify({
        type: 'tool_call_finish',
        toolName: pending.toolName,
        result: execResult.data ?? execResult.error,
      });

      // Injecao segura de contexto de execucao fisica para que o LLM sintetize a voz
      messages.push({
        role: 'system',
        content: `[EVENTO DE SISTEMA]: A ação sensível '${pending.toolName}' foi expressamente confirmada e executada com resultado: ${JSON.stringify(execResult.data)}. Responda confirmando a conclusão em linguagem falada concisa e amigável.`,
      });
    }

    // Se houve interrupção da fala anterior (Barge-In), injeta contexto para refatoração a partir da segunda fala
    if (options.interruptedFrom) {
      const prevPartial = options.interruptedFrom.partialResponse?.trim() || '(fala anterior interrompida)';
      messages.push({
        role: 'system',
        content: `[INTERRUPÇÃO DE FALA (BARGE-IN) DETECTADA]:
O usuário interrompeu a fala anterior da EVA.
A EVA estava dizendo: "${prevPartial} [INTERROMPIDA]".
O usuário disse agora: "${userInput}".
DIRETRIZES DE REFATORAÇÃO:
1. Interrompa completamente o raciocínio da fala anterior.
2. Refatore e produza a sua resposta focando EXCLUSIVAMENTE nesta nova solicitação.
3. Se a segunda fala for uma correção, pergunta diferente, complemento ou mudança de assunto, responda com naturalidade, clareza, concisão e sem pedir desculpas excessivas.`,
      });
    }

    if (options.abortSignal?.aborted) {
      return {
        textResponse: '',
        requiresConfirmation: false,
        toolExecutions: [],
        telemetry: {
          interactionId,
          timestamp: new Date(),
          providerUsed: { llm: this.llmOrchestrator.getPrimary().name },
          fallbackTriggered: false,
          costs: this.costTracker.computeTotalBreakdown({
            llmModelKey: `${this.llmOrchestrator.getPrimary().name}:${this.llmOrchestrator.getPrimary().model}`,
            inputTokens: 0,
            outputTokens: 0,
          }),
          latency: { totalMs: 0 },
        },
        messages,
      };
    }

    let turns = 0;
    while (turns < maxTurns) {
      if (options.abortSignal?.aborted) break;
      turns++;
      notify({ type: 'thinking', message: `Iniciando raciocínio turno ${turns}` });

      const tools = this.registry.getFunctionDefinitions();

      // Execução com orquestrador de contingência (Groq primário ➔ Gemini fallback)
      const sentenceAccumulator = options.onSentence
        ? new SentenceAccumulator({
            onFirstToken: () => {
              if (options.onToken) options.onToken('');
            },
            onSentence: (sentence, index) => {
              if (options.abortSignal?.aborted) return;
              options.onSentence!(sentence, index);
            },
          })
        : null;

      const orchestratorResult = await this.llmOrchestrator.execute(
        (provider) =>
          provider.generate(messages, {
            tools: tools.length > 0 ? tools : undefined,
            temperature: options.temperature ?? 0.6,
            signal: options.abortSignal,
            onToken: (token) => {
              if (options.abortSignal?.aborted) return;
              if (options.onToken) options.onToken(token);
              sentenceAccumulator?.push(token);
            },
          }),
        'AgentLoop_Inference'
      );

      sentenceAccumulator?.end();

      lastProviderUsed = orchestratorResult.providerUsed;
      if (orchestratorResult.fallbackTriggered) {
        fallbackTriggered = true;
      }

      const llmResult = orchestratorResult.result;
      totalInputTokens += llmResult.usage.inputTokens;
      totalOutputTokens += llmResult.usage.outputTokens;

      // Se o LLM não solicitou ferramentas, chegamos à resposta final falada
      if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
        const rawContent = llmResult.content || 'Não consegui processar sua solicitação no momento.';
        textResponse = cleanVoiceResponse(rawContent);
        messages.push({ role: 'assistant', content: textResponse });
        notify({ type: 'completed', message: textResponse });
        break;
      }

      let confirmationSuspended = false;

      // Verifica antecipadamente se alguma ferramenta chamada requer confirmação
      for (const toolCall of llmResult.toolCalls) {
        notify({
          type: 'tool_call_start',
          toolName: toolCall.name,
          params: toolCall.parsedArguments,
        });

        const execResult = await this.executor.execute(
          toolCall.name,
          toolCall.parsedArguments,
          context
        );

        toolExecutions.push(execResult);

        // Verificação de Human-in-the-Loop (SafetyGate)
        if (execResult.status === 'confirmation_required' && execResult.confirmation) {
          notify({
            type: 'confirmation_required',
            toolName: toolCall.name,
            confirmation: execResult.confirmation,
          });

          requiresConfirmation = true;
          pendingConfirmation = execResult.confirmation;
          textResponse = execResult.confirmation.prompt;
          confirmationSuspended = true;

          // Adiciona apenas a resposta de confirmação sem deixar tool_calls órfãos
          messages.push({
            role: 'assistant',
            content: textResponse,
          });
          break;
        }

        // Ferramenta executada com sucesso ou erro normal
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: toolCall.rawArguments,
              },
            },
          ],
        });

        notify({
          type: 'tool_call_finish',
          toolName: toolCall.name,
          result: execResult.data ?? execResult.error,
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(
            execResult.status === 'success'
              ? execResult.data
              : { erro: execResult.error }
          ),
        });
      }

      if (confirmationSuspended) {
        break;
      }
    }

    const totalMs = Date.now() - startTime;

    // Cálculo e telemetria de custos (Dia 1)
    const costs = this.costTracker.computeTotalBreakdown({
      llmModelKey: `${lastProviderUsed}:${this.llmOrchestrator.getPrimary().model}`,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    });

    this.costTracker.logCostEvent(interactionId, costs);

    const telemetry: InteractionTelemetry = {
      interactionId,
      timestamp: new Date(),
      providerUsed: {
        llm: lastProviderUsed,
      },
      fallbackTriggered,
      costs,
      latency: {
        totalMs,
      },
    };

    return {
      textResponse,
      requiresConfirmation,
      pendingConfirmation,
      toolExecutions,
      telemetry,
      messages,
    };
  }

  /**
   * Confirma e executa uma ação sensível que estava pendente de aprovação do usuário.
   */
  public async confirmAction(
    pendingConfirmation: NonNullable<AgentRunResult['pendingConfirmation']>,
    history: ChatMessage[] = [],
    options: Omit<AgentRunOptions, 'confirmed' | 'pendingConfirmation'> = {}
  ): Promise<AgentRunResult> {
    return this.run('Sim, confirmo a execução.', history, {
      ...options,
      confirmed: true,
      pendingConfirmation,
    });
  }
}

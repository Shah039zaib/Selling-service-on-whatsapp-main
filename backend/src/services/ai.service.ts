import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import type { AIProvider as PrismaAIProvider, Service, Package, PaymentConfig } from '@prisma/client';
import { prisma } from '../config/database.js';
import { logger, createChildLogger } from '../utils/logger.js';
import { decryptApiKey } from '../utils/encryption.js';
import { withTimeout, TIMEOUT_CONSTANTS, TimeoutError } from '../utils/timeout.js';
import {
  AIProviderType,
  AIProviderConfig,
  AIGenerationResult,
  AIConversationContext,
  AIMessage,
} from '../types/index.js';

// Error classification for resilience
enum ErrorType {
  RETRYABLE = 'RETRYABLE',       // Network errors, timeouts, 5xx errors
  NON_RETRYABLE = 'NON_RETRYABLE', // Auth errors, invalid keys, 4xx errors
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED' // Daily/rate limits exhausted
}

interface ClassifiedError {
  type: ErrorType;
  message: string;
  originalError: Error;
}

// Circuit breaker state per provider
enum CircuitState {
  CLOSED = 'CLOSED',   // Normal operation
  OPEN = 'OPEN',       // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN' // Testing if recovered
}

interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  nextRetryTime: number;
}

interface AIProvider {
  generate(
    systemPrompt: string,
    messages: AIMessage[],
    context: AIConversationContext
  ): Promise<AIGenerationResult>;
}

// Classify errors to determine retry strategy
function classifyError(error: any): ClassifiedError {
  const errorMessage = error?.message || String(error);
  const errorString = errorMessage.toLowerCase();

  // TimeoutError from our timeout utility - RETRYABLE
  if (error instanceof TimeoutError) {
    return {
      type: ErrorType.RETRYABLE,
      message: 'AI provider execution timeout',
      originalError: error
    };
  }

  // Network and timeout errors - RETRYABLE
  if (
    error?.code === 'ECONNRESET' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ENOTFOUND' ||
    error?.code === 'ECONNREFUSED' ||
    errorString.includes('timeout') ||
    errorString.includes('network') ||
    errorString.includes('socket') ||
    errorString.includes('econnreset')
  ) {
    return {
      type: ErrorType.RETRYABLE,
      message: 'Network or timeout error',
      originalError: error
    };
  }

  // 5xx server errors - RETRYABLE
  if (
    error?.status >= 500 && error?.status < 600 ||
    errorString.includes('500') ||
    errorString.includes('502') ||
    errorString.includes('503') ||
    errorString.includes('504') ||
    errorString.includes('internal server error') ||
    errorString.includes('service unavailable') ||
    errorString.includes('gateway timeout')
  ) {
    return {
      type: ErrorType.RETRYABLE,
      message: 'Server error (5xx)',
      originalError: error
    };
  }

  // Rate limit and quota errors - QUOTA_EXCEEDED
  if (
    error?.status === 429 ||
    errorString.includes('rate limit') ||
    errorString.includes('quota') ||
    errorString.includes('too many requests') ||
    errorString.includes('limit exceeded')
  ) {
    return {
      type: ErrorType.QUOTA_EXCEEDED,
      message: 'Rate limit or quota exceeded',
      originalError: error
    };
  }

  // Auth and validation errors - NON_RETRYABLE
  if (
    error?.status === 401 ||
    error?.status === 403 ||
    error?.status === 400 ||
    errorString.includes('unauthorized') ||
    errorString.includes('forbidden') ||
    errorString.includes('invalid api key') ||
    errorString.includes('authentication') ||
    errorString.includes('bad request') ||
    errorString.includes('invalid request')
  ) {
    return {
      type: ErrorType.NON_RETRYABLE,
      message: 'Authentication or validation error',
      originalError: error
    };
  }

  // Default to RETRYABLE for unknown errors (conservative approach)
  return {
    type: ErrorType.RETRYABLE,
    message: 'Unknown error, treating as retryable',
    originalError: error
  };
}

// Sleep utility for backoff
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ClaudeProvider implements AIProvider {
  private client: Anthropic;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
  }

  async generate(
    systemPrompt: string,
    messages: AIMessage[],
    _context: AIConversationContext
  ): Promise<AIGenerationResult> {
    const startTime = Date.now();

    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model: this.config.model || 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: anthropicMessages,
    });

    const content =
      response.content[0]?.type === 'text' ? response.content[0].text : '';

    return {
      content,
      providerId: this.config.id,
      providerType: 'CLAUDE',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs: Date.now() - startTime,
    };
  }
}

class GeminiProvider implements AIProvider {
  private client: GoogleGenerativeAI;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.config = config;
  }

  async generate(
    systemPrompt: string,
    messages: AIMessage[],
    _context: AIConversationContext
  ): Promise<AIGenerationResult> {
    const startTime = Date.now();

    const model = this.client.getGenerativeModel({
      model: this.config.model || 'gemini-1.5-flash',
      systemInstruction: systemPrompt,
    });

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history: history as any });

    const lastMessage = messages[messages.length - 1];
    const result = await chat.sendMessage(lastMessage?.content || '');
    const response = result.response;

    const inputTokens = Math.ceil(
      messages.reduce((acc, m) => acc + m.content.length, 0) / 4
    );
    const outputTokens = Math.ceil(response.text().length / 4);

    return {
      content: response.text(),
      providerId: this.config.id,
      providerType: 'GEMINI',
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startTime,
    };
  }
}

class GroqProvider implements AIProvider {
  private client: Groq;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.client = new Groq({ apiKey: config.apiKey });
    this.config = config;
  }

  async generate(
    systemPrompt: string,
    messages: AIMessage[],
    _context: AIConversationContext
  ): Promise<AIGenerationResult> {
    const startTime = Date.now();

    const groqMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      })),
    ];

    const response = await this.client.chat.completions.create({
      model: this.config.model || 'llama-3.1-8b-instant',
      messages: groqMessages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content || '';

    return {
      content,
      providerId: this.config.id,
      providerType: 'GROQ',
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      latencyMs: Date.now() - startTime,
    };
  }
}

class CohereProvider implements AIProvider {
  private apiKey: string;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.apiKey = config.apiKey;
    this.config = config;
  }

  async generate(
    systemPrompt: string,
    messages: AIMessage[],
    _context: AIConversationContext
  ): Promise<AIGenerationResult> {
    const startTime = Date.now();

    const chatHistory = messages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
      message: m.content,
    }));

    const lastMessage = messages[messages.length - 1];

    const response = await fetch('https://api.cohere.ai/v1/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model || 'command-r',
        message: lastMessage?.content || '',
        preamble: systemPrompt,
        chat_history: chatHistory,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere API error: ${response.statusText}`);
    }

    const data = await response.json() as {
      text?: string;
      meta?: { tokens?: { input_tokens?: number; output_tokens?: number } };
    };

    return {
      content: data.text || '',
      providerId: this.config.id,
      providerType: 'COHERE',
      inputTokens: data.meta?.tokens?.input_tokens || 0,
      outputTokens: data.meta?.tokens?.output_tokens || 0,
      latencyMs: Date.now() - startTime,
    };
  }
}

export class AIService {
  private providers: Map<string, AIProvider> = new Map();
  private providerConfigs: AIProviderConfig[] = [];
  private resetTimer?: NodeJS.Timeout;

  // Circuit breaker configuration
  private readonly CIRCUIT_FAILURE_THRESHOLD = 3; // Open circuit after 3 consecutive failures
  private readonly CIRCUIT_COOLDOWN_MS = 60000; // 1 minute cooldown before retry
  private readonly MAX_RETRIES_PER_PROVIDER = 2; // Max 2 retries per provider
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();

  // Memory safety limits
  private readonly MAX_PROVIDERS = 50;

  async initialize(): Promise<void> {
    await this.loadProviders();
    await this.resetDailyUsageIfNeeded();

    this.resetTimer = setInterval(() => this.resetDailyUsageIfNeeded(), 60 * 60 * 1000);

    logger.info(
      { providerCount: this.providers.size },
      'AI service initialized'
    );
  }

  private async loadProviders(): Promise<void> {
    const providers = await prisma.aIProvider.findMany({
      where: { isActive: true },
      orderBy: { priority: 'desc' },
      take: this.MAX_PROVIDERS, // Limit number of providers loaded
    });

    if (providers.length >= this.MAX_PROVIDERS) {
      logger.warn(
        { count: providers.length, limit: this.MAX_PROVIDERS },
        'AI provider limit reached, some providers may not be loaded'
      );
    }

    this.providerConfigs = [];
    this.providers.clear();

    for (const p of providers) {
      let decryptedKey: string;
      try {
        decryptedKey = decryptApiKey(p.apiKey);
      } catch (error) {
        logger.error({ error, providerId: p.id, type: p.type }, 'Failed to decrypt API key, skipping provider');
        continue;  // Skip this provider if decryption fails
      }

      const config: AIProviderConfig = {
        id: p.id,
        type: p.type,
        apiKey: decryptedKey,
        model: p.model || undefined,
        dailyLimit: p.dailyLimit,
        usedToday: p.usedToday,
        priority: p.priority,
      };

      this.providerConfigs.push(config);

      let provider: AIProvider;

      switch (p.type) {
        case 'CLAUDE':
          provider = new ClaudeProvider(config);
          break;
        case 'GEMINI':
          provider = new GeminiProvider(config);
          break;
        case 'GROQ':
          provider = new GroqProvider(config);
          break;
        case 'COHERE':
          provider = new CohereProvider(config);
          break;
        default:
          continue;
      }

      this.providers.set(p.id, provider);
    }
  }

  private async resetDailyUsageIfNeeded(): Promise<void> {
    const now = new Date();
    const providers = await prisma.aIProvider.findMany({
      where: {
        lastResetAt: {
          lt: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        },
      },
    });

    if (providers.length > 0) {
      await prisma.aIProvider.updateMany({
        where: {
          id: { in: providers.map((p: PrismaAIProvider) => p.id) },
        },
        data: {
          usedToday: 0,
          lastResetAt: now,
        },
      });

      await this.loadProviders();
      logger.info('Daily AI usage counters reset');
    }
  }

  // Circuit breaker: Get or initialize state for a provider
  private getCircuitState(providerId: string): CircuitBreakerState {
    if (!this.circuitBreakers.has(providerId)) {
      this.circuitBreakers.set(providerId, {
        state: CircuitState.CLOSED,
        failureCount: 0,
        lastFailureTime: 0,
        nextRetryTime: 0
      });
    }
    return this.circuitBreakers.get(providerId)!;
  }

  // Circuit breaker: Check if provider is available
  private isCircuitClosed(providerId: string): boolean {
    const circuit = this.getCircuitState(providerId);
    const now = Date.now();

    // If circuit is open, check if cooldown has passed
    if (circuit.state === CircuitState.OPEN) {
      if (now >= circuit.nextRetryTime) {
        // Move to half-open state to test recovery
        circuit.state = CircuitState.HALF_OPEN;
        logger.info({ providerId }, 'Circuit breaker moving to HALF_OPEN state');
        return true;
      }
      return false; // Still in cooldown
    }

    return true; // CLOSED or HALF_OPEN
  }

  // Circuit breaker: Record success
  private recordCircuitSuccess(providerId: string): void {
    const circuit = this.getCircuitState(providerId);

    if (circuit.state === CircuitState.HALF_OPEN) {
      logger.info({ providerId }, 'Circuit breaker closing after successful request');
    }

    // Reset to healthy state
    circuit.state = CircuitState.CLOSED;
    circuit.failureCount = 0;
    circuit.lastFailureTime = 0;
    circuit.nextRetryTime = 0;
  }

  // Circuit breaker: Record failure
  private recordCircuitFailure(providerId: string, errorType: ErrorType): void {
    const circuit = this.getCircuitState(providerId);
    const now = Date.now();

    // Only count consecutive failures for RETRYABLE errors
    // NON_RETRYABLE and QUOTA_EXCEEDED don't trip the circuit
    if (errorType === ErrorType.RETRYABLE) {
      circuit.failureCount++;
      circuit.lastFailureTime = now;

      if (circuit.failureCount >= this.CIRCUIT_FAILURE_THRESHOLD) {
        circuit.state = CircuitState.OPEN;
        circuit.nextRetryTime = now + this.CIRCUIT_COOLDOWN_MS;
        logger.warn(
          { providerId, failureCount: circuit.failureCount },
          'Circuit breaker OPENED due to consecutive failures'
        );
      }
    }
  }

  private getAvailableProvider(): { config: AIProviderConfig; provider: AIProvider } | null {
    for (const config of this.providerConfigs) {
      // Check daily limit
      if (config.usedToday >= config.dailyLimit) {
        continue;
      }

      // Check circuit breaker state
      if (!this.isCircuitClosed(config.id)) {
        continue;
      }

      const provider = this.providers.get(config.id);
      if (provider) {
        return { config, provider };
      }
    }
    return null;
  }

  async generateResponse(context: AIConversationContext): Promise<AIGenerationResult> {
    const log = createChildLogger({
      customerId: context.customerId,
      service: 'ai',
    });

    const systemPrompt = await this.buildSystemPrompt(context);
    const messages = this.prepareMessages(context);

    let lastError: ClassifiedError | null = null;
    const triedProviders: string[] = [];

    // Try each available provider
    while (true) {
      const available = this.getAvailableProvider();

      if (!available) {
        // No more providers available
        if (triedProviders.length === 0) {
          log.error('No AI providers available - all exhausted or circuit open');
          throw new Error('All AI providers are unavailable (exhausted or unhealthy)');
        }
        break; // Exit and throw last error
      }

      const { config, provider } = available;

      // Skip if already tried this provider
      if (triedProviders.includes(config.id)) {
        config.usedToday = config.dailyLimit; // Temporarily mark as exhausted to skip
        continue;
      }

      triedProviders.push(config.id);

      // Retry logic with exponential backoff for this provider
      for (let retryAttempt = 0; retryAttempt <= this.MAX_RETRIES_PER_PROVIDER; retryAttempt++) {
        try {
          // Apply exponential backoff for retries (not for first attempt)
          if (retryAttempt > 0) {
            const backoffMs = Math.min(1000 * Math.pow(2, retryAttempt - 1), 4000); // Max 4 seconds
            log.info(
              { provider: config.type, retryAttempt, backoffMs },
              'Retrying after backoff'
            );
            await sleep(backoffMs);
          }

          // Wrap provider.generate with timeout to prevent hanging
          const result = await withTimeout(
            provider.generate(systemPrompt, messages, context),
            TIMEOUT_CONSTANTS.AI_PROVIDER_EXECUTION,
            'ai-provider-generate',
            {
              providerId: config.id,
              providerType: config.type,
              customerId: context.customerId,
              retryAttempt
            }
          );

          // Success! Record usage and circuit state
          await this.recordUsage(config.id, result);
          config.usedToday++;
          this.recordCircuitSuccess(config.id);

          log.info(
            {
              provider: config.type,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              latencyMs: result.latencyMs,
              retriesUsed: retryAttempt
            },
            'AI response generated successfully'
          );

          return result;

        } catch (error) {
          const classified = classifyError(error);
          lastError = classified;

          log.warn(
            {
              error: classified.originalError,
              errorType: classified.type,
              errorMessage: classified.message,
              provider: config.type,
              retryAttempt,
              maxRetries: this.MAX_RETRIES_PER_PROVIDER
            },
            'AI provider request failed'
          );

          // Handle error based on type
          if (classified.type === ErrorType.QUOTA_EXCEEDED) {
            // Mark daily limit as exhausted only for quota errors
            log.warn({ provider: config.type }, 'Provider quota exceeded, marking as exhausted');
            await this.markProviderExhausted(config.id);
            config.usedToday = config.dailyLimit;
            break; // Don't retry, move to next provider

          } else if (classified.type === ErrorType.NON_RETRYABLE) {
            // Don't retry for auth/validation errors, move to next provider
            log.error(
              { provider: config.type, error: classified.message },
              'Non-retryable error, skipping provider'
            );
            this.recordCircuitFailure(config.id, classified.type);
            break; // Move to next provider

          } else if (classified.type === ErrorType.RETRYABLE) {
            // Retry for network/timeout/5xx errors
            if (retryAttempt >= this.MAX_RETRIES_PER_PROVIDER) {
              // Max retries reached, record circuit failure and move to next provider
              log.warn(
                { provider: config.type, retries: retryAttempt },
                'Max retries reached for provider'
              );
              this.recordCircuitFailure(config.id, classified.type);
              break; // Move to next provider
            }
            // Continue to next retry attempt
          }
        }
      }
    }

    // All providers failed
    log.error(
      { error: lastError?.originalError, triedProviders },
      'All AI providers failed after retries'
    );
    throw lastError?.originalError || new Error('AI generation failed - all providers unavailable');
  }

  // Helper to mark provider as exhausted in database
  private async markProviderExhausted(providerId: string): Promise<void> {
    try {
      await prisma.aIProvider.update({
        where: { id: providerId },
        data: { usedToday: { set: 999999 } } // Large number to mark as exhausted
      });
    } catch (error) {
      logger.error({ error, providerId }, 'Failed to mark provider as exhausted');
    }
  }

  private async buildSystemPrompt(context: AIConversationContext): Promise<string> {
    const defaultPrompt = await prisma.systemPrompt.findFirst({
      where: { name: 'default', isActive: true },
    });

    const services = await prisma.service.findMany({
      where: { isActive: true },
      include: {
        packages: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
      },
      orderBy: { displayOrder: 'asc' },
    });

    const paymentConfigs = await prisma.paymentConfig.findMany({
      where: { isActive: true },
    });

    type ServiceWithPackages = Service & { packages: Package[] };

    const servicesInfo = services
      .map((s: ServiceWithPackages) => {
        const packages = s.packages
          .map(
            (p: Package) =>
              `  - ${p.name}: ${p.currency} ${p.price} (${p.duration || 'One-time'})\n    Features: ${p.features.join(', ')}`
          )
          .join('\n');
        return `${s.name}:\n${s.description}\nPackages:\n${packages}`;
      })
      .join('\n\n');

    const paymentInfo = paymentConfigs
      .map(
        (p: PaymentConfig) =>
          `${p.method}: ${p.accountTitle} - ${p.accountNumber}${p.bankName ? ` (${p.bankName})` : ''}`
      )
      .join('\n');

    const basePrompt =
      defaultPrompt?.content ||
      `You are a helpful sales assistant for a service-based business on WhatsApp.
Your role is to:
1. Greet customers warmly
2. Understand their needs
3. Recommend appropriate services and packages
4. Guide them through the purchase process
5. Collect payment information
6. Provide support

IMPORTANT RULES:
- ONLY recommend services and packages that are listed below
- NEVER invent or suggest services that don't exist
- NEVER modify prices or offer discounts unless explicitly configured
- Be professional, friendly, and helpful
- If a customer asks for something we don't offer, politely explain what we do offer
- Always confirm details before processing orders`;

    return `${basePrompt}

AVAILABLE SERVICES AND PACKAGES:
${servicesInfo}

PAYMENT METHODS:
${paymentInfo}

CUSTOMER INFORMATION:
- Name: ${context.customerName || 'Unknown'}
- Language preference: ${context.language}
- Phone: ${context.phoneNumber}

${context.currentIntent ? `Current conversation stage: ${context.currentIntent}` : ''}
${context.selectedService ? `Selected service: ${context.selectedService.name}` : ''}
${context.selectedPackage ? `Selected package: ${context.selectedPackage.name} (${context.selectedPackage.currency} ${context.selectedPackage.price})` : ''}
${context.orderInProgress ? `Order in progress: ${context.orderInProgress.orderNumber} - Status: ${context.orderInProgress.status}` : ''}

Respond in ${context.language === 'ur' ? 'Urdu (using Roman Urdu script)' : context.language === 'ar' ? 'Arabic' : 'English'}.
Keep responses concise and suitable for WhatsApp (under 500 characters when possible).`;
  }

  private prepareMessages(context: AIConversationContext): AIMessage[] {
    const recentHistory = context.conversationHistory.slice(-10);

    return recentHistory.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));
  }

  private async recordUsage(
    providerId: string,
    result: AIGenerationResult
  ): Promise<void> {
    try {
      await prisma.$transaction([
        prisma.aIUsageLog.create({
          data: {
            providerId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: result.latencyMs,
            success: true,
          },
        }),
        prisma.aIProvider.update({
          where: { id: providerId },
          data: {
            usedToday: { increment: 1 },
          },
        }),
      ]);
    } catch (error) {
      logger.error({ error, providerId }, 'Failed to record AI usage');
    }
  }

  async reloadProviders(): Promise<void> {
    await this.loadProviders();
    logger.info('AI providers reloaded');
  }

  getProviderStats(): {
    id: string;
    type: AIProviderType;
    usedToday: number;
    dailyLimit: number;
    available: boolean;
    circuitState: CircuitState;
    failureCount: number;
  }[] {
    return this.providerConfigs.map((c) => {
      const circuit = this.getCircuitState(c.id);
      return {
        id: c.id,
        type: c.type,
        usedToday: c.usedToday,
        dailyLimit: c.dailyLimit,
        available: c.usedToday < c.dailyLimit && this.isCircuitClosed(c.id),
        circuitState: circuit.state,
        failureCount: circuit.failureCount,
      };
    });
  }

  /**
   * Health check: returns true if at least one provider is configured
   * Used by readiness probes to determine if AI service is operational
   */
  hasAvailableProviders(): boolean {
    return this.providerConfigs.length > 0;
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down AI service');

    // Clear reset timer
    if (this.resetTimer) {
      clearInterval(this.resetTimer);
      this.resetTimer = undefined;
    }

    // Clear provider data
    this.providers.clear();
    this.providerConfigs = [];
    this.circuitBreakers.clear();

    logger.info('AI service shutdown complete');
  }
}

export const aiService = new AIService();

import type { DataProvider, ProviderCapability } from './types.js';
import { httpRequest } from '../lib/http-client.js';
import { logger, type Logger } from '../lib/logger.js';

export abstract class BaseProvider implements Partial<DataProvider> {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: ProviderCapability[];

  protected apiKey: string;
  protected baseUrl: string;
  protected log: Logger;

  private requestCounts = { second: 0, minute: 0 };
  private limits: { perSecond: number; perMinute: number };
  private queue: Array<() => void> = [];

  constructor(config: {
    apiKey: string;
    baseUrl: string;
    rateLimit?: { perSecond?: number; perMinute?: number };
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.limits = {
      perSecond: config.rateLimit?.perSecond ?? Infinity,
      perMinute: config.rateLimit?.perMinute ?? Infinity,
    };
    this.log = logger.child({ provider: 'base' });

    setInterval(() => {
      this.requestCounts.second = 0;
      this.drainQueue();
    }, 1000);

    setInterval(() => {
      this.requestCounts.minute = 0;
      this.drainQueue();
    }, 60_000);
  }

  protected async request<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    options?: { body?: unknown; params?: Record<string, string>; timeout?: number; retry?: { limit: number } },
  ): Promise<T> {
    await this.acquireSlot();

    return httpRequest<T>(method, `${this.baseUrl}${path}`, {
      headers: this.getAuthHeaders(),
      body: options?.body,
      params: options?.params,
      timeout: options?.timeout,
      retry: options?.retry,
    });
  }

  protected abstract getAuthHeaders(): Record<string, string>;

  async healthCheck(): Promise<boolean> {
    return true;
  }

  protected getPopulatedFields(obj: Record<string, unknown>): string[] {
    return Object.entries(obj)
      .filter(([key, value]) => {
        if (key === 'externalIds') return false;
        if (value == null || value === '') return false;
        if (Array.isArray(value) && value.length === 0) return false;
        return true;
      })
      .map(([key]) => key);
  }

  private async acquireSlot(): Promise<void> {
    if (this.canProceed()) {
      this.requestCounts.second++;
      this.requestCounts.minute++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private canProceed(): boolean {
    return (
      this.requestCounts.second < this.limits.perSecond &&
      this.requestCounts.minute < this.limits.perMinute
    );
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.canProceed()) {
      this.requestCounts.second++;
      this.requestCounts.minute++;
      const resolve = this.queue.shift()!;
      resolve();
    }
  }
}

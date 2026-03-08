import { apiClient } from '../api-client';
import type { ApiResponse } from '../types';

export interface ProviderTask {
  provider:
    | 'google_places'
    | 'listings_opentable'
    | 'listings_ubereats'
    | 'listings_justeat'
    | 'news'
    | 'reviews'
    | 'apollo'
    | 'social_instagram'
    | 'social_linkedin';
  priority: 'primary' | 'supplemental';
  rationale: string;
  params: {
    queries?: string[];
    query?: string;
    location?: string;
    category?: string;
    platform?: string;
    limit?: number;
  };
}

export interface MarketBuilderPlan {
  reasoning: string;
  vertical: string;
  providers: ProviderTask[];
  expectedOutcome: string;
  version: number;
}

export interface ExecutionRecord {
  executedAt: string;
  listId?: string;
  byProvider: Record<string, { found: number; added: number; error?: string }>;
  totalFound: number;
  totalAdded: number;
}

export interface SavedPlan {
  id: string;
  clientId: string;
  icpId: string | null;
  plan: MarketBuilderPlan;
  status: 'draft' | 'approved' | 'archived';
  feedbackHistory: { feedback: string; respondedAt: string }[];
  executionHistory: ExecutionRecord[];
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function generateMarketPlan(clientId: string, icpId?: string): Promise<MarketBuilderPlan> {
  const res = await apiClient.post<ApiResponse<MarketBuilderPlan>>('/api/market-builder/plan/generate', { clientId, icpId });
  return res.data;
}

export async function refineMarketPlan(
  clientId: string,
  plan: MarketBuilderPlan,
  feedback: string,
): Promise<MarketBuilderPlan> {
  const res = await apiClient.post<ApiResponse<MarketBuilderPlan>>('/api/market-builder/plan/refine', {
    clientId,
    plan,
    feedback,
  });
  return res.data;
}

export async function approveMarketPlan(
  clientId: string,
  plan: MarketBuilderPlan,
  icpId?: string | null,
): Promise<SavedPlan> {
  const res = await apiClient.post<ApiResponse<SavedPlan>>('/api/market-builder/plan/approve', {
    clientId,
    plan,
    icpId: icpId ?? null,
  });
  return res.data;
}

export async function getApprovedPlan(clientId: string, icpId?: string): Promise<SavedPlan | null> {
  const params = new URLSearchParams({ clientId });
  if (icpId) params.set('icpId', icpId);
  const res = await apiClient.get<ApiResponse<SavedPlan | null>>(`/api/market-builder/plan?${params}`);
  return res.data;
}

export async function executeMarketPlan(
  planId: string,
  clientId: string,
  listId?: string,
): Promise<void> {
  await apiClient.post('/api/market-builder/build', { planId, clientId, listId });
}

export async function autoMarketBuild(clientId: string, listId?: string): Promise<void> {
  await apiClient.post('/api/market-builder/build-auto', { clientId, listId });
}

import { apiClient } from '../api-client';
import type { List, ListMember, ListType, Job, FunnelStats, ApiResponse, PipelineStage, CompanySignal, ContactSignal, EngagementBrief } from '../types';

export async function getLists(clientId?: string): Promise<List[]> {
  const query = clientId ? `?clientId=${clientId}` : '';
  const res = await apiClient.get<ApiResponse<List[]>>(`/api/lists${query}`);
  return res.data;
}

export async function getList(id: string): Promise<List> {
  const res = await apiClient.get<ApiResponse<List>>(`/api/lists/${id}`);
  return res.data;
}

export async function createList(data: {
  clientId: string;
  icpId?: string;
  personaId?: string;
  name: string;
  description?: string;
  type?: ListType;
}): Promise<List> {
  const res = await apiClient.post<ApiResponse<List>>('/api/lists', data);
  return res.data;
}

export interface BuildOptions {
  limit?: number;
  skipExistingDb?: boolean;
  providerOrder?: string[];
}

export async function buildList(id: string, options?: BuildOptions): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/build`, options ?? {});
  return res.data;
}

export async function getAvailableProviders(): Promise<string[]> {
  const res = await apiClient.get<ApiResponse<string[]>>('/api/lists/providers');
  return res.data;
}

export async function refreshList(id: string): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/refresh`);
  return res.data;
}

export async function updateListSchedule(
  id: string,
  data: { refreshEnabled: boolean; refreshCron?: string },
): Promise<List> {
  const res = await apiClient.patch<ApiResponse<List>>(`/api/lists/${id}/schedule`, data);
  return res.data;
}

export async function getBuildStatus(id: string): Promise<Job> {
  const res = await apiClient.get<ApiResponse<Job>>(`/api/lists/${id}/build-status`);
  return res.data;
}

interface RawListMember {
  id: string;
  companyId: string | null;
  contactId: string | null;
  icpFitScore: string | null;
  companySignalScore: string | null;
  signalScore: string | null;
  intelligenceScore: string | null;
  personaScore: string | null;
  addedReason: string | null;
  addedAt: string;
  companyName: string | null;
  companyDomain: string | null;
  companyIndustry: string | null;
  companySource: string | null;
  companyWebsiteProfile: string | null;
  pipelineStage: PipelineStage | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  engagementBrief: EngagementBrief | null;
  briefGeneratedAt: string | null;
}

export async function getListMembers(
  id: string,
  params?: { limit?: number; offset?: number; stage?: PipelineStage },
): Promise<ListMember[]> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.stage) query.set('stage', params.stage);
  const qs = query.toString() ? `?${query.toString()}` : '';
  const res = await apiClient.get<ApiResponse<RawListMember[]>>(`/api/lists/${id}/members${qs}`);

  // Transform flat API response into nested ListMember shape
  return res.data.map((row) => ({
    id: row.id,
    listId: id,
    companyId: row.companyId,
    contactId: row.contactId,
    icpFitScore: row.icpFitScore,
    companySignalScore: row.companySignalScore,
    signalScore: row.signalScore,
    intelligenceScore: row.intelligenceScore,
    personaScore: row.personaScore,
    addedReason: row.addedReason,
    addedAt: row.addedAt,
    removedAt: null,
    companyName: row.companyName,
    companyDomain: row.companyDomain,
    companyIndustry: row.companyIndustry,
    companySource: row.companySource,
    companyWebsiteProfile: row.companyWebsiteProfile,
    pipelineStage: row.pipelineStage,
    company: row.companyId
      ? { name: row.companyName ?? '', domain: row.companyDomain } as ListMember['company']
      : undefined,
    contact: row.contactId
      ? {
          firstName: row.contactName?.split(' ')[0] ?? null,
          lastName: row.contactName?.split(' ').slice(1).join(' ') ?? null,
          title: row.contactTitle ?? null,
          workEmail: row.contactEmail ?? null,
        } as ListMember['contact']
      : undefined,
    engagementBrief: row.engagementBrief,
    briefGeneratedAt: row.briefGeneratedAt,
  }));
}

export async function getFunnelStats(id: string): Promise<FunnelStats> {
  const res = await apiClient.get<ApiResponse<FunnelStats>>(`/api/lists/${id}/funnel`);
  return res.data;
}

export async function runCompanySignals(id: string): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/signals/company`);
  return res.data;
}

export async function buildContacts(
  id: string,
  data: { personaId: string; name?: string },
): Promise<{ jobId: string; contactListId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string; contactListId: string }>>(
    `/api/lists/${id}/build-contacts`,
    data,
  );
  return res.data;
}

export async function runPersonaSignals(id: string): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/signals/persona`);
  return res.data;
}

export async function deepEnrich(id: string): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/deep-enrich`);
  return res.data;
}

export async function applyMarketSignals(id: string, options?: { forceFresh?: boolean }): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/apply-market-signals`, options);
  return res.data;
}

export async function getMemberSignals(id: string, clientId: string): Promise<CompanySignal[]> {
  const res = await apiClient.get<ApiResponse<CompanySignal[]>>(`/api/lists/${id}/member-signals?clientId=${clientId}`);
  return res.data;
}

export async function getContactSignals(id: string, clientId: string): Promise<ContactSignal[]> {
  const res = await apiClient.get<ApiResponse<ContactSignal[]>>(`/api/lists/${id}/contact-signals?clientId=${clientId}`);
  return res.data;
}

export async function generateBriefs(
  id: string,
  data?: { forceRegenerate?: boolean },
): Promise<{ jobId: string }> {
  const res = await apiClient.post<ApiResponse<{ jobId: string }>>(`/api/lists/${id}/generate-briefs`, data ?? {});
  return res.data;
}

export async function deleteList(id: string): Promise<void> {
  await apiClient.delete(`/api/lists/${id}`);
}

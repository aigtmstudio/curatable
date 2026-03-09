import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as listsApi from '../api/lists';
import type { PipelineStage } from '../types';

export const listKeys = {
  all: (clientId?: string) => clientId ? ['lists', clientId] as const : ['lists'] as const,
  detail: (id: string) => ['lists', 'detail', id] as const,
  members: (id: string) => ['lists', 'members', id] as const,
  memberSignals: (id: string) => ['lists', 'member-signals', id] as const,
  contactSignals: (id: string) => ['lists', 'contact-signals', id] as const,
  funnel: (id: string) => ['lists', 'funnel', id] as const,
  buildStatus: (id: string) => ['lists', 'build-status', id] as const,
};

export function useLists(clientId?: string) {
  return useQuery({
    queryKey: listKeys.all(clientId),
    queryFn: () => listsApi.getLists(clientId),
    staleTime: 30 * 1000,
  });
}

export function useList(id: string | null) {
  return useQuery({
    queryKey: listKeys.detail(id!),
    queryFn: () => listsApi.getList(id!),
    enabled: !!id,
    staleTime: 30 * 1000,
  });
}

export function useListMembers(id: string | null, params?: { limit?: number; offset?: number; stage?: PipelineStage }) {
  return useQuery({
    queryKey: [...listKeys.members(id!), params],
    queryFn: () => listsApi.getListMembers(id!, params),
    enabled: !!id,
    staleTime: 30 * 1000,
  });
}

export function useFunnelStats(id: string | null) {
  return useQuery({
    queryKey: listKeys.funnel(id!),
    queryFn: () => listsApi.getFunnelStats(id!),
    enabled: !!id,
    staleTime: 30 * 1000,
  });
}

export function useCreateList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: listsApi.createList,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lists'] }),
  });
}

export function useBuildList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, options }: { id: string; options?: listsApi.BuildOptions }) =>
      listsApi.buildList(id, options),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: listKeys.buildStatus(id) });
    },
  });
}

export function useAvailableProviders() {
  return useQuery({
    queryKey: ['lists', 'providers'],
    queryFn: listsApi.getAvailableProviders,
    staleTime: 5 * 60 * 1000, // providers don't change often
  });
}

export function useBuildStatus(listId: string | null) {
  return useQuery({
    queryKey: listKeys.buildStatus(listId!),
    queryFn: () => listsApi.getBuildStatus(listId!),
    enabled: !!listId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll every 2s while pending/running, stop when done
      if (status === 'pending' || status === 'running') return 2000;
      return false;
    },
    staleTime: 0,
  });
}

export function useRefreshList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: listsApi.refreshList,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useUpdateListSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof listsApi.updateListSchedule>[1] }) =>
      listsApi.updateListSchedule(id, data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: listKeys.detail(id) });
    },
  });
}

export function useRunCompanySignals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: listsApi.runCompanySignals,
    onSuccess: (_, listId) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: listKeys.funnel(listId) });
      qc.invalidateQueries({ queryKey: listKeys.members(listId) });
    },
  });
}

export function useBuildContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { personaId: string; name?: string } }) =>
      listsApi.buildContacts(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useRunPersonaSignals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: listsApi.runPersonaSignals,
    onSuccess: (_, listId) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: listKeys.contactSignals(listId) });
      qc.invalidateQueries({ queryKey: listKeys.members(listId) });
    },
  });
}

export function useMemberSignals(listId: string | null, clientId: string | null) {
  return useQuery({
    queryKey: listKeys.memberSignals(listId!),
    queryFn: () => listsApi.getMemberSignals(listId!, clientId!),
    enabled: !!listId && !!clientId,
    staleTime: 30 * 1000,
  });
}

export function useContactSignals(listId: string | null, clientId: string | null) {
  return useQuery({
    queryKey: listKeys.contactSignals(listId!),
    queryFn: () => listsApi.getContactSignals(listId!, clientId!),
    enabled: !!listId && !!clientId,
    staleTime: 30 * 1000,
  });
}

export function useApplyMarketSignals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, forceFresh }: { id: string; forceFresh?: boolean }) =>
      listsApi.applyMarketSignals(id, { forceFresh }),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: listKeys.funnel(id) });
      qc.invalidateQueries({ queryKey: listKeys.members(id) });
      qc.invalidateQueries({ queryKey: listKeys.memberSignals(id) });
    },
  });
}

export function useDeepEnrich() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: listsApi.deepEnrich,
    onSuccess: (_, listId) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: listKeys.members(listId) });
    },
  });
}

export function useGenerateBriefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => listsApi.generateBriefs(id),
    onSuccess: (_, listId) => {
      qc.invalidateQueries({ queryKey: ['lists'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: listKeys.members(listId) });
    },
  });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: listsApi.deleteList,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lists'] });
    },
  });
}

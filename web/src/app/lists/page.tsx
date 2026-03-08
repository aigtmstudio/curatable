'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/lib/store';
import { useLists, useCreateList, useBuildList, useRefreshList, useBuildStatus, useDeleteList, useAvailableProviders } from '@/lib/hooks/use-lists';
import { useIcps } from '@/lib/hooks/use-icps';
import { useTriggerExport } from '@/lib/hooks/use-exports';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DialogDescription } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDate, formatRelativeTime, formatNumber } from '@/lib/utils';
import { Plus, List, MoreHorizontal, Play, RefreshCw, Download, Loader2, Trash2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorBanner } from '@/components/shared/error-banner';
import type { ColumnDef } from '@tanstack/react-table';
import type { List as ListType } from '@/lib/types';
import * as marketBuilderApi from '@/lib/api/market-builder';
import type { MarketBuilderPlan, SavedPlan as MarketBuilderSavedPlan } from '@/lib/api/market-builder';

export default function ListsPage() {
  const qc = useQueryClient();
  const { selectedClientId } = useAppStore();
  const { data: lists, isLoading, isError, refetch } = useLists(selectedClientId ?? undefined);
  const { data: icps } = useIcps(selectedClientId);
  const createList = useCreateList();
  const buildList = useBuildList();
  const refreshList = useRefreshList();
  const triggerExport = useTriggerExport();
  const deleteList = useDeleteList();

  const { data: availableProviders } = useAvailableProviders();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [newIcpId, setNewIcpId] = useState('');
  const [buildingListId, setBuildingListId] = useState<string | null>(null);
  const { data: buildJob } = useBuildStatus(buildingListId);
  const [buildOptionsTarget, setBuildOptionsTarget] = useState<string | null>(null);
  const [buildLimit, setBuildLimit] = useState('100');
  const [skipExistingDb, setSkipExistingDb] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);

  // AI Market Builder state
  const [aiPlan, setAiPlan] = useState<MarketBuilderPlan | null>(null);
  const [aiSavedPlan, setAiSavedPlan] = useState<MarketBuilderSavedPlan | null>(null);
  const [aiPlanLoading, setAiPlanLoading] = useState(false);
  const [aiPlanRefining, setAiPlanRefining] = useState(false);
  const [aiPlanApproving, setAiPlanApproving] = useState(false);
  const [aiPlanFeedback, setAiPlanFeedback] = useState('');
  const [aiPlanOpen, setAiPlanOpen] = useState(false);

  const handleCreate = async () => {
    if (!newName.trim() || !selectedClientId || !newIcpId) return;
    try {
      await createList.mutateAsync({
        clientId: selectedClientId,
        name: newName,
        icpId: newIcpId,
        type: 'company',
      });
      setCreateOpen(false);
      setNewName('');
      setNewIcpId('');
      toast.success('List created');
    } catch {
      toast.error('Failed to create list');
    }
  };

  const handleBuild = (id: string) => {
    setBuildOptionsTarget(id);
  };

  const handleBuildSubmit = async () => {
    if (!buildOptionsTarget) return;
    const id = buildOptionsTarget;
    setBuildOptionsTarget(null);
    const limitNum = parseInt(buildLimit, 10);
    try {
      await buildList.mutateAsync({
        id,
        options: {
          limit: isNaN(limitNum) ? undefined : limitNum,
          skipExistingDb: skipExistingDb || undefined,
          providerOrder: selectedProviders.length > 0 ? selectedProviders : undefined,
        },
      });
      setBuildingListId(id);
      toast.success('Discovering companies from providers...');
    } catch {
      toast.error('Failed to start build');
    }
  };

  // Show toast when build completes and refresh list data
  useEffect(() => {
    if (!buildingListId || !buildJob) return;
    if (buildJob.status === 'completed') {
      const output = buildJob.output as { companiesAdded?: number; contactsAdded?: number; companiesDiscovered?: number };
      toast.success(`Build complete: ${output.companiesAdded ?? 0} companies, ${output.contactsAdded ?? 0} contacts added`);
      setBuildingListId(null);
      qc.invalidateQueries({ queryKey: ['lists', selectedClientId] });
    } else if (buildJob.status === 'failed') {
      toast.error('Build failed. Check job logs for details.');
      setBuildingListId(null);
      qc.invalidateQueries({ queryKey: ['lists', selectedClientId] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- qc is stable, selectedClientId captured in closure
  }, [buildJob?.status, buildingListId]);

  // Load existing approved plan when build dialog opens
  useEffect(() => {
    if (!buildOptionsTarget) {
      setAiPlan(null);
      setAiSavedPlan(null);
      setAiPlanOpen(false);
      setAiPlanFeedback('');
      return;
    }
    const list = lists?.find(l => l.id === buildOptionsTarget);
    if (!list?.clientId) return;
    marketBuilderApi.getApprovedPlan(list.clientId).then(plan => {
      if (plan) { setAiSavedPlan(plan); setAiPlan(plan.plan); setAiPlanOpen(true); }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildOptionsTarget]);

  const handleRefresh = async (id: string) => {
    try {
      await refreshList.mutateAsync(id);
      toast.success('List refresh started');
    } catch {
      toast.error('Failed to refresh list');
    }
  };

  const handleExport = async (listId: string) => {
    if (!selectedClientId) return;
    try {
      await triggerExport.mutateAsync({
        clientId: selectedClientId,
        listId,
        format: 'csv',
      });
      toast.success('Export started');
    } catch {
      toast.error('Failed to export');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteList.mutateAsync(deleteTarget.id);
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
    } catch {
      toast.error('Failed to delete list');
    }
  };

  const columns: ColumnDef<ListType>[] = [
    { accessorKey: 'name', header: 'Name', cell: ({ row }) => (
      <Link href={`/lists/${row.original.id}`} className="font-medium text-primary hover:underline">
        {row.original.name}
      </Link>
    )},
    { accessorKey: 'type', header: 'Type', cell: ({ row }) => (
      <Badge variant="outline" className={row.original.type === 'contact' ? 'bg-purple-50 text-purple-700 border-purple-300' : ''}>
        {row.original.type}
      </Badge>
    )},
    { accessorKey: 'memberCount', header: 'Members', cell: ({ row }) => (
      buildingListId === row.original.id ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Building...
        </span>
      ) : formatNumber(row.original.memberCount)
    )},
    { accessorKey: 'refreshEnabled', header: 'Refresh', cell: ({ row }) => (
      row.original.refreshEnabled ? (
        <Badge variant="secondary">Scheduled</Badge>
      ) : (
        <span className="text-muted-foreground">Off</span>
      )
    )},
    { accessorKey: 'lastRefreshedAt', header: 'Last Refreshed', cell: ({ row }) => formatRelativeTime(row.original.lastRefreshedAt) },
    { accessorKey: 'createdAt', header: 'Created', cell: ({ row }) => formatDate(row.original.createdAt) },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => handleBuild(row.original.id)}
              disabled={buildingListId === row.original.id}
            >
              {buildingListId === row.original.id ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {buildingListId === row.original.id ? 'Building...' : 'Build'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleRefresh(row.original.id)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport(row.original.id)}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setDeleteTarget({ id: row.original.id, name: row.original.name })}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  if (!selectedClientId) {
    return (
      <EmptyState
        icon={List}
        title="No client selected"
        description="Select a client from the header to view lists."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Lists</h1>
          <p className="text-muted-foreground">Build and manage targeted lists</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create List
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">Loading...</div>
      ) : isError ? (
        <ErrorBanner retry={() => refetch()} />
      ) : !lists?.length ? (
        <EmptyState
          icon={List}
          title="No lists yet"
          description="Create your first list to start targeting companies and contacts."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create List
            </Button>
          }
        />
      ) : (
        <DataTable columns={columns} data={lists} />
      )}

      {/* Build Options Dialog */}
      <Dialog open={!!buildOptionsTarget} onOpenChange={(open) => !open && setBuildOptionsTarget(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Build List</DialogTitle>
            <DialogDescription>Configure how companies are discovered and added to this list.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2 overflow-y-auto flex-1 pr-1">
            <div className="space-y-1.5">
              <Label htmlFor="build-limit-ov">Target companies to discover</Label>
              <Input
                id="build-limit-ov"
                type="number"
                min={1}
                max={1000}
                value={buildLimit}
                onChange={e => setBuildLimit(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">How many companies to discover from external providers (default: 100).</p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="skip-existing-ov">Only use newly discovered companies</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Off: also score companies already in your database. On: only add companies found in this run.</p>
              </div>
              <Switch id="skip-existing-ov" checked={skipExistingDb} onCheckedChange={setSkipExistingDb} />
            </div>
            {availableProviders && availableProviders.length > 0 && (
              <div className="space-y-2">
                <Label>Providers to use</Label>
                <p className="text-xs text-muted-foreground">Providers are tried in this order. Uncheck to skip a provider.</p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {availableProviders.map(provider => {
                    const effectiveList = selectedProviders.length > 0 ? selectedProviders : availableProviders;
                    const isChecked = effectiveList.includes(provider);
                    return (
                      <div key={provider} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={`ov-provider-${provider}`}
                          checked={isChecked}
                          onChange={e => {
                            const current = selectedProviders.length > 0 ? selectedProviders : [...availableProviders];
                            if (e.target.checked) {
                              const ordered = availableProviders.filter(p => [...current, provider].includes(p));
                              setSelectedProviders(ordered);
                            } else {
                              setSelectedProviders(current.filter(p => p !== provider));
                            }
                          }}
                          className="h-4 w-4 rounded border-input"
                        />
                        <label htmlFor={`ov-provider-${provider}`} className="text-sm cursor-pointer font-mono">{provider}</label>
                      </div>
                    );
                  })}
                </div>
                {selectedProviders.length > 0 && selectedProviders.length < availableProviders.length && (
                  <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setSelectedProviders([])}>
                    Reset to all providers
                  </button>
                )}
              </div>
            )}

            {/* AI Market Builder Strategy */}
            <div className="space-y-2 border rounded-lg p-3 bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-600 flex-shrink-0" />
                  <span className="text-sm font-medium">AI Market Builder</span>
                  {aiSavedPlan && (
                    <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5">Plan saved</span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={aiPlanLoading}
                  onClick={async () => {
                    const list = lists?.find(l => l.id === buildOptionsTarget);
                    const clientId = list?.clientId;
                    if (!clientId) return;
                    setAiPlanLoading(true);
                    setAiPlanOpen(true);
                    try {
                      const plan = await marketBuilderApi.generateMarketPlan(clientId, list.icpId ?? undefined);
                      setAiPlan(plan);
                      setAiSavedPlan(null);
                      setAiPlanFeedback('');
                    } catch {
                      toast.error('Failed to generate plan');
                    } finally {
                      setAiPlanLoading(false);
                    }
                  }}
                >
                  {aiPlanLoading
                    ? <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" />Thinking…</>
                    : aiPlan
                      ? <><Sparkles className="mr-1.5 h-3 w-3" />Regenerate</>
                      : <><Sparkles className="mr-1.5 h-3 w-3" />Generate Plan</>
                  }
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Opus analyses your ICP and selects the right discovery sources automatically. Use this <em>instead of</em> Manual Discovery below.
              </p>

              {aiPlanOpen && aiPlan && !aiPlanLoading && (
                <div className="space-y-3 pt-1">
                  <div className="flex items-start gap-2 flex-wrap">
                    <span className="inline-flex items-center rounded-full bg-purple-100 text-purple-800 text-xs font-medium px-2 py-0.5">{aiPlan.vertical}</span>
                    <span className="text-xs text-muted-foreground">{aiPlan.expectedOutcome}</span>
                  </div>
                  <div className="text-xs text-foreground/80 space-y-1.5 leading-relaxed">
                    {aiPlan.reasoning.split('\n\n').filter(Boolean).map((para, i) => (
                      <p key={i}>{para.replace(/^#+\s*/, '')}</p>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Providers</p>
                    <div className="space-y-1">
                      {aiPlan.providers.map((task, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className={`rounded px-1.5 py-0.5 font-mono flex-shrink-0 ${task.priority === 'primary' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                            {task.provider}
                          </span>
                          <span className="text-muted-foreground">{task.rationale}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      className="w-full text-xs border border-input rounded px-2.5 py-1.5 bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Tell the AI what to change… (e.g. remove reviews, add LinkedIn)"
                      value={aiPlanFeedback}
                      onChange={e => setAiPlanFeedback(e.target.value)}
                      onKeyDown={async e => {
                        if (e.key !== 'Enter' || !aiPlanFeedback.trim() || aiPlanRefining) return;
                        const list = lists?.find(l => l.id === buildOptionsTarget);
                        const clientId = list?.clientId;
                        if (!clientId) return;
                        setAiPlanRefining(true);
                        try {
                          const refined = await marketBuilderApi.refineMarketPlan(clientId, aiPlan, aiPlanFeedback);
                          setAiPlan(refined);
                          setAiPlanFeedback('');
                        } catch { toast.error('Failed to refine plan'); }
                        finally { setAiPlanRefining(false); }
                      }}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button" variant="outline" size="sm"
                        disabled={!aiPlanFeedback.trim() || aiPlanRefining}
                        onClick={async () => {
                          const list = lists?.find(l => l.id === buildOptionsTarget);
                          const clientId = list?.clientId;
                          if (!clientId) return;
                          setAiPlanRefining(true);
                          try {
                            const refined = await marketBuilderApi.refineMarketPlan(clientId, aiPlan, aiPlanFeedback);
                            setAiPlan(refined);
                            setAiPlanFeedback('');
                          } catch { toast.error('Failed to refine plan'); }
                          finally { setAiPlanRefining(false); }
                        }}
                      >
                        {aiPlanRefining ? <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" />Refining…</> : 'Refine'}
                      </Button>
                      <Button
                        type="button" size="sm"
                        disabled={aiPlanApproving}
                        className="bg-purple-600 hover:bg-purple-700 text-white"
                        onClick={async () => {
                          const list = lists?.find(l => l.id === buildOptionsTarget);
                          const clientId = list?.clientId;
                          if (!clientId) return;
                          setAiPlanApproving(true);
                          try {
                            const saved = await marketBuilderApi.approveMarketPlan(clientId, aiPlan, list?.icpId ?? undefined);
                            setAiSavedPlan(saved);
                            await marketBuilderApi.executeMarketPlan(saved.id, clientId, buildOptionsTarget ?? undefined);
                            toast.success('AI market build started in background');
                            setBuildOptionsTarget(null);
                          } catch { toast.error('Failed to approve plan'); }
                          finally { setAiPlanApproving(false); }
                        }}
                      >
                        {aiPlanApproving
                          ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</>
                          : <><Sparkles className="mr-1.5 h-3.5 w-3.5" />Approve & Execute</>}
                      </Button>
                    </div>
                    {aiSavedPlan && (
                      <p className="text-xs text-green-700 text-center">Plan v{aiPlan.version} saved — future builds will use this as a reference</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex-shrink-0 pt-2 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBuildOptionsTarget(null)}>Cancel</Button>
            <Button onClick={handleBuildSubmit}>
              <Play className="mr-2 h-4 w-4" />
              Build
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete list</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Any child contact lists will also be removed.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteList.isPending}>
              {deleteList.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create List</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Enterprise SaaS Targets"
              />
            </div>
            <div className="space-y-2">
              <Label>ICP</Label>
              <Select value={newIcpId} onValueChange={setNewIcpId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an ICP" />
                </SelectTrigger>
                <SelectContent>
                  {icps?.map((icp) => (
                    <SelectItem key={icp.id} value={icp.id}>
                      {icp.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newName.trim() || !newIcpId || createList.isPending}>
                {createList.isPending ? 'Creating...' : 'Create List'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

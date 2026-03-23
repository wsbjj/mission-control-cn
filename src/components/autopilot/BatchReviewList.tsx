'use client';

import {useState, useCallback, useMemo} from 'react';
import {useTranslations} from 'next-intl';
import {ArrowUpDown, CheckSquare, Square, Loader, Send} from 'lucide-react';
import {BatchReviewRow} from './BatchReviewRow';
import type {Idea, SwipeAction} from '@/lib/types';

interface BatchReviewListProps {
  productId: string;
  ideas: Idea[];
  onBatchComplete: () => void;
}

type SortField = 'impact_score' | 'feasibility_score' | 'complexity' | 'category' | 'created_at';
type SortDir = 'asc' | 'desc';

type SortLabelKey = 'sortImpact' | 'sortFeasibility' | 'sortComplexity' | 'sortCategory' | 'sortDate';

const SORT_OPTIONS: {value: SortField; labelKey: SortLabelKey}[] = [
  {value: 'impact_score', labelKey: 'sortImpact'},
  {value: 'feasibility_score', labelKey: 'sortFeasibility'},
  {value: 'complexity', labelKey: 'sortComplexity'},
  {value: 'category', labelKey: 'sortCategory'},
  {value: 'created_at', labelKey: 'sortDate'},
];

const complexityOrder: Record<string, number> = { S: 1, M: 2, L: 3, XL: 4 };

function sortIdeas(ideas: Idea[], field: SortField, dir: SortDir): Idea[] {
  return [...ideas].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'impact_score':
        cmp = (a.impact_score ?? 0) - (b.impact_score ?? 0);
        break;
      case 'feasibility_score':
        cmp = (a.feasibility_score ?? 0) - (b.feasibility_score ?? 0);
        break;
      case 'complexity':
        cmp = (complexityOrder[a.complexity || ''] || 5) - (complexityOrder[b.complexity || ''] || 5);
        break;
      case 'category':
        cmp = (a.category || '').localeCompare(b.category || '');
        break;
      case 'created_at':
        cmp = (a.created_at || '').localeCompare(b.created_at || '');
        break;
    }
    return dir === 'desc' ? -cmp : cmp;
  });
}

export function BatchReviewList({productId, ideas: initialIdeas, onBatchComplete}: BatchReviewListProps) {
  const t = useTranslations('autopilotBatchReview');
  const [ideas, setIdeas] = useState<Idea[]>(initialIdeas);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actions, setActions] = useState<Record<string, SwipeAction>>({});
  const [sortField, setSortField] = useState<SortField>('impact_score');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState<number | null>(null);

  const sortedIdeas = useMemo(() => sortIdeas(ideas, sortField, sortDir), [ideas, sortField, sortDir]);

  // Count how many ideas have actions assigned
  const actionCount = Object.keys(actions).length;
  const allSelected = ideas.length > 0 && selectedIds.size === ideas.length;

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(ideas.map(i => i.id)));
    }
  }, [allSelected, ideas]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setAction = useCallback((ideaId: string, action: SwipeAction | null) => {
    setActions(prev => {
      const next = { ...prev };
      if (action) {
        next[ideaId] = action;
        // Auto-select when action is set
        setSelectedIds(s => { const next = new Set(s); next.add(ideaId); return next; });
      } else {
        delete next[ideaId];
      }
      return next;
    });
  }, []);

  // Apply a bulk action to all selected ideas
  const applyBulkAction = useCallback((action: SwipeAction) => {
    const newActions: Record<string, SwipeAction> = { ...actions };
    selectedIds.forEach(id => {
      newActions[id] = action;
    });
    setActions(newActions);
  }, [selectedIds, actions]);

  const handleSubmit = useCallback(async () => {
    // Build the array of actions to submit — only ideas with assigned actions
    const toSubmit = Object.entries(actions)
      .filter(([id]) => ideas.some(i => i.id === id))
      .map(([idea_id, action]) => ({ idea_id, action }));

    if (toSubmit.length === 0) return;

    setSubmitting(true);
    setError(null);
    setSuccessCount(null);

    try {
      const res = await fetch(`/api/products/${productId}/swipe/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: toSubmit }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Batch submit failed' }));
        throw new Error(err.error || `Batch submit failed (${res.status})`);
      }

      const data = await res.json();
      setSuccessCount(data.processed);

      // Remove processed ideas from the list
      const processedIds = new Set(toSubmit.map(a => a.idea_id));
      setIdeas(prev => prev.filter(i => !processedIds.has(i.id)));
      setActions(prev => {
        const next = { ...prev };
        processedIds.forEach(id => delete next[id]);
        return next;
      });
      setSelectedIds(prev => {
        const next = new Set(prev);
        processedIds.forEach(id => next.delete(id));
        return next;
      });

      // If all ideas processed, callback
      if (processedIds.size === ideas.length) {
        setTimeout(() => onBatchComplete(), 1500);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [actions, ideas, productId, onBatchComplete]);

  const handleSort = useCallback((field: SortField) => {
    if (field === sortField) {
      setSortDir(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }, [sortField]);

  if (ideas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4">
        <div className="text-4xl">&#10024;</div>
        <h3 className="text-lg font-semibold text-mc-text">
          {successCount != null
            ? t('ideasProcessedTitle', {count: successCount})
            : t('noPendingTitle')}
        </h3>
        <p className="text-sm text-mc-text-secondary">{t('allReviewed')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header controls */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-mc-border bg-mc-bg-secondary">
        <div className="flex items-center gap-3">
          {/* Select all */}
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 text-xs text-mc-text-secondary hover:text-mc-text transition-colors"
          >
            {allSelected ? <CheckSquare className="w-4 h-4 text-mc-accent" /> : <Square className="w-4 h-4" />}
            {allSelected ? t('deselectAll') : t('selectAll')}
          </button>

          <span className="text-xs text-mc-text-secondary">
            {t('pendingActionsLine', {pending: ideas.length, actions: actionCount})}
          </span>
        </div>

        {/* Sort controls */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-mc-text-secondary">{t('sortLabel')}</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => handleSort(opt.value)}
              className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                sortField === opt.value
                  ? 'bg-mc-accent/20 text-mc-accent'
                  : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary'
              }`}
            >
              {t(opt.labelKey)}
              {sortField === opt.value && (
                <ArrowUpDown className="w-3 h-3" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar (appears when items selected) */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-mc-border bg-mc-accent/5">
          <span className="text-xs text-mc-text-secondary mr-2">
            {t('bulkSelected', {count: selectedIds.size})}
          </span>
          <button
            onClick={() => applyBulkAction('approve')}
            className="text-[11px] px-2 py-1 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
          >
            {t('approveAll')}
          </button>
          <button
            onClick={() => applyBulkAction('reject')}
            className="text-[11px] px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          >
            {t('rejectAll')}
          </button>
          <button
            onClick={() => applyBulkAction('maybe')}
            className="text-[11px] px-2 py-1 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
          >
            {t('maybeAll')}
          </button>
          <button
            onClick={() => applyBulkAction('fire')}
            className="text-[11px] px-2 py-1 rounded bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 transition-colors"
          >
            {t('fireAll')}
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Success */}
      {successCount != null && (
        <div className="mx-4 mt-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 text-sm text-emerald-400">
          {t('successProcessed', {count: successCount})}
        </div>
      )}

      {/* Ideas list */}
      <div className="flex-1 overflow-y-auto">
        {sortedIdeas.map(idea => (
          <BatchReviewRow
            key={idea.id}
            idea={idea}
            selected={selectedIds.has(idea.id)}
            action={actions[idea.id] || null}
            onToggleSelect={() => toggleSelect(idea.id)}
            onActionChange={(action) => setAction(idea.id, action)}
          />
        ))}
      </div>

      {/* Submit footer */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-mc-border bg-mc-bg-secondary">
        <div className="text-xs text-mc-text-secondary">
          {t('footerActionsAssigned', {actions: actionCount, total: ideas.length})}
        </div>
        <button
          onClick={handleSubmit}
          disabled={actionCount === 0 || submitting}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            actionCount > 0 && !submitting
              ? 'bg-mc-accent text-white hover:bg-mc-accent/90'
              : 'bg-mc-bg-tertiary text-mc-text-secondary cursor-not-allowed'
          }`}
        >
          {submitting ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {submitting ? t('submitting') : t('submitActions', {count: actionCount})}
        </button>
      </div>
    </div>
  );
}

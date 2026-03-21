'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Rocket, Play, Layers, Lightbulb, BarChart3, FileText, Zap, Loader } from 'lucide-react';
import { SwipeDeck } from '@/components/autopilot/SwipeDeck';
import { IdeasList } from '@/components/autopilot/IdeasList';
import { ResearchReport } from '@/components/autopilot/ResearchReport';
import { BuildQueue } from '@/components/autopilot/BuildQueue';
import { ProductProgramEditor } from '@/components/autopilot/ProductProgramEditor';
import { MaybePool } from '@/components/autopilot/MaybePool';
import { CostDashboard } from '@/components/costs/CostDashboard';
import { ActivityPanel } from '@/components/autopilot/ActivityPanel';
import type { Product } from '@/lib/types';

type Tab = 'swipe' | 'ideas' | 'research' | 'build' | 'costs' | 'program' | 'maybe';
type PipelineState = 'idle' | 'researching' | 'ideating' | 'done' | 'error';

export default function ProductDashboardPage() {
  const { productId } = useParams<{ productId: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [tab, setTab] = useState<Tab>('swipe');
  const [loading, setLoading] = useState(true);
  const [pipeline, setPipeline] = useState<PipelineState>('idle');
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/products/${productId}`);
        if (res.ok) setProduct(await res.json());
      } catch (error) {
        console.error('Failed to load product:', error);
      } finally {
        setLoading(false);
      }
    })();
  }, [productId]);

  const runNow = useCallback(async () => {
    if (pipeline !== 'idle') return;
    setPipeline('researching');
    setPipelineError(null);

    try {
      // Step 1: Research
      const researchRes = await fetch(`/api/products/${productId}/research/run`, { method: 'POST' });
      if (!researchRes.ok) {
        const err = await researchRes.json().catch(() => ({ error: 'Research failed' }));
        throw new Error(err.error || `Research failed (${researchRes.status})`);
      }
      const { cycle_id } = await researchRes.json();

      // Poll until research completes (check every 5s, max 10 min)
      const maxWait = 600000;
      const start = Date.now();
      let researchDone = false;
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 5000));
        const statusRes = await fetch(`/api/products/${productId}/research/cycles`);
        if (statusRes.ok) {
          const cycles = await statusRes.json();
          const cycle = cycles.find((c: { id: string }) => c.id === cycle_id);
          if (cycle?.status === 'completed') { researchDone = true; break; }
          if (cycle?.status === 'failed') throw new Error(cycle.error_message || 'Research cycle failed');
        }
      }
      if (!researchDone) throw new Error('Research timed out');

      // Step 2: Ideation
      setPipeline('ideating');
      const ideationRes = await fetch(`/api/products/${productId}/ideation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle_id }),
      });
      if (!ideationRes.ok) {
        const err = await ideationRes.json().catch(() => ({ error: 'Ideation failed' }));
        throw new Error(err.error || `Ideation failed (${ideationRes.status})`);
      }

      // Poll until ideation completes
      const { ideation_id } = await ideationRes.json();
      const ideaStart = Date.now();
      while (Date.now() - ideaStart < maxWait) {
        await new Promise(r => setTimeout(r, 5000));
        const statusRes = await fetch(`/api/products/${productId}/ideation/cycles`);
        if (statusRes.ok) {
          const cycles = await statusRes.json();
          const cycle = cycles.find((c: { id: string }) => c.id === ideation_id);
          if (cycle?.status === 'completed') { setPipeline('done'); return; }
          if (cycle?.status === 'failed') throw new Error(cycle.error_message || 'Ideation cycle failed');
        }
      }
      throw new Error('Ideation timed out');
    } catch (err) {
      setPipelineError((err as Error).message);
      setPipeline('error');
    }
  }, [productId, pipeline]);

  // Auto-reset "done" state after 3 seconds so button is clickable again
  useEffect(() => {
    if (pipeline === 'done') {
      const t = setTimeout(() => setPipeline('idle'), 3000);
      return () => clearTimeout(t);
    }
  }, [pipeline]);

  if (loading || !product) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-mc-text-secondary animate-pulse">Loading product...</div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'swipe', label: 'Swipe', icon: <Play className="w-4 h-4" /> },
    { id: 'ideas', label: 'Ideas', icon: <Lightbulb className="w-4 h-4" /> },
    { id: 'research', label: 'Research', icon: <Layers className="w-4 h-4" /> },
    { id: 'build', label: 'Build Queue', icon: <Layers className="w-4 h-4" /> },
    { id: 'maybe', label: 'Maybe', icon: <Layers className="w-4 h-4" /> },
    { id: 'costs', label: 'Costs', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'program', label: 'Program', icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-mc-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-mc-border bg-mc-bg-secondary px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/autopilot" className="text-mc-text-secondary hover:text-mc-text">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <span className="text-2xl">{product.icon}</span>
            <div>
              <h1 className="font-semibold text-mc-text">{product.name}</h1>
              <span className={`text-xs ${product.status === 'active' ? 'text-green-400' : 'text-mc-text-secondary'}`}>
                {product.status}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Run Now — fires research → ideation pipeline */}
            <button
              onClick={runNow}
              disabled={pipeline !== 'idle' && pipeline !== 'done' && pipeline !== 'error'}
              className={`min-h-11 px-4 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors ${
                pipeline === 'idle' || pipeline === 'done' || pipeline === 'error'
                  ? 'bg-amber-500 text-black hover:bg-amber-400'
                  : 'bg-amber-500/30 text-amber-300 cursor-wait'
              }`}
            >
              {(pipeline === 'idle' || pipeline === 'done' || pipeline === 'error') && (
                <>
                  <Zap className="w-4 h-4" />
                  Run Now
                </>
              )}
              {pipeline === 'researching' && (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Researching...
                </>
              )}
              {pipeline === 'ideating' && (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Generating ideas...
                </>
              )}
            </button>
            {pipelineError && (
              <span className="text-xs text-red-400 max-w-48 truncate" title={pipelineError}>
                {pipelineError}
              </span>
            )}
            <Link
              href={`/autopilot/${productId}/swipe`}
              className="min-h-11 px-4 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 flex items-center gap-2 text-sm font-medium"
            >
              <Rocket className="w-4 h-4" />
              Full Screen Swipe
            </Link>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-mc-border bg-mc-bg-secondary px-4 overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.id
                  ? 'border-mc-accent text-mc-accent'
                  : 'border-transparent text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content: two-column layout on desktop */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-4 overflow-auto">
          {tab === 'swipe' && <SwipeDeck productId={productId} />}
          {tab === 'ideas' && <IdeasList productId={productId} />}
          {tab === 'research' && <ResearchReport productId={productId} />}
          {tab === 'build' && <BuildQueue productId={productId} />}
          {tab === 'maybe' && <MaybePool productId={productId} />}
          {tab === 'costs' && <CostDashboard productId={productId} />}
          {tab === 'program' && <ProductProgramEditor product={product} onSave={setProduct} />}
        </div>

        {/* Activity panel — desktop: right side column, mobile: floating button + drawer */}
        <ActivityPanel productId={productId} />
      </div>
    </div>
  );
}

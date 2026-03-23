'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, Link } from '@/i18n/navigation';
import { ArrowLeft, ArrowRight, Check, Rocket, Search, Loader, AlertTriangle } from 'lucide-react';

type Step = 'basics' | 'program' | 'schedule' | 'done';

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function NewProductPage() {
  const t = useTranslations('autopilotNew');
  const router = useRouter();
  const [step, setStep] = useState<Step>('basics');
  const [saving, setSaving] = useState(false);
  const [scanningRepo, setScanningRepo] = useState(false);
  const [scanningSite, setScanningSite] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [repoWarning, setRepoWarning] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    repo_url: '',
    live_url: '',
    icon: '🚀',
    product_program: '',
    build_mode: 'plan_first' as 'plan_first' | 'auto_build',
    default_branch: 'main',
  });

  const handleScan = async (url: string, source: 'repo' | 'site') => {
    const setScanning = source === 'repo' ? setScanningRepo : setScanningSite;
    setScanning(true);
    setScanError(null);

    try {
      const res = await fetch('/api/products/scan-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '' }));
        setScanError(data.error || t('scanFailedStatus', { status: res.status }));
        return;
      }

      const { name, description } = await res.json();

      setForm(f => ({
        ...f,
        name: f.name || name || f.name,
        description: f.description || description || f.description,
      }));
    } catch (error) {
      setScanError(t('scanConnectFailed'));
      console.error('Scan failed:', error);
    } finally {
      setScanning(false);
    }
  };

  const validateRepoUrl = async (url: string) => {
    if (!url) { setRepoWarning(null); return; }
    // Try to extract owner/repo from GitHub URL
    const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) { setRepoWarning(null); return; }
    try {
      const res = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`, { method: 'GET' });
      if (!res.ok) {
        setRepoWarning(t('repoVerifyFailed'));
      } else {
        setRepoWarning(null);
      }
    } catch {
      setRepoWarning(t('repoVerifyFailed'));
    }
  };

  const handleCreate = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        const product = await res.json();
        setProductId(product.id);
        setStep('program');
      }
    } catch (error) {
      console.error('Failed to create product:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProgram = async () => {
    if (!productId) return;
    setSaving(true);
    try {
      await fetch(`/api/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_program: form.product_program }),
      });
      setStep('schedule');
    } catch (error) {
      console.error('Failed to save program:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-mc-bg">
      <header className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Link href="/autopilot" className="text-mc-text-secondary hover:text-mc-text">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <Rocket className="w-5 h-5 text-mc-accent-cyan" />
            <h1 className="text-lg font-bold text-mc-text">{t('title')}</h1>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          {(['basics', 'program', 'schedule'] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step === s ? 'bg-mc-accent text-white' :
                (['basics', 'program', 'schedule'].indexOf(step) > i) ? 'bg-green-500/20 text-green-400' :
                'bg-mc-bg-tertiary text-mc-text-secondary'
              }`}>
                {(['basics', 'program', 'schedule'].indexOf(step) > i) ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              {i < 2 && <div className="w-12 h-px bg-mc-border" />}
            </div>
          ))}
        </div>

        {step === 'basics' && (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldProductName')}</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text focus:outline-none focus:border-mc-accent"
                placeholder={t('placeholderProductName')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldDescription')}</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text focus:outline-none focus:border-mc-accent resize-none"
                rows={3}
                placeholder={t('placeholderDescription')}
              />
            </div>

            {scanError && (
              <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                {scanError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldRepoUrl')}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.repo_url}
                    onChange={e => setForm(f => ({ ...f, repo_url: e.target.value }))}
                    onBlur={() => { if (form.repo_url) validateRepoUrl(form.repo_url); }}
                    className="flex-1 bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                    placeholder={t('placeholderRepoUrl')}
                  />
                  <button
                    type="button"
                    onClick={() => handleScan(form.repo_url, 'repo')}
                    disabled={!isValidUrl(form.repo_url) || scanningRepo}
                    className="shrink-0 px-3 py-3 bg-mc-bg-tertiary border border-mc-border rounded-lg text-mc-text-secondary hover:text-mc-text hover:border-mc-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title={t('titleScanRepo')}
                  >
                    {scanningRepo ? <Loader className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  </button>
                </div>
                {repoWarning && (
                  <p className="text-[11px] text-amber-400 mt-1.5">{repoWarning}</p>
                )}
                <p className="text-[11px] text-mc-text-secondary mt-1.5">
                  {t('helperRepoScan')}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldLiveUrl')}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.live_url}
                    onChange={e => setForm(f => ({ ...f, live_url: e.target.value }))}
                    className="flex-1 bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                    placeholder={t('placeholderLiveUrl')}
                  />
                  <button
                    type="button"
                    onClick={() => handleScan(form.live_url, 'site')}
                    disabled={!isValidUrl(form.live_url) || scanningSite}
                    className="shrink-0 px-3 py-3 bg-mc-bg-tertiary border border-mc-border rounded-lg text-mc-text-secondary hover:text-mc-text hover:border-mc-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title={t('titleScanSite')}
                  >
                    {scanningSite ? <Loader className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-mc-text-secondary mt-1.5">
                  {t('helperSiteScan')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldBuildMode')}</label>
                <select
                  value={form.build_mode}
                  onChange={e => setForm(f => ({ ...f, build_mode: e.target.value as 'plan_first' | 'auto_build' }))}
                  className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                >
                  <option value="plan_first">{t('optionPlanFirst')}</option>
                  <option value="auto_build">{t('optionAutoBuild')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldDefaultBranch')}</label>
                <input
                  type="text"
                  value={form.default_branch}
                  onChange={e => setForm(f => ({ ...f, default_branch: e.target.value }))}
                  className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text text-sm focus:outline-none focus:border-mc-accent"
                  placeholder={t('placeholderBranch')}
                />
              </div>
            </div>

            {!form.repo_url && (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-300">
                  {t('noRepoWarning')}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleCreate}
              disabled={!form.name.trim() || saving}
              className="w-full min-h-11 bg-mc-accent text-white rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {saving ? t('btnCreating') : t('btnNextProgram')}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {step === 'program' && (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">{t('fieldProductProgram')}</label>
              <p className="text-sm text-mc-text-secondary mb-4">
                {t('programIntro')}
              </p>
              <textarea
                value={form.product_program}
                onChange={e => setForm(f => ({ ...f, product_program: e.target.value }))}
                className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text font-mono text-sm focus:outline-none focus:border-mc-accent resize-none"
                rows={20}
                placeholder={t('programPlaceholder', {
                  name: form.name.trim() || t('programPlaceholderFallbackName'),
                })}
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep('schedule')}
                className="flex-1 min-h-11 border border-mc-border text-mc-text-secondary rounded-lg hover:bg-mc-bg-tertiary"
              >
                {t('skipForNow')}
              </button>
              <button
                type="button"
                onClick={handleSaveProgram}
                disabled={saving}
                className="flex-1 min-h-11 bg-mc-accent text-white rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? t('saving') : t('nextSchedules')}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 'schedule' && (
          <div className="space-y-6">
            <div className="bg-mc-bg-secondary border border-mc-border rounded-xl p-6">
              <h3 className="font-semibold text-mc-text mb-4">{t('defaultSchedules')}</h3>
              <p className="text-sm text-mc-text-secondary mb-6">
                {t('schedulesIntro')}
              </p>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between py-2 border-b border-mc-border">
                  <span className="text-mc-text">{t('schedResearch')}</span>
                  <span className="text-mc-text-secondary font-mono">{t('schedResearchTime')}</span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-mc-border">
                  <span className="text-mc-text">{t('schedMaybe')}</span>
                  <span className="text-mc-text-secondary font-mono">{t('schedMaybeTime')}</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-mc-text">{t('schedPref')}</span>
                  <span className="text-mc-text-secondary font-mono">{t('schedPrefTime')}</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => router.push(`/autopilot/${productId}`)}
              className="w-full min-h-11 bg-mc-accent text-white rounded-lg font-medium hover:bg-mc-accent/90 flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" />
              {t('goDashboard')}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

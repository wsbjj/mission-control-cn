/**
 * 设置页 / Settings Page
 * 配置 Mission Control 路径、URL 与偏好 / Configure Mission Control paths, URLs, and preferences
 */

'use client';

import {useState, useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Settings, Save, RotateCcw, FolderOpen, Link as LinkIcon, Home} from 'lucide-react';
import {getConfig, updateConfig, resetConfig, type MissionControlConfig} from '@/lib/config';

export default function SettingsPage() {
  const t = useTranslations('settings');
  const router = useRouter(); // 路由实例，用于在设置页内跳转 / Router instance for navigation inside settings page
  const [config, setConfig] = useState<MissionControlConfig | null>(null); // 当前配置状态 / Current configuration state
  const [isSaving, setIsSaving] = useState(false); // 保存中状态 / Saving state
  const [saveSuccess, setSaveSuccess] = useState(false); // 保存成功提示状态 / Save success indicator
  const [error, setError] = useState<string | null>(null); // 错误信息状态 / Error message state

  useEffect(() => {
    setConfig(getConfig()); // 初始加载配置 / Load initial configuration
  }, []);

  const handleSave = async () => {
    if (!config) return; // 若配置尚未加载则直接返回 / Guard when config is not yet loaded

    setIsSaving(true); // 标记为保存中 / Mark as saving
    setError(null); // 清空错误 / Clear error
    setSaveSuccess(false); // 重置成功提示 / Reset success indicator

    try {
      updateConfig(config); // 写入配置到存储 / Persist configuration
      setSaveSuccess(true); // 标记保存成功 / Mark as saved successfully
      setTimeout(() => setSaveSuccess(false), 3000); // 一段时间后清除提示 / Clear success message after delay
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed')); // 显示错误信息 / Show error message
    } finally {
      setIsSaving(false); // 结束保存状态 / End saving state
    }
  };

  const handleReset = () => {
    // 重置为默认设置的确认提示 / Confirmation dialog for resetting to defaults
    if (confirm(t('resetConfirm'))) {
      resetConfig(); // 重置配置 / Reset configuration
      setConfig(getConfig()); // 重新加载默认配置 / Reload default configuration
      setSaveSuccess(true); // 提示重置成功 / Indicate reset success
      setTimeout(() => setSaveSuccess(false), 3000); // 一段时间后清除提示 / Clear success message after delay
    }
  };

  // 使用泛型以支持 string 与 boolean（如 Kanban 复选框）/ Generic to support string and boolean (e.g. Kanban checkbox)
  const handleChange = <K extends keyof MissionControlConfig>(field: K, value: MissionControlConfig[K]) => {
    if (!config) return;
    setConfig({...config, [field]: value});
  };

  if (!config) {
    // 加载中占位界面 / Loading placeholder view
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-mc-text-secondary">{t('loading')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg">
      {/* 头部区域：包含返回与保存操作 / Header area: back and save actions */}
      <div className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 hover:bg-mc-bg-tertiary rounded text-mc-text-secondary"
              title={t('backTitle')}
            >
              {t('back')}
            </button>
            <Settings className="w-6 h-6 text-mc-accent" />
            <h1 className="text-2xl font-bold text-mc-text">{t('title')}</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-mc-border rounded hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              {t('resetToDefaults')}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90 flex items-center gap-2 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {isSaving ? t('saving') : t('saveChanges')}
            </button>
          </div>
        </div>
      </div>

      {/* 主体内容：配置表单与说明 / Main content: configuration form and notes */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* 保存成功提示 / Success message */}
        {saveSuccess && (
          <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded text-green-400">
            {t('saveSuccess')}
          </div>
        )}

        {/* 错误提示 / Error message */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded text-red-400">
            ✗ {error}
          </div>
        )}

        {/* 工作区路径配置区块 / Workspace paths configuration section */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <FolderOpen className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">{t('workspacePaths')}</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            {t('workspacePathsDesc')}
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                {t('workspaceBasePath')}
              </label>
              <input
                type="text"
                value={config.workspaceBasePath}
                onChange={(e) => handleChange('workspaceBasePath', e.target.value)}
                placeholder={t('workspaceBasePathPlaceholder')}
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                {t('workspaceBasePathHelp')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                {t('projectsPath')}
              </label>
              <input
                type="text"
                value={config.projectsPath}
                onChange={(e) => handleChange('projectsPath', e.target.value)}
                placeholder={t('projectsPathPlaceholder')}
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                {t('projectsPathHelp')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                {t('defaultProjectName')}
              </label>
              <input
                type="text"
                value={config.defaultProjectName}
                onChange={(e) => handleChange('defaultProjectName', e.target.value)}
                placeholder={t('defaultProjectNamePlaceholder')}
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                {t('defaultProjectNameHelp')}
              </p>
            </div>
          </div>
        </section>

        {/* API 配置区块 / API configuration section */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <LinkIcon className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">{t('apiConfig')}</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            {t('apiConfigDesc')}
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                {t('missionControlUrl')}
              </label>
              <input
                type="text"
                value={config.missionControlUrl}
                onChange={(e) => handleChange('missionControlUrl', e.target.value)}
                placeholder={t('missionControlUrlPlaceholder')}
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                {t('missionControlUrlHelp')}
              </p>
            </div>
          </div>
        </section>

        {/* Kanban UX：main 新增，已做国际化 / Kanban UX from main, localized */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <Home className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">{t('kanbanUX')}</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            {t('kanbanUXDesc')}
          </p>

          <label className="flex items-start gap-3 p-3 bg-mc-bg border border-mc-border rounded cursor-pointer">
            <input
              type="checkbox"
              checked={config.kanbanCompactEmptyColumns}
              onChange={(e) => handleChange('kanbanCompactEmptyColumns', e.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--mc-accent)]"
            />
            <div>
              <div className="text-sm font-medium text-mc-text">{t('kanbanCompactEmptyColumns')}</div>
              <div className="text-xs text-mc-text-secondary mt-1">
                {t('kanbanCompactEmptyColumnsDesc')}
              </div>
            </div>
          </label>
        </section>

        {/* 环境变量说明区块 / Environment variables note section */}
        <section className="p-6 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <h3 className="text-lg font-semibold text-blue-400 mb-2">
            {t('envVarsTitle')}
          </h3>
          <p className="text-sm text-blue-300 mb-3">
            {t('envVarsIntro')} <code className="px-2 py-1 bg-mc-bg rounded">.env.local</code>{t('envVarsIntroSuffix')}
          </p>
          <ul className="text-sm text-blue-300 space-y-1 ml-4 list-disc">
            <li>{t('envVarMissionControlUrl')}</li>
            <li>{t('envVarWorkspaceBasePath')}</li>
            <li>{t('envVarProjectsPath')}</li>
            <li>{t('envVarGatewayUrl')}</li>
            <li>{t('envVarGatewayToken')}</li>
          </ul>
          <p className="text-xs text-blue-400 mt-3">
            {t('envVarsPrecedence')}
          </p>
        </section>
      </div>
    </div>
  );
}


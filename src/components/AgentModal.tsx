'use client';

import {useState, useEffect} from 'react';
import {X, Save, Trash2} from 'lucide-react';
import {useMissionControl} from '@/lib/store';
import type {Agent, AgentStatus} from '@/lib/types';
import {useTranslations} from 'next-intl'; // 智能体弹窗文案国际化 / i18n for agent modal copy

interface AgentModalProps {
  agent?: Agent;
  onClose: () => void;
  workspaceId?: string;
  onAgentCreated?: (agentId: string) => void;
}

const EMOJI_OPTIONS = ['🤖', '🦞', '💻', '🔍', '✍️', '🎨', '📊', '🧠', '⚡', '🚀', '🎯', '🔧'];

export function AgentModal({agent, onClose, workspaceId, onAgentCreated}: AgentModalProps) {
  const {addAgent, updateAgent, agents} = useMissionControl();
  const t = useTranslations('agentModal'); // 智能体弹窗命名空间 / Namespace for agent modal
  const [activeTab, setActiveTab] = useState<'info' | 'soul' | 'user' | 'agents'>('info');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [modelsLoading, setModelsLoading] = useState(true);

  const [form, setForm] = useState({
    name: agent?.name || '',
    role: agent?.role || '',
    description: agent?.description || '',
    avatar_emoji: agent?.avatar_emoji || '🤖',
    status: agent?.status || 'standby' as AgentStatus,
    is_master: agent?.is_master || false,
    soul_md: agent?.soul_md || '',
    user_md: agent?.user_md || '',
    agents_md: agent?.agents_md || '',
    model: agent?.model || '',
    session_key_prefix: agent?.session_key_prefix || '',
  });

  // Fetch fresh agent data when modal opens (store data may be stale) / 打开弹窗时拉取最新智能体数据（store 可能过期）
  useEffect(() => {
    if (!agent?.id) return;
    let cancelled = false;
    fetch(`/api/agents/${agent.id}`)
      .then(res => (res.ok ? res.json() : null))
      .then(fresh => {
        if (cancelled || !fresh) return;
        setForm(prev => ({
          ...prev,
          soul_md: fresh.soul_md || '',
          user_md: fresh.user_md || '',
          agents_md: fresh.agents_md || '',
        }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent?.id]);

  // Load available models from OpenClaw config / 加载可用模型列表
  useEffect(() => {
    const loadModels = async () => {
      try {
        const res = await fetch('/api/openclaw/models');
        if (res.ok) {
          const data = await res.json();
          setAvailableModels(data.availableModels || []);
          setDefaultModel(data.defaultModel || '');
          // If agent has no model set, use default
          if (!agent?.model && data.defaultModel) {
            setForm(prev => ({ ...prev, model: data.defaultModel }));
          }
        }
      } catch (error) {
        console.error('Failed to load models:', error);
      } finally {
        setModelsLoading(false);
      }
    };
    loadModels();
  }, [agent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const url = agent ? `/api/agents/${agent.id}` : '/api/agents';
      const method = agent ? 'PATCH' : 'POST';

      const trimmedPrefix = form.session_key_prefix?.trim();
      const normalizedPrefix = !trimmedPrefix ? '' : trimmedPrefix.endsWith(':') ? trimmedPrefix : trimmedPrefix + ':';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          session_key_prefix: normalizedPrefix || undefined,
          workspace_id: workspaceId || agent?.workspace_id || 'default',
        }),
      });

      if (res.ok) {
        const savedAgent = await res.json();
        if (agent) {
          updateAgent(savedAgent);
        } else {
          addAgent(savedAgent);
          // Notify parent if callback provided (e.g., for inline agent creation)
          if (onAgentCreated) {
            onAgentCreated(savedAgent.id);
          }
        }
        onClose();
      }
    } catch (error) {
      console.error('Failed to save agent:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!agent || !confirm(t('deleteConfirm', {name: agent.name}))) return; // 删除确认文案 / Delete confirm message

    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (res.ok) {
        // Remove from store
        useMissionControl.setState((state) => ({
          agents: state.agents.filter((a) => a.id !== agent.id),
          selectedAgent: state.selectedAgent?.id === agent.id ? null : state.selectedAgent,
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete agent:', error);
    }
  };

  const tabs = [
    {id: 'info', labelKey: 'tabInfo'},
    {id: 'soul', labelKey: 'tabSoul'},
    {id: 'user', labelKey: 'tabUser'},
    {id: 'agents', labelKey: 'tabAgents'},
  ] as const;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-lg w-full max-w-2xl max-h-[92vh] sm:max-h-[90vh] flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0">
        {/* Header / 标题栏 */}
        <div className="flex items-center justify-between p-4 border-b border-mc-border">
          <h2 className="text-lg font-semibold">
            {agent
              ? `${t('editTitlePrefix')} ${agent.name}` // 编辑智能体标题 / Edit agent title
              : t('createTitle') // 新建智能体标题 / Create new agent title
            }
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-mc-bg-tertiary rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs / 顶部标签页 */}
        <div className="flex border-b border-mc-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 min-h-11 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-mc-accent text-mc-accent'
                  : 'border-transparent text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {t(tab.labelKey) /* 标签名称 / Tab label */}
            </button>
          ))}
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4">
          {activeTab === 'info' && (
            <div className="space-y-4">
              {/* Avatar Selection / 头像选择 */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  {t('fieldAvatar') /* 头像标签 / Avatar label */}
                </label>
                <div className="flex flex-wrap gap-2">
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setForm({ ...form, avatar_emoji: emoji })}
                      className={`text-2xl p-2 rounded hover:bg-mc-bg-tertiary ${
                        form.avatar_emoji === emoji
                          ? 'bg-mc-accent/20 ring-2 ring-mc-accent'
                          : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name / 名称 */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('fieldName') /* 名称标签 / Name label */}
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({...form, name: e.target.value})}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  placeholder={t('fieldNamePlaceholder') /* 名称占位符 / Name placeholder */}
                />
              </div>

              {/* Role / 角色 */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('fieldRole') /* 角色标签 / Role label */}
                </label>
                <input
                  type="text"
                  value={form.role}
                  onChange={(e) => setForm({...form, role: e.target.value})}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  placeholder={t('fieldRolePlaceholder') /* 角色占位符 / Role placeholder */}
                />
              </div>

              {/* Description / 描述 */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('fieldDescription') /* 描述标签 / Description label */}
                </label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({...form, description: e.target.value})}
                  rows={2}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
                  placeholder={t('fieldDescriptionPlaceholder') /* 描述占位符 / Description placeholder */}
                />
              </div>

              {/* Status / 状态 */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('fieldStatus') /* 状态标签 / Status label */}
                </label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({...form, status: e.target.value as AgentStatus})}
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  <option value="standby">{t('statusStandby') /* 待命状态 / Standby */}</option>
                  <option value="working">{t('statusWorking') /* 工作中状态 / Working */}</option>
                  <option value="offline">{t('statusOffline') /* 离线状态 / Offline */}</option>
                </select>
              </div>

              {/* Master Toggle / 主控开关 */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_master"
                  checked={form.is_master}
                  onChange={(e) => setForm({...form, is_master: e.target.checked})}
                  className="w-4 h-4"
                />
                <label htmlFor="is_master" className="text-sm">
                  {t('fieldIsMaster') /* 主控说明 / Master orchestrator label */}
                </label>
              </div>

              {/* Model Selection / 模型选择 */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('fieldModel') /* 模型标签 / Model label */}
                  {defaultModel && form.model === defaultModel && (
                    <span className="ml-2 text-xs text-mc-text-secondary">
                      {t('modelDefaultTag') /* 默认标签 / Default tag */}
                    </span>
                  )}
                </label>
                {modelsLoading ? (
                  <div className="text-sm text-mc-text-secondary">
                    {t('modelLoading') /* 加载模型提示 / Loading models message */}
                  </div>
                ) : (
                  <select
                    value={form.model}
                    onChange={(e) => setForm({...form, model: e.target.value})}
                    className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  >
                    <option value="">
                      {t('modelUseDefault') /* 使用默认模型选项 / Use default model option */}
                    </option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                        {defaultModel === model ? ` ${t('modelDefaultTag')}` : ''}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-mc-text-secondary mt-1">
                  {t('modelHelp') /* 模型说明 / Model help text */}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">{t('sessionKeyLabel')}</label>
                <input
                  type="text"
                  value={form.session_key_prefix}
                  onChange={(e) => setForm({...form, session_key_prefix: e.target.value})}
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  placeholder={t('sessionKeyPlaceholder')}
                />
                <p className="text-xs text-mc-text-secondary mt-1">{t('sessionKeyHelp')}</p>
              </div>
            </div>
          )}

          {activeTab === 'soul' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                {t('fieldSoulLabel') /* SOUL.md 标签 / SOUL.md label */}
              </label>
              <textarea
                value={form.soul_md}
                onChange={(e) => setForm({...form, soul_md: e.target.value})}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-mc-accent resize-none"
                placeholder={t('fieldSoulPlaceholder') /* SOUL.md 占位符 / SOUL.md placeholder */}
              />
            </div>
          )}

          {activeTab === 'user' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                {t('fieldUserLabel') /* USER.md 标签 / USER.md label */}
              </label>
              <textarea
                value={form.user_md}
                onChange={(e) => setForm({...form, user_md: e.target.value})}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-mc-accent resize-none"
                placeholder={t('fieldUserPlaceholder') /* USER.md 占位符 / USER.md placeholder */}
              />
            </div>
          )}

          {activeTab === 'agents' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                {t('fieldAgentsLabel') /* AGENTS.md 标签 / AGENTS.md label */}
              </label>
              <textarea
                value={form.agents_md}
                onChange={(e) => setForm({...form, agents_md: e.target.value})}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-mc-accent resize-none"
                placeholder={t('fieldAgentsPlaceholder') /* AGENTS.md 占位符 / AGENTS.md placeholder */}
              />
            </div>
          )}
        </form>

        {/* Footer / 底部操作栏 */}
        <div className="flex items-center justify-between p-4 border-t border-mc-border">
          <div>
            {agent && (
              <button
                type="button"
                onClick={handleDelete}
                className="min-h-11 flex items-center gap-2 px-3 py-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded text-sm"
              >
                <Trash2 className="w-4 h-4" />
                {t('deleteButton') /* 删除按钮文案 / Delete button label */}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text"
            >
              {t('cancel') /* 取消按钮 / Cancel button */}
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="min-h-11 flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {isSubmitting ? t('saveSubmitting') : t('saveIdle') /* 保存按钮 / Save button */}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

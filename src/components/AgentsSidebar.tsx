'use client';

import {useState, useEffect, useCallback} from 'react';
import {Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2, Search} from 'lucide-react';
import {useMissionControl} from '@/lib/store';
import type {Agent, AgentStatus, AgentHealthState, OpenClawSession} from '@/lib/types';
import {AgentModal} from './AgentModal';
import {DiscoverAgentsModal} from './DiscoverAgentsModal';
import {HealthIndicator} from './HealthIndicator';
import {useTranslations} from 'next-intl'; // 智能体侧边栏文案国际化 / i18n for agents sidebar copy

type FilterTab = 'all' | 'working' | 'standby';

interface AgentsSidebarProps {
  workspaceId?: string;
  mobileMode?: boolean;
  isPortrait?: boolean;
}

export function AgentsSidebar({workspaceId, mobileMode = false, isPortrait = true}: AgentsSidebarProps) {
  const {agents, selectedAgent, setSelectedAgent, agentOpenClawSessions, setAgentOpenClawSession} = useMissionControl();
  const t = useTranslations('agents'); // 智能体命名空间 / Namespace for agents
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [agentHealth, setAgentHealth] = useState<Record<string, AgentHealthState>>({});
  const [isMinimized, setIsMinimized] = useState(false);

  const effectiveMinimized = mobileMode ? false : isMinimized;
  const toggleMinimize = () => setIsMinimized(!isMinimized);

  const loadOpenClawSessions = useCallback(async () => {
    for (const agent of agents) {
      try {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`);
        if (res.ok) {
          const data = await res.json();
          if (data.linked && data.session) {
            setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
          }
        }
      } catch (error) {
        console.error(`Failed to load OpenClaw session for ${agent.name}:`, error);
      }
    }
  }, [agents, setAgentOpenClawSession]);

  useEffect(() => {
    if (agents.length > 0) {
      loadOpenClawSessions();
    }
  }, [loadOpenClawSessions, agents.length]);

  useEffect(() => {
    const loadSubAgentCount = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch (error) {
        console.error('Failed to load sub-agent count:', error);
      }
    };

    loadSubAgentCount();
    const interval = setInterval(loadSubAgentCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Poll agent health
  useEffect(() => {
    const loadHealth = async () => {
      try {
        const res = await fetch('/api/agents/health');
        if (res.ok) {
          const data = await res.json();
          const healthMap: Record<string, AgentHealthState> = {};
          for (const h of data) {
            healthMap[h.agent_id] = h.health_state;
          }
          setAgentHealth(healthMap);
        }
      } catch {}
    };

    loadHealth();
    const interval = setInterval(loadHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleConnectToOpenClaw = async (agent: Agent, e: React.MouseEvent) => {
    e.stopPropagation();
    setConnectingAgentId(agent.id);

    try {
      const existingSession = agentOpenClawSessions[agent.id];

      if (existingSession) {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'DELETE' });
        if (res.ok) {
          setAgentOpenClawSession(agent.id, null);
        }
      } else {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
        } else {
          const error = await res.json();
          console.error('Failed to connect to OpenClaw:', error);
          alert(`Failed to connect: ${error.error || 'Unknown error'}`);
        }
      }
    } catch (error) {
      console.error('OpenClaw connection error:', error);
    } finally {
      setConnectingAgentId(null);
    }
  };

  const filteredAgents = agents.filter((agent) => {
    if (filter === 'all') return true;
    return agent.status === filter;
  });

  const getStatusBadge = (status: AgentStatus) => {
    const styles = {
      standby: 'status-standby',
      working: 'status-working',
      offline: 'status-offline',
    };
    return styles[status] || styles.standby;
  };

  return (
    <aside
      className={`bg-mc-bg-secondary ${mobileMode ? 'border border-mc-border rounded-lg h-full' : 'border-r border-mc-border'} flex flex-col transition-all duration-300 ease-in-out ${
        effectiveMinimized ? 'w-12' : mobileMode ? 'w-full' : 'w-64'
      }`}
    >
      <div className="p-3 border-b border-mc-border">
        <div className="flex items-center">
          {!mobileMode && (
            <button
              onClick={toggleMinimize}
              className="p-1 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text transition-colors"
              aria-label={effectiveMinimized ? t('expand') : t('minimize') /* 展开/收起无障碍标签 / ARIA labels for expand/minimize */}
            >
              {effectiveMinimized ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          )}
          {!effectiveMinimized && (
            <>
              <span className="text-sm font-medium uppercase tracking-wider">
                {t('title') /* 智能体标题 / Agents title */}
              </span>
              <span className="bg-mc-bg-tertiary text-mc-text-secondary text-xs px-2 py-0.5 rounded ml-2">{agents.length}</span>
            </>
          )}
        </div>

        {!effectiveMinimized && (
          <>
            {activeSubAgents > 0 && (
              <div className="mb-3 mt-3 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-green-400">●</span>
                  <span className="text-mc-text">
                    {t('activeSubAgentsLabel') /* 活跃子智能体标签 / Active sub-agents label */}
                  </span>
                  <span className="font-bold text-green-400">{activeSubAgents}</span>
                </div>
              </div>
            )}

            <div className={`mt-3 ${mobileMode && isPortrait ? 'grid grid-cols-3 gap-2' : 'flex gap-1'}`}>
              {(['all', 'working', 'standby'] as FilterTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={`min-h-11 text-xs rounded uppercase ${mobileMode && isPortrait ? 'px-1' : 'px-3'} ${
                    filter === tab ? 'bg-mc-accent text-mc-bg font-medium' : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
                  }`}
                >
                  {tab === 'all'
                    ? t('filterAll') // 全部过滤标签 / "All" filter label
                    : tab === 'working'
                    ? t('filterWorking') // 工作中过滤标签 / "Working" filter label
                    : t('filterStandby') // 待命过滤标签 / "Standby" filter label
                  }
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredAgents.map((agent) => {
          const openclawSession = agentOpenClawSessions[agent.id];

          if (effectiveMinimized) {
            return (
              <div key={agent.id} className="flex justify-center py-3">
                <button
                  onClick={() => {
                    setSelectedAgent(agent);
                    setEditingAgent(agent);
                  }}
                  className="relative group"
                  title={`${agent.name} - ${agent.role}`}
                >
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  {openclawSession && <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-mc-bg-secondary" />}
                  {!!agent.is_master && <span className="absolute -top-1 -right-1 text-xs text-mc-accent-yellow">★</span>}
                  <span
                    className={`absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${
                      agent.status === 'working' ? 'bg-mc-accent-green' : agent.status === 'standby' ? 'bg-mc-text-secondary' : 'bg-gray-500'
                    }`}
                  />
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-mc-bg text-mc-text text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 border border-mc-border">
                    {agent.name}
                  </div>
                </button>
              </div>
            );
          }

          const isConnecting = connectingAgentId === agent.id;
          return (
            <div key={agent.id} className={`w-full rounded hover:bg-mc-bg-tertiary transition-colors ${selectedAgent?.id === agent.id ? 'bg-mc-bg-tertiary' : ''}`}>
              <button
                onClick={() => {
                  setSelectedAgent(agent);
                  setEditingAgent(agent);
                }}
                className="w-full flex items-center gap-3 p-3 text-left min-h-11"
              >
                <div className="text-2xl relative">
                  {agent.avatar_emoji}
                  {openclawSession && <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-mc-bg-secondary" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{agent.name}</span>
                    {!!agent.is_master && <span className="text-xs text-mc-accent-yellow">★</span>}
                  </div>
                  <div className="text-xs text-mc-text-secondary truncate flex items-center gap-1">
                    {agent.role}
                    {agent.source === 'gateway' && (
                      <span
                        className="text-[10px] px-1 py-0 bg-blue-500/20 text-blue-400 rounded"
                        title={t('importedFromGateway') /* 从 Gateway 导入提示 / Imported from Gateway tooltip */}
                      >
                        {t('gatewayShort') /* Gateway 简写 / Gateway short label */}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {agentHealth[agent.id] && agentHealth[agent.id] !== 'idle' && (
                    <HealthIndicator state={agentHealth[agent.id]} size="sm" />
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded uppercase ${getStatusBadge(agent.status)}`}>
                    {agent.status === 'working' ? t('statusWorking') : agent.status === 'offline' ? t('statusOffline') : t('statusStandby')}
                  </span>
                </div>
              </button>

              {!!agent.is_master && (
                <div className="px-2 pb-2">
                  <button
                    onClick={(e) => handleConnectToOpenClaw(agent, e)}
                    disabled={isConnecting}
                    className={`w-full min-h-11 flex items-center justify-center gap-2 px-2 rounded text-xs transition-colors ${
                      openclawSession
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-mc-bg text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text'
                    }`}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>{t('connectButtonConnecting') /* 连接中按钮文案 / Connecting label */}</span>
                      </>
                    ) : openclawSession ? (
                      <>
                        <Zap className="w-3 h-3" />
                        <span>{t('connectButtonConnected') /* 已连接按钮文案 / Connected label */}</span>
                      </>
                    ) : (
                      <>
                        <ZapOff className="w-3 h-3" />
                        <span>{t('connectButtonConnect') /* 连接按钮文案 / Connect label */}</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!effectiveMinimized && (
        <div className="p-3 border-t border-mc-border space-y-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-full min-h-11 flex items-center justify-center gap-2 px-3 bg-mc-bg-tertiary hover:bg-mc-border rounded text-sm text-mc-text-secondary hover:text-mc-text transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('addAgent') /* 添加智能体按钮 / Add agent button */}
          </button>
          <button
            onClick={() => setShowDiscoverModal(true)}
            className="w-full min-h-11 flex items-center justify-center gap-2 px-3 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Search className="w-4 h-4" />
            {t('importFromGateway') /* 从 Gateway 导入按钮 / Import from Gateway button */}
          </button>
        </div>
      )}

      {showCreateModal && <AgentModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />}
      {editingAgent && <AgentModal agent={editingAgent} onClose={() => setEditingAgent(null)} workspaceId={workspaceId} />}
      {showDiscoverModal && <DiscoverAgentsModal onClose={() => setShowDiscoverModal(false)} workspaceId={workspaceId} />}
    </aside>
  );
}

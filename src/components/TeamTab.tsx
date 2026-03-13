'use client';

import { useState, useEffect } from 'react';
import { Users, Save, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMissionControl } from '@/lib/store';
import type { WorkflowTemplate, WorkflowStage } from '@/lib/types';

interface TeamTabProps {
  taskId: string;
  workspaceId: string;
}

interface RoleAssignment {
  role: string;
  agent_id: string;
  agent_name?: string;
  agent_emoji?: string;
}

const normalizeRole = (value: string) => value.trim().toLowerCase();

export function TeamTab({ taskId, workspaceId }: TeamTabProps) {
  const t = useTranslations('taskModal');
  const { agents } = useMissionControl();
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load existing roles and workflows
  useEffect(() => {
    const load = async () => {
      try {
        const [rolesRes, workflowsRes, taskRes] = await Promise.all([
          fetch(`/api/tasks/${taskId}/roles`),
          fetch(`/api/workspaces/${workspaceId}/workflows`),
          fetch(`/api/tasks/${taskId}`),
        ]);

        if (rolesRes.ok) {
          const data = await rolesRes.json();
          setRoles(data.map((r: RoleAssignment & { agent_name: string; agent_emoji: string }) => ({
            role: normalizeRole(r.role),
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            agent_emoji: r.agent_emoji,
          })));
        }

        if (workflowsRes.ok) {
          const data = await workflowsRes.json();
          setWorkflows(data);
        }

        if (taskRes.ok) {
          const task = await taskRes.json();
          setSelectedWorkflow(task.workflow_template_id || '');
        }
      } catch (err) {
        console.error('Failed to load team data:', err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [taskId, workspaceId]);

  const currentWorkflow = workflows.find(w => w.id === selectedWorkflow);
  const requiredRoles = currentWorkflow
    ? currentWorkflow.stages
        .filter((s: WorkflowStage) => s.role)
        .map((s: WorkflowStage) => normalizeRole(s.role as string))
    : [];

  // Unique roles (remove duplicates + normalize case)
  const uniqueRoles = Array.from(new Set(requiredRoles));

  const handleWorkflowChange = async (templateId: string) => {
    setSelectedWorkflow(templateId);
    setError(null);

    // Update task's workflow_template_id
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_template_id: templateId || null }),
      });
    } catch {
      // Best-effort
    }

    // If a workflow is selected, ensure role slots exist for its stages
    const wf = workflows.find(w => w.id === templateId);
    if (wf) {
      const wfRoles = Array.from(new Set(
        wf.stages
          .filter((s: WorkflowStage) => s.role)
          .map((s: WorkflowStage) => normalizeRole(s.role as string))
      ));
      const existingRoleNames = roles.map(r => normalizeRole(r.role));
      const newRoles = [...roles];

      for (const role of wfRoles) {
        if (!existingRoleNames.includes(role)) {
          newRoles.push({ role, agent_id: '' });
        }
      }
      setRoles(newRoles);
    }
  };

  const handleRoleAgentChange = (role: string, agentId: string) => {
    const normalizedRole = normalizeRole(role);
    setRoles(prev => {
      const existing = prev.find(r => normalizeRole(r.role) === normalizedRole);
      if (existing) {
        return prev.map(r => normalizeRole(r.role) === normalizedRole ? { ...r, role: normalizedRole, agent_id: agentId } : r);
      }
      return [...prev, { role: normalizedRole, agent_id: agentId }];
    });
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const validRoles = roles.filter(r => r.role && r.agent_id);
      const res = await fetch(`/api/tasks/${taskId}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: validRoles }),
      });

      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to save roles');
      }
    } catch (err) {
      setError('Failed to save roles');
    } finally {
      setSaving(false);
    }
  };

  const addCustomRole = () => {
    if (addableRoles.length === 0) return;
    setRoles(prev => [...prev, { role: addableRoles[0], agent_id: '' }]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-5 h-5 text-mc-text-secondary animate-spin" />
      </div>
    );
  }

  const missingRoles = uniqueRoles.filter(role =>
    !roles.find(r => normalizeRole(r.role) === role && r.agent_id)
  );

  const stageLabelKey: Record<string, string> = {
    Build: 'stageBuild',
    Test: 'stageTest',
    Review: 'stageReview',
    Verify: 'stageVerify',
    Done: 'stageDone',
  };
  const roleKey: Record<string, string> = {
    builder: 'roleBuilder',
    tester: 'roleTester',
    reviewer: 'roleReviewer',
    learner: 'roleLearner',
    verifier: 'roleVerifier',
  };
  const workflowNameKey: Record<string, string> = {
    Strict: 'workflowNameStrict',
    Simple: 'workflowNameSimple',
    Standard: 'workflowNameStandard',
  };

  const translateStageLabel = (label: string) =>
    stageLabelKey[label] ? t(stageLabelKey[label] as any) : label;
  const translateStageRole = (role: string | null) =>
    role && roleKey[role] ? t(roleKey[role] as any) : role || '';
  const translateRoleName = (role: string) =>
    roleKey[role.toLowerCase?.()] ? t(roleKey[role.toLowerCase()] as any) : role;
  const translateWorkflowName = (name: string) =>
    workflowNameKey[name] ? t(workflowNameKey[name] as any) : name;
  const translateWorkflowDescription = (desc: string) => {
    let out = desc
      .replace(/\s*[—–-]\s*for critical projects\s*$/i, ' — ' + t('workflowForCritical'))
      .replace(/\s*[—–-]\s*for quick, straightforward tasks\s*$/i, ' — ' + t('workflowForQuick'))
      .replace(/\s*[—–-]\s*for most projects\s*$/i, ' — ' + t('workflowForMost'))
      .replace(/\bBuilder only\b/gi, t('workflowBuilderOnly'));
    out = out
      .replace(/\bBuilder\b/g, t('roleBuilder'))
      .replace(/\bTester\b/g, t('roleTester'))
      .replace(/\bReviewer\b/g, t('roleReviewer'))
      .replace(/\bLearner\b/g, t('roleLearner'))
      .replace(/\bVerifier\b/g, t('roleVerifier'));
    return out;
  };

  const roleCatalog = Array.from(
    new Set(
      agents
        .map(agent => normalizeRole(agent.role || ''))
        .filter(Boolean)
    )
  ).sort();

  const assignedRoleNames = Array.from(
    new Set(roles.map(r => normalizeRole(r.role)).filter(Boolean))
  );

  const addableRoles = roleCatalog.filter(role => !assignedRoleNames.includes(role));

  return (
    <div className="space-y-6">
      {/* Workflow Template Selector */}
      <div>
        <label className="block text-sm font-medium mb-2">{t('teamWorkflowTemplate')}</label>
        <select
          value={selectedWorkflow}
          onChange={(e) => handleWorkflowChange(e.target.value)}
          className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
        >
          <option value="">{t('teamNoWorkflow')}</option>
          {workflows.map(wf => (
            <option key={wf.id} value={wf.id}>
              {translateWorkflowName(wf.name)}{wf.is_default ? t('teamDefault') : ''} — {translateWorkflowDescription(wf.description || '')}
            </option>
          ))}
        </select>
      </div>

      {/* Workflow Stages Visualization */}
      {currentWorkflow && (
        <div>
          <label className="block text-sm font-medium mb-2">{t('teamStages')}</label>
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {currentWorkflow.stages.map((stage: WorkflowStage, i: number) => (
              <div key={stage.id} className="flex items-center gap-1 flex-shrink-0">
                <div className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                  stage.role
                    ? 'bg-mc-accent/10 border border-mc-accent/30 text-mc-accent'
                    : 'bg-mc-bg-tertiary border border-mc-border text-mc-text-secondary'
                }`}>
                  {translateStageLabel(stage.label)}
                  {stage.role && <span className="ml-1 opacity-60">({translateStageRole(stage.role)})</span>}
                </div>
                {i < currentWorkflow.stages.length - 1 && (
                  <span className="text-mc-text-secondary/40 text-xs">→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Missing Roles Warning */}
      {missingRoles.length > 0 && (
        <div className="p-3 bg-orange-500/10 border border-orange-500/30 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-orange-300 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-orange-200">
                {t('teamMissingAgentsPrefix')} {missingRoles.map(r => translateRoleName(r)).join(', ')}
              </p>
              <p className="text-xs text-orange-300/70 mt-1">
                {t('teamAssignBelow')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Role Assignments */}
      <div>
        <label className="block text-sm font-medium mb-2">{t('teamRoleAssignments')}</label>
        <div className="space-y-3">
          {(uniqueRoles.length > 0 ? uniqueRoles : roles.map(r => r.role).filter(Boolean)).map(role => {
            if (!role) return null;
            const assignment = roles.find(r => normalizeRole(r.role) === normalizeRole(role));
            return (
              <div key={role} className="flex items-center gap-3">
                <div className="w-24 text-xs font-medium text-mc-text-secondary flex-shrink-0">
                  {translateRoleName(role)}
                </div>
                <select
                  value={assignment?.agent_id || ''}
                  onChange={(e) => handleRoleAgentChange(role, e.target.value)}
                  className="flex-1 min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  <option value="">{t('teamUnassigned')}</option>
                  {agents.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.avatar_emoji} {agent.name} — {translateRoleName(agent.role || '')}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}

          {/* Custom role slots (not from workflow) - role names are catalog-driven (not editable text) */}
          {roles.filter(r => !uniqueRoles.includes(normalizeRole(r.role)) && r.role).map((r, i) => (
              <div key={`custom-${i}`} className="flex items-center gap-3">
              <div className="w-24 text-xs font-medium text-mc-text-secondary capitalize flex-shrink-0">
                {translateRoleName(normalizeRole(r.role))}
              </div>
              <select
                value={r.agent_id}
                onChange={(e) => handleRoleAgentChange(r.role, e.target.value)}
                className="flex-1 min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              >
                <option value="">{t('teamUnassigned')}</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.avatar_emoji} {agent.name} — {translateRoleName(agent.role || '')}
                  </option>
                ))}
              </select>
            </div>
          ))}

          <button
            onClick={addCustomRole}
            disabled={addableRoles.length === 0}
            className="text-xs text-mc-accent hover:text-mc-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
            title={addableRoles.length === 0 ? 'No additional role types available to add' : 'Add custom role from agent catalog'}
          >
            {t('teamAddCustomRole')}
          </button>
        </div>
      </div>

      {/* Error / Success */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {saved && (
        <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <p className="text-sm text-green-400">{t('teamSavedSuccess')}</p>
        </div>
      )}

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full min-h-11 flex items-center justify-center gap-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
      >
        <Save className="w-4 h-4" />
        {saving ? t('teamSaving') : t('teamSaveTeam')}
      </button>
    </div>
  );
}

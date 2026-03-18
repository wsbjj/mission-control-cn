'use client';

import { useState, useEffect } from 'react';
import { Users, Save, AlertCircle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMissionControl } from '@/lib/store';
import type { WorkflowTemplate, WorkflowStage, TaskStatus } from '@/lib/types';

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

// Canonicalize role names (especially Chinese) to stable slugs.
// This keeps templates consistent with UI translations + workflow routing.
const normalizeRoleCanonical = (value: string) => {
  const raw = value.trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const aliasMap: Record<string, string> = {
    // builder
    '构建': 'builder',
    '构建者': 'builder',
    '开发': 'builder',
    '开发者': 'builder',
    // tester
    '测试': 'tester',
    '测试者': 'tester',
    'qa': 'tester',
    // reviewer
    '审核': 'reviewer',
    '审核者': 'reviewer',
    '审查': 'reviewer',
    '审查者': 'reviewer',
    'review': 'reviewer',
    // verifier
    '验证': 'verifier',
    '验证者': 'verifier',
    'verify': 'verifier',
    // learner
    '学习': 'learner',
    '学习者': 'learner',
    'learner': 'learner',
  };
  return aliasMap[raw] || aliasMap[lower] || normalizeRole(raw);
};

const createClientId = (): string => {
  // Prefer the standard Web Crypto API when available
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (c && typeof (c as any).randomUUID === 'function') {
    return (c as any).randomUUID();
  }
  // RFC4122 v4 fallback using getRandomValues
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Non-crypto fallback (not for security use; just stable keys)
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

export function TeamTab({ taskId, workspaceId }: TeamTabProps) {
  const t = useTranslations('taskModal');
  const { agents } = useMissionControl();
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');
  const [previousWorkflow, setPreviousWorkflow] = useState<string>('');
  const [showCustomTemplateModal, setShowCustomTemplateModal] = useState(false);
  const [customTemplateName, setCustomTemplateName] = useState('');
  const [customTemplateDescription, setCustomTemplateDescription] = useState('');
  const [customStages, setCustomStages] = useState<WorkflowStage[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isCustomWorkflow = selectedWorkflow === '__custom__';

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
            role: normalizeRoleCanonical(r.role),
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            agent_emoji: r.agent_emoji,
          })));
        }

        if (workflowsRes.ok) {
          const data: WorkflowTemplate[] = await workflowsRes.json();
          // 去重：同名且阶段配置完全相同的模板只保留一份，避免在下拉中重复显示
          // Deduplicate: keep only one template per unique (name + stages + description) key
          const seen = new Set<string>();
          const deduped: WorkflowTemplate[] = [];
          for (const wf of data) {
            const key = JSON.stringify({
              name: wf.name,
              description: wf.description || '',
              stages: wf.stages,
            });
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(wf);
          }
          setWorkflows(deduped);
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

  const currentWorkflow = isCustomWorkflow ? null : workflows.find(w => w.id === selectedWorkflow);
  const stagesForUI = isCustomWorkflow ? customStages : (currentWorkflow?.stages || []);

  const ensureRoleSlotsForStageRoles = (stageRoles: Array<string>) => {
    const normalized = stageRoles.map(normalizeRoleCanonical).filter(Boolean);
    const unique = Array.from(new Set(normalized));
    if (unique.length === 0) return;
    setRoles(prev => {
      const existing = new Set(prev.map(r => normalizeRoleCanonical(r.role)));
      const next = [...prev];
      for (const role of unique) {
        if (!existing.has(role)) next.push({ role, agent_id: '' });
      }
      return next;
    });
  };

  const requiredRoles = (isCustomWorkflow ? customStages : (currentWorkflow?.stages || []))
    .filter((s: WorkflowStage) => s.role)
    .map((s: WorkflowStage) => normalizeRoleCanonical(s.role as string));

  // Unique roles (remove duplicates + normalize case) for workflow templates
  const uniqueRoles = Array.from(new Set(requiredRoles));

  const handleWorkflowChange = async (templateId: string) => {
    setPreviousWorkflow(selectedWorkflow);
    setSelectedWorkflow(templateId);
    setError(null);
    setTemplateSaved(false);

    // Enter custom template editor (do not patch the task until user saves)
    if (templateId === '__custom__') {
      const base = currentWorkflow || workflows.find(w => w.is_default) || workflows[0] || null;
      const suffix = t('teamCustomCopySuffix');
      const baseNameRaw = base ? translateWorkflowName(base.name) : t('teamCustomTemplateDefaultName');
      const baseName = baseNameRaw.endsWith(` ${suffix}`)
        ? baseNameRaw.slice(0, -(` ${suffix}`).length)
        : baseNameRaw.endsWith(suffix)
          ? baseNameRaw.slice(0, -(suffix.length))
          : baseNameRaw;
      setCustomTemplateName(`${baseName} ${suffix}`.trim());
      setCustomTemplateDescription(base?.description ? translateWorkflowDescription(base.description) : '');
      setCustomStages(
        base?.stages?.length
          ? base.stages.map(s => ({ ...s, id: createClientId() }))
          : ([
              { id: createClientId(), label: 'Build', role: 'builder', status: 'in_progress' as TaskStatus },
              { id: createClientId(), label: 'Done', role: null, status: 'done' as TaskStatus },
            ] satisfies WorkflowStage[])
      );
      // Ensure role slots exist for the custom stages immediately
      const baseRoles = (base?.stages || [])
        .filter(s => s.role)
        .map(s => normalizeRoleCanonical(s.role as string));
      ensureRoleSlotsForStageRoles(baseRoles);
      setShowCustomTemplateModal(true);
      return;
    }

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
          .map((s: WorkflowStage) => normalizeRoleCanonical(s.role as string))
      ));
      ensureRoleSlotsForStageRoles(wfRoles);

      // Keep role assignments strictly aligned with the selected workflow:
      // - remove any roles not required by this workflow
      // - preserve existing agent assignments for matching roles
      setRoles(prev => prev.filter(r => wfRoles.includes(normalizeRoleCanonical(r.role))));
    }
  };

  // When editing a custom workflow, keep role slots in sync with stage roles
  // NOTE: We intentionally DO NOT sync role slots on every keystroke while editing
  // custom stage roles. Doing so would create partial roles like "b", "bu", "bui"...
  // Sync happens on blur (commit) and on template save instead.

  const handleRoleAgentChange = (role: string, agentId: string) => {
    const normalizedRole = normalizeRoleCanonical(role);
    setRoles(prev => {
      const existing = prev.find(r => normalizeRoleCanonical(r.role) === normalizedRole);
      if (existing) {
        return prev.map(r => normalizeRoleCanonical(r.role) === normalizedRole ? { ...r, role: normalizedRole, agent_id: agentId } : r);
      }
      return [...prev, { role: normalizedRole, agent_id: agentId }];
    });
    setSaved(false);
  };

  const taskStatuses: TaskStatus[] = [
    'inbox',
    'assigned',
    'in_progress',
    'testing',
    'review',
    'verification',
    'done',
  ];

  const translateStatus = (status: TaskStatus) => {
    const map: Record<TaskStatus, string> = {
      inbox: t('teamStatusInbox'),
      assigned: t('teamStatusAssigned'),
      in_progress: t('teamStatusInProgress'),
      testing: t('teamStatusTesting'),
      review: t('teamStatusReview'),
      verification: t('teamStatusVerification'),
      done: t('teamStatusDone'),
      planning: 'planning',
      pending_dispatch: 'pending_dispatch',
    };
    return map[status] || status;
  };

  const saveCustomTemplate = async () => {
    if (!isCustomWorkflow) return;
    setSavingTemplate(true);
    setError(null);
    setTemplateSaved(false);

    const name = customTemplateName.trim();
    // Validate: any stage in "has role" mode must have a non-empty role string
    const hasEmptyRole = customStages.some(s => s.role !== null && normalizeRoleCanonical(String(s.role)) === '');
    if (hasEmptyRole) {
      setError(t('teamTemplateRoleRequired'));
      setSavingTemplate(false);
      return;
    }

    const hasNonCanonicalRole = customStages.some(s => {
      if (s.role === null) return false;
      const r = normalizeRoleCanonical(String(s.role));
      return r !== '' && !roleOptions.includes(r as any);
    });
    if (hasNonCanonicalRole) {
      setError(t('teamTemplateRoleMustBeCanonical'));
      setSavingTemplate(false);
      return;
    }

    const stages = customStages.map(s => ({
      ...s,
      label: (s.label || '').trim() || t('teamStageLabelFallback'),
      role: s.role === null ? null : normalizeRoleCanonical(String(s.role)),
    }));

    if (!name) {
      setError(t('teamTemplateNameRequired'));
      setSavingTemplate(false);
      return;
    }
    if (!stages.length) {
      setError(t('teamTemplateStagesRequired'));
      setSavingTemplate(false);
      return;
    }
    if (!stages.some(s => s.status === 'done')) {
      setError(t('teamTemplateMustHaveDone'));
      setSavingTemplate(false);
      return;
    }

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: customTemplateDescription?.trim() || null,
          stages,
          fail_targets: {},
          is_default: false,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError((data && data.error) ? data.error : t('teamTemplateSaveFailed'));
        setSavingTemplate(false);
        return;
      }

      const created = data as WorkflowTemplate;
      setWorkflows(prev => {
        // Keep a stable order: defaults first, then name. Insert new one near the top (after defaults).
        const next = [created, ...prev.filter(w => w.id !== created.id)];
        return next;
      });

      // Assign the newly created template to this task and exit custom mode
      setSelectedWorkflow(created.id);
      setShowCustomTemplateModal(false);
      setTemplateSaved(true);
      setTimeout(() => setTemplateSaved(false), 2500);

      try {
        await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow_template_id: created.id }),
        });
      } catch {
        // Best-effort
      }

      const wfRoles = Array.from(new Set(
        created.stages
          .filter((s: WorkflowStage) => s.role)
          .map((s: WorkflowStage) => normalizeRoleCanonical(s.role as string))
      ));
      ensureRoleSlotsForStageRoles(wfRoles);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('teamTemplateSaveFailed'));
    } finally {
      setSavingTemplate(false);
    }
  };

  const commitStageRole = (stageId: string) => {
    const stage = customStages.find(s => s.id === stageId);
    if (!stage) return;
    if (stage.role === null) return;
    const normalized = normalizeRoleCanonical(String(stage.role));
    // Allow empty while editing; only sync when we have a real role
    setCustomStages(prev => prev.map(s => s.id === stageId ? { ...s, role: normalized } : s));
    if (normalized) ensureRoleSlotsForStageRoles([normalized]);
  };

  const commitStageRoleValue = (stageId: string, value: string) => {
    const normalized = normalizeRoleCanonical(value);
    setCustomStages(prev => prev.map(s => s.id === stageId ? { ...s, role: normalized } : s));
    if (normalized) ensureRoleSlotsForStageRoles([normalized]);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      // If a workflow template is selected, only save role assignments that belong to the workflow.
      // This prevents confusion from extra "historical" roles lingering in the DB/UI.
      const allowed = selectedWorkflow && !isCustomWorkflow
        ? new Set(uniqueRoles)
        : null;
      const validRoles = roles
        .filter(r => r.role && r.agent_id)
        .filter(r => !allowed || allowed.has(normalizeRole(r.role)));
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

  // Only allow canonical workflow roles for stage routing to guarantee predictable handoffs.
  // (Custom agent roles can still exist, but workflow stage roles are restricted.)
  const presetRoles = ['builder', 'tester', 'reviewer', 'learner', 'verifier'] as const;
  const roleOptions = [...presetRoles];

  const assignedRoleNames = Array.from(
    new Set(roles.map(r => normalizeRoleCanonical(r.role)).filter(Boolean))
  );

  const addableRoles = roleOptions.filter(role => !assignedRoleNames.includes(role));

  // For display: when a workflow is active, show workflow roles first and
  // extra custom roles in a separate section. When there is no workflow
  // selected, show each normalized role only once.
  const displayRoles = uniqueRoles.length > 0
    ? uniqueRoles
    : Array.from(
        new Set(
          roles
            .map(r => normalizeRoleCanonical(r.role))
            .filter(Boolean)
        )
      );

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
          <option value="__custom__">{t('teamCustomTemplateOption')}</option>
          {workflows.map(wf => (
            <option key={wf.id} value={wf.id}>
              {translateWorkflowName(wf.name)}{wf.is_default ? t('teamDefault') : ''} — {translateWorkflowDescription(wf.description || '')}
            </option>
          ))}
        </select>
      </div>

      {/* Custom Workflow Editor Modal */}
      {showCustomTemplateModal && isCustomWorkflow && (
        <div className="fixed inset-0 bg-black/50 z-50 p-3 sm:p-4 flex items-end sm:items-center justify-center">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-lg w-full max-w-4xl max-h-[92vh] sm:max-h-[90vh] flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0">
            <div className="flex items-start justify-between p-4 border-b border-mc-border flex-shrink-0 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('teamCustomTemplateTitle')}</p>
                <p className="text-xs text-mc-text-secondary mt-1 line-clamp-2">{t('teamCustomTemplateHint')}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setShowCustomTemplateModal(false);
                    setSelectedWorkflow(previousWorkflow || '');
                  }}
                  className="min-h-10 px-3 text-sm text-mc-text-secondary hover:bg-mc-bg-tertiary rounded"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCustomTemplateModal(false);
                    setSelectedWorkflow(previousWorkflow || '');
                  }}
                  className="min-h-10 w-10 inline-flex items-center justify-center text-mc-text-secondary hover:bg-mc-bg-tertiary rounded"
                  aria-label={t('cancel')}
                  title={t('cancel')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="bg-mc-bg border border-mc-border rounded-lg p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('teamTemplateNameLabel')}</label>
                    <input
                      value={customTemplateName}
                      onChange={(e) => setCustomTemplateName(e.target.value)}
                      className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                      placeholder={t('teamTemplateNamePlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('teamTemplateDescriptionLabel')}</label>
                    <input
                      value={customTemplateDescription}
                      onChange={(e) => setCustomTemplateDescription(e.target.value)}
                      className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                      placeholder={t('teamTemplateDescriptionPlaceholder')}
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium">{t('teamStages')}</label>
                  <span className="text-xs text-mc-text-secondary">
                    {customStages.length}
                  </span>
                </div>

                {/* Desktop header row */}
                <div className="hidden lg:grid lg:grid-cols-12 gap-2 px-3 py-2 text-[11px] text-mc-text-secondary border border-mc-border rounded-lg bg-mc-bg">
                  <div className="lg:col-span-3">{t('teamStageLabel')}</div>
                  <div className="lg:col-span-3">{t('teamStageStatus')}</div>
                  <div className="lg:col-span-5">{t('teamStageRole')}</div>
                  <div className="lg:col-span-1 text-right">{t('teamStageDeleteShort')}</div>
                </div>

                <div className="space-y-2 mt-2">
                  {customStages.map((stage, idx) => (
                    <div
                      key={stage.id}
                      className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-center bg-mc-bg-tertiary/40 border border-mc-border rounded-lg p-3"
                    >
                      <div className="lg:col-span-3">
                        <label className="block lg:sr-only text-[11px] text-mc-text-secondary mb-1">{t('teamStageLabel')}</label>
                        <input
                          value={stage.label}
                          onChange={(e) => {
                            const v = e.target.value;
                            setCustomStages(prev => prev.map(s => s.id === stage.id ? { ...s, label: v } : s));
                          }}
                          className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2.5 py-2 text-[13px] leading-tight focus:outline-none focus:border-mc-accent"
                          aria-label={t('teamStageLabel')}
                        />
                      </div>

                      <div className="lg:col-span-3">
                        <label className="block lg:sr-only text-[11px] text-mc-text-secondary mb-1">{t('teamStageStatus')}</label>
                        <select
                          value={stage.status}
                          onChange={(e) => {
                            const v = e.target.value as TaskStatus;
                            setCustomStages(prev => prev.map(s => s.id === stage.id ? { ...s, status: v } : s));
                          }}
                          className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-3 py-2 text-[13px] leading-tight focus:outline-none focus:border-mc-accent"
                          aria-label={t('teamStageStatus')}
                        >
                          {taskStatuses.map(st => (
                            <option key={st} value={st}>{translateStatus(st)}</option>
                          ))}
                        </select>
                      </div>

                      <div className="lg:col-span-5">
                        <label className="block lg:sr-only text-[11px] text-mc-text-secondary mb-1">{t('teamStageRole')}</label>
                        <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2 min-w-0">
                          <select
                            value={stage.role === null ? '__queue__' : '__role__'}
                            onChange={(e) => {
                              const mode = e.target.value;
                              setCustomStages(prev => prev.map(s => {
                                if (s.id !== stage.id) return s;
                                if (mode === '__queue__') return { ...s, role: null };
                                // Switch to "has role" mode, but don't force a default role.
                                // Keep it editable (empty string allowed) until user fills it.
                                return { ...s, role: s.role === null ? '' : s.role };
                              }));
                            }}
                            className="min-h-10 bg-mc-bg border border-mc-border rounded px-3 py-2 text-[13px] leading-tight focus:outline-none focus:border-mc-accent"
                            title={t('teamStageRoleModeTitle')}
                            aria-label={t('teamStageRoleModeTitle')}
                          >
                            <option value="__role__">{t('teamStageRoleModeRole')}</option>
                            <option value="__queue__">{t('teamStageRoleModeQueue')}</option>
                          </select>
                          {stage.role !== null ? (() => {
                            const normalized = normalizeRoleCanonical(String(stage.role || ''));
                            const selectValue = (normalized && roleOptions.includes(normalized as any))
                              ? normalized
                              : 'builder';

                            return (
                              <select
                                value={selectValue}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  commitStageRoleValue(stage.id, v);
                                }}
                                className="min-h-10 bg-mc-bg border border-mc-border rounded px-3 py-2 text-[13px] leading-tight focus:outline-none focus:border-mc-accent"
                                aria-label={t('teamStageRole')}
                              >
                                {roleOptions.map(r => (
                                  <option key={r} value={r}>
                                    {translateRoleName(r)} ({r})
                                  </option>
                                ))}
                              </select>
                            );
                          })() : (
                            <div className="min-h-10 px-3 flex items-center text-[13px] text-mc-text-secondary bg-mc-bg border border-mc-border rounded">
                              {t('teamStageRoleModeQueue')}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="lg:col-span-1 flex lg:justify-end">
                        <button
                          type="button"
                          onClick={() => setCustomStages(prev => prev.filter(s => s.id !== stage.id))}
                          className="min-h-10 px-2 text-[13px] leading-tight text-mc-accent-red hover:bg-mc-accent-red/10 rounded w-full lg:w-auto shrink-0"
                          title={t('teamStageDelete')}
                          aria-label={t('teamStageDelete')}
                        >
                          {t('teamStageDeleteShort')}
                        </button>
                      </div>

                      {idx < customStages.length - 1 && (
                        <div className="lg:col-span-12 text-mc-text-secondary/40 text-xs pl-1">→</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-mc-border flex-shrink-0 flex items-center justify-between gap-3 bg-mc-bg-secondary">
              <button
                type="button"
                onClick={() => {
                  setCustomStages(prev => [
                    ...prev,
                    { id: createClientId(), label: t('teamStageNewLabel'), role: 'builder', status: 'in_progress' as TaskStatus },
                  ]);
                }}
                className="min-h-11 px-4 py-2 border border-mc-accent text-mc-accent rounded text-sm font-medium hover:bg-mc-accent/10"
              >
                {t('teamStageAdd')}
              </button>

              <button
                type="button"
                onClick={saveCustomTemplate}
                disabled={savingTemplate}
                className="min-h-11 flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {savingTemplate ? t('teamTemplateSaving') : t('teamTemplateSave')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Workflow Stages Visualization */}
      {!isCustomWorkflow && currentWorkflow && (
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

      {/* Custom Workflow Stages Preview (matches the same look as templates) */}
      {isCustomWorkflow && stagesForUI.length > 0 && (
        <div>
          <label className="block text-sm font-medium mb-2">{t('teamStages')}</label>
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {stagesForUI.map((stage: WorkflowStage, i: number) => (
              <div key={stage.id} className="flex items-center gap-1 flex-shrink-0">
                <div className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                  stage.role
                    ? 'bg-mc-accent/10 border border-mc-accent/30 text-mc-accent'
                    : 'bg-mc-bg-tertiary border border-mc-border text-mc-text-secondary'
                }`}>
                  {translateStageLabel(stage.label)}
                  {stage.role && <span className="ml-1 opacity-60">({translateStageRole(stage.role)})</span>}
                </div>
                {i < stagesForUI.length - 1 && (
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
        {displayRoles.map(role => {
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

          {/* Only allow adding custom roles when NO workflow is selected */}
          {uniqueRoles.length === 0 && (
            <button
              onClick={addCustomRole}
              disabled={addableRoles.length === 0}
              className="text-xs text-mc-accent hover:text-mc-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
              title={addableRoles.length === 0 ? 'No additional role types available to add' : 'Add custom role from agent catalog'}
            >
              {t('teamAddCustomRole')}
            </button>
          )}
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

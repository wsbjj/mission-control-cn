'use client';

import {useEffect, useMemo, useState} from 'react';
import {Plus, ChevronRight, GripVertical, ArrowRightLeft} from 'lucide-react';
import {useMissionControl} from '@/lib/store';
import {triggerAutoDispatch, shouldTriggerAutoDispatch} from '@/lib/auto-dispatch';
import {getConfig} from '@/lib/config';
import type {Task, TaskStatus} from '@/lib/types';
import {TaskModal} from './TaskModal';
import {formatDistanceToNow} from 'date-fns';
import {zhCN} from 'date-fns/locale';
import {useTranslations, useLocale} from 'next-intl';

interface MissionQueueProps {
  workspaceId?: string;
  mobileMode?: boolean;
  isPortrait?: boolean;
}

const COLUMNS: {id: TaskStatus; labelKey: string; color: string}[] = [
  {id: 'planning', labelKey: 'columnPlanning', color: 'border-t-mc-accent-purple'},
  {id: 'inbox', labelKey: 'columnInbox', color: 'border-t-mc-accent-pink'},
  {id: 'assigned', labelKey: 'columnAssigned', color: 'border-t-mc-accent-yellow'},
  {id: 'in_progress', labelKey: 'columnInProgress', color: 'border-t-mc-accent'},
  {id: 'testing', labelKey: 'columnTesting', color: 'border-t-mc-accent-cyan'},
  {id: 'review', labelKey: 'columnReview', color: 'border-t-mc-accent-purple'},
  {id: 'verification', labelKey: 'columnVerification', color: 'border-t-orange-500'},
  {id: 'done', labelKey: 'columnDone', color: 'border-t-mc-accent-green'},
];

export function MissionQueue({workspaceId, mobileMode = false, isPortrait = true}: MissionQueueProps) {
  const {tasks, updateTaskStatus, addEvent} = useMissionControl();
  const t = useTranslations('missionQueue');

  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});

  const [compactEmptyColumns, setCompactEmptyColumns] = useState(true);
  useEffect(() => {
    const cfg = getConfig();
    setCompactEmptyColumns(cfg.kanbanCompactEmptyColumns ?? true);
  }, []);

  const getDesktopColumnWidth = (taskCount: number): string => {
    if (!compactEmptyColumns) return '280px';
    if (taskCount === 0) return 'fit-content';
    const widthPx = Math.min(380, 250 + taskCount * 14);
    return `${widthPx}px`;
  };

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [mobileStatus, setMobileStatus] = useState<TaskStatus>('planning');
  const [statusMoveTask, setStatusMoveTask] = useState<Task | null>(null);
  const [statusBlockedModal, setStatusBlockedModal] = useState<{title: string; message: string} | null>(null);
  const [rollbackModal, setRollbackModal] = useState<{
    task: Task;
    targetStatus: TaskStatus;
  } | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [rollbackSubmitting, setRollbackSubmitting] = useState(false);

  useEffect(() => {
    if (!statusBlockedModal) return;
    const timer = setTimeout(() => setStatusBlockedModal(null), 2500);
    return () => clearTimeout(timer);
  }, [statusBlockedModal]);

  const tasksByParent = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const parentId = (task as Task & { parent_task_id?: string | null }).parent_task_id;
      if (!parentId) continue;
      const arr = map.get(parentId) || [];
      arr.push(task);
      map.set(parentId, arr);
    }
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at).getTime();
        const bTime = new Date(b.updated_at || b.created_at).getTime();
        return bTime - aTime;
      });
      map.set(k, arr);
    }
    return map;
  }, [tasks]);

  // 按最近更新时间（若无则按创建时间）降序排序任务
  const sortByRecent = (list: Task[]) =>
    list
      .slice()
      .sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at).getTime();
        const bTime = new Date(b.updated_at || b.created_at).getTime();
        return bTime - aTime;
      });

  // Column query:
  // - For DONE: show only parent tasks; subtasks are folded under parent.
  // - For other statuses: show tasks as-is (including subtasks), like before.
  const getColumnTasks = (status: TaskStatus) => {
    const isVerificationColumn = status === 'verification';

    if (status === 'done') {
      const parents = tasks.filter((task) => {
        const parentId = (task as Task & { parent_task_id?: string | null }).parent_task_id;
        if (parentId) return false;
        return task.status === 'done';
      });
      return sortByRecent(parents);
    }

    const all = tasks.filter((task) => {
      // If a subtask is already done but its parent isn't, we fold it under the parent
      // instead of showing it as a standalone card in any column.
      const parentId = (task as Task & { parent_task_id?: string | null }).parent_task_id;
      if (parentId && task.status === 'done') return false;

      if (isVerificationColumn) {
        return task.status === 'verification' || /^verification_v\d+$/.test(String(task.status));
      }
      return task.status === status;
    });
    return sortByRecent(all);
  };

  const getParentTasksByStatus = (status: TaskStatus) =>
    tasks
      .filter((task) => {
        const parentId = (task as Task & { parent_task_id?: string | null }).parent_task_id;
        if (parentId) return false;

        // UI unification: all verification rounds are displayed in the same column.
        if (status === 'verification') {
          return task.status === 'verification' || /^verification_v\d+$/.test(String(task.status));
        }
        return task.status === status;
      })
      .slice()
      .sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at).getTime();
        const bTime = new Date(b.updated_at || b.created_at).getTime();
        return bTime - aTime;
      });

  const isStatusAllowedByWorkflow = (task: Task, targetStatus: TaskStatus): boolean => {
    // Non-workflow statuses are always allowed
    const alwaysAllowed: TaskStatus[] = ['planning', 'pending_dispatch', 'inbox', 'assigned'];
    if (alwaysAllowed.includes(targetStatus)) return true;

    const allowed = (task as Task & { workflow_allowed_statuses?: TaskStatus[] }).workflow_allowed_statuses;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(targetStatus);
  };

  const showStatusBlocked = (task: Task, targetStatus: TaskStatus) => {
    const msg = t('statusNotAllowed', {status: targetStatus});
    addEvent({
      id: task.id + '-status-blocked-' + Date.now(),
      type: 'system',
      task_id: task.id,
      message: msg,
      created_at: new Date().toISOString(),
    });
    setStatusBlockedModal({
      title: t('moveTaskModalTitle'),
      message: msg,
    });
  };

  const isFailingBackwards = (from: TaskStatus, to: TaskStatus) =>
    (['testing', 'review', 'verification'].includes(from) || /^verification_v\d+$/.test(String(from))) &&
    ['in_progress', 'assigned'].includes(to);

  const persistStatusChange = async (
    task: Task,
    targetStatus: TaskStatus,
    statusReason?: string
  ): Promise<boolean> => {
    updateTaskStatus(task.id, targetStatus);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          status: targetStatus,
          ...(statusReason ? {status_reason: statusReason} : {}),
        }),
      });

      if (res.ok) {
        addEvent({
          id: task.id + '-' + Date.now(),
          type: targetStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: task.id,
          message: `任务「${task.title}」已移至 ${targetStatus}`,
          created_at: new Date().toISOString(),
        });

        if (shouldTriggerAutoDispatch(task.status, targetStatus, task.assigned_agent_id)) {
          const result = await triggerAutoDispatch({
            taskId: task.id,
            taskTitle: task.title,
            agentId: task.assigned_agent_id,
            agentName: task.assigned_agent?.name || 'Unknown Agent',
            workspaceId: task.workspace_id,
          });

          if (!result.success) {
            console.error('Auto-dispatch failed:', result.error);
          }
        }

        return true;
      }

      const data = await res.json().catch(() => null);
      if (data?.error_code === 'STATUS_NOT_ALLOWED') {
        showStatusBlocked(task, targetStatus);
        updateTaskStatus(task.id, task.status);
        return false;
      }
      if (data?.error_code === 'STATUS_REASON_REQUIRED') {
        // Backend safeguard; in normal flow we should have shown rollback modal first.
        addEvent({
          id: task.id + '-status-failed-' + Date.now(),
          type: 'system',
          task_id: task.id,
          message: t('statusReasonRequired'),
          created_at: new Date().toISOString(),
        });
        setStatusBlockedModal({
          title: t('moveTaskModalTitle'),
          message: t('statusReasonRequired'),
        });
        updateTaskStatus(task.id, task.status);
        return false;
      }

      addEvent({
        id: task.id + '-status-failed-' + Date.now(),
        type: 'system',
        task_id: task.id,
        message: (data && data.error) ? String(data.error) : t('networkError'),
        created_at: new Date().toISOString(),
      });
      updateTaskStatus(task.id, task.status);
      return false;
    } catch (error) {
      console.error('Failed to update task status:', error);
      updateTaskStatus(task.id, task.status);
      return false;
    }
  };

  const updateTaskStatusWithPersist = async (task: Task, targetStatus: TaskStatus): Promise<boolean> => {
    if (task.status === targetStatus) return;

    if (!isStatusAllowedByWorkflow(task, targetStatus)) {
      showStatusBlocked(task, targetStatus);
      return false;
    }

    // Manual rollback requires a reason. Ask first; if user cancels, keep current status.
    if (isFailingBackwards(task.status, targetStatus)) {
      setRollbackReason('');
      setRollbackModal({ task, targetStatus });
      return false;
    }

    return await persistStatusChange(task, targetStatus);
  };

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    if (mobileMode) return;
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (mobileMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    if (mobileMode) return;
    e.preventDefault();
    if (!draggedTask || draggedTask.status === targetStatus) {
      setDraggedTask(null);
      return;
    }

    if (!isStatusAllowedByWorkflow(draggedTask, targetStatus)) {
      showStatusBlocked(draggedTask, targetStatus);
      setDraggedTask(null);
      return;
    }

    await updateTaskStatusWithPersist(draggedTask, targetStatus);
    setDraggedTask(null);
  };

  const mobileTasks = getColumnTasks(mobileStatus);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-3 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className="w-4 h-4 text-mc-text-secondary" />
          <span className="text-sm font-medium uppercase tracking-wider">
            {t('title') /* 任务队列标题 / Mission queue title */}
          </span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 min-h-11 bg-mc-accent-pink text-mc-bg rounded text-sm font-medium hover:bg-mc-accent-pink/90"
        >
          <Plus className="w-4 h-4" />
          {t('newTask') /* 新建任务按钮 / New task button */}
        </button>
      </div>

      {!mobileMode ? (
        <div className="mission-queue-scroll-x flex-1 flex gap-3 p-3 overflow-x-auto">
          {COLUMNS.map((column) => {
            const columnTasks = getColumnTasks(column.id);
            const hasTasks = columnTasks.length > 0;
            return (
              <div
                key={column.id}
                style={{ width: getDesktopColumnWidth(columnTasks.length) }}
                className={`flex-none ${compactEmptyColumns ? (hasTasks ? 'min-w-[240px]' : 'min-w-[110px] max-w-[180px]') : 'min-w-[250px] max-w-[320px]'} flex flex-col bg-mc-bg rounded-lg border border-mc-border/50 border-t-2 transition-[width] duration-200 ${column.color}`}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, column.id)}
              >
                <div className="p-2 border-b border-mc-border flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase text-mc-text-secondary whitespace-nowrap">
                    {t(column.labelKey)}
                  </span>
                  <span className="text-xs bg-mc-bg-tertiary px-2 py-0.5 rounded text-mc-text-secondary">{columnTasks.length}</span>
                </div>

                <div className={`flex-1 overflow-y-auto p-2 ${hasTasks ? 'space-y-2' : ''}`}>
                  {columnTasks.map((task) => {
                    const isDoneColumn = column.id === 'done';
                    const isParent = !Boolean((task as Task & { parent_task_id?: string | null }).parent_task_id);

                    if (!isDoneColumn) {
                      // In non-done columns, fold DONE subtasks under their parent card.
                      // Keep active subtasks as standalone cards.
                      if (!isParent) {
                        return (
                          <TaskCard
                            key={task.id}
                            task={task}
                            onDragStart={handleDragStart}
                            onClick={() => setEditingTask(task)}
                            onMoveStatus={() => setStatusMoveTask(task)}
                            isDragging={draggedTask?.id === task.id}
                            mobileMode={false}
                            portraitMode={false}
                          />
                        );
                      }

                      const allChildren = tasksByParent.get(task.id) || [];
                      const doneChildren = allChildren.filter(c => c.status === 'done');
                      const expanded = Boolean(expandedParents[task.id]);
                      return (
                        <div key={task.id} className="space-y-1.5">
                          <TaskCard
                            task={task}
                            onDragStart={handleDragStart}
                            onClick={() => setEditingTask(task)}
                            onMoveStatus={() => setStatusMoveTask(task)}
                            isDragging={draggedTask?.id === task.id}
                            mobileMode={false}
                            portraitMode={false}
                          />

                          {doneChildren.length > 0 && (
                            <div className="pl-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedParents(prev => ({ ...prev, [task.id]: !expanded }));
                                }}
                                className="text-[11px] text-mc-text-secondary/80 hover:text-mc-text-secondary underline underline-offset-2"
                              >
                                {expanded ? `收起已完成子任务 (${doneChildren.length})` : `展开已完成子任务 (${doneChildren.length})`}
                              </button>

                              {expanded && (
                                <div className="mt-1.5 space-y-1.5">
                                  {doneChildren.map((child) => (
                                    <div key={child.id} className="pl-2 border-l border-mc-border/40">
                                      <TaskCard
                                        task={child}
                                        onDragStart={handleDragStart}
                                        onClick={() => setEditingTask(child)}
                                        onMoveStatus={() => setStatusMoveTask(child)}
                                        isDragging={draggedTask?.id === child.id}
                                        mobileMode={false}
                                        portraitMode={false}
                                      />
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    }

                    const children = tasksByParent.get(task.id) || [];
                    const expanded = Boolean(expandedParents[task.id]);
                    return (
                      <div key={task.id} className="space-y-1.5">
                        <TaskCard
                          task={task}
                          onDragStart={handleDragStart}
                          onClick={() => setEditingTask(task)}
                          onMoveStatus={() => setStatusMoveTask(task)}
                          isDragging={draggedTask?.id === task.id}
                          mobileMode={false}
                          portraitMode={false}
                        />

                        {children.length > 0 && (
                          <div className="pl-2">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedParents(prev => ({ ...prev, [task.id]: !expanded }));
                              }}
                              className="text-[11px] text-mc-text-secondary/80 hover:text-mc-text-secondary underline underline-offset-2"
                            >
                              {expanded ? `收起子任务 (${children.length})` : `展开子任务 (${children.length})`}
                            </button>

                            {expanded && (
                              <div className="mt-1.5 space-y-1.5">
                                {children.map((child) => (
                                  <div key={child.id} className="pl-2 border-l border-mc-border/40">
                                    <TaskCard
                                      task={child}
                                      onDragStart={handleDragStart}
                                      onClick={() => setEditingTask(child)}
                                      onMoveStatus={() => setStatusMoveTask(child)}
                                      isDragging={draggedTask?.id === child.id}
                                      mobileMode={false}
                                      portraitMode={false}
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`flex-1 overflow-y-auto ${isPortrait ? 'p-3 pb-[calc(1rem+env(safe-area-inset-bottom))]' : 'p-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]'}`}>
          <div className={`flex gap-2 overflow-x-auto ${isPortrait ? 'pb-3' : 'pb-2'}`}>
            {COLUMNS.map((column) => {
              const count = getColumnTasks(column.id).length;
              const selected = mobileStatus === column.id;
              return (
                <button
                  key={column.id}
                  onClick={() => setMobileStatus(column.id)}
                  className={`min-h-11 px-4 rounded-full border whitespace-nowrap ${isPortrait ? 'text-sm' : 'text-xs'} ${
                    selected
                      ? 'bg-mc-accent text-mc-bg border-mc-accent font-medium'
                      : 'bg-mc-bg-secondary border-mc-border text-mc-text-secondary'
                  }`}
                >
                  {t(column.labelKey)} ({count})
                </button>
              );
            })}
          </div>

          <div className={`min-w-0 ${isPortrait ? 'space-y-3' : 'space-y-2'}`}>
            {mobileTasks.length === 0 ? (
              <div className="text-sm text-mc-text-secondary bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
                {t('noTasksInStatus') /* 当前状态无任务提示 / No tasks in status message */}
              </div>
            ) : (
              mobileTasks.map((task) => {
                const isDoneColumn = mobileStatus === 'done';
                if (!isDoneColumn) {
                  const isParent = !Boolean((task as Task & { parent_task_id?: string | null }).parent_task_id);
                  if (!isParent) {
                    return (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onDragStart={handleDragStart}
                        onClick={() => setEditingTask(task)}
                        onMoveStatus={() => setStatusMoveTask(task)}
                        isDragging={false}
                        mobileMode
                        portraitMode={isPortrait}
                      />
                    );
                  }

                  const allChildren = tasksByParent.get(task.id) || [];
                  const doneChildren = allChildren.filter(c => c.status === 'done');
                  const expanded = Boolean(expandedParents[task.id]);

                  return (
                    <div key={task.id} className={isPortrait ? 'space-y-2' : 'space-y-1.5'}>
                      <TaskCard
                        task={task}
                        onDragStart={handleDragStart}
                        onClick={() => setEditingTask(task)}
                        onMoveStatus={() => setStatusMoveTask(task)}
                        isDragging={false}
                        mobileMode
                        portraitMode={isPortrait}
                      />

                      {doneChildren.length > 0 && (
                        <div className="pl-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedParents(prev => ({ ...prev, [task.id]: !expanded }));
                            }}
                            className={`text-mc-text-secondary/80 underline underline-offset-2 ${isPortrait ? 'text-xs' : 'text-[11px]'}`}
                          >
                            {expanded ? `收起已完成子任务 (${doneChildren.length})` : `展开已完成子任务 (${doneChildren.length})`}
                          </button>

                          {expanded && (
                            <div className={isPortrait ? 'mt-2 space-y-2' : 'mt-1.5 space-y-1.5'}>
                              {doneChildren.map((child) => (
                                <div key={child.id} className="pl-2 border-l border-mc-border/40">
                                  <TaskCard
                                    task={child}
                                    onDragStart={handleDragStart}
                                    onClick={() => setEditingTask(child)}
                                    onMoveStatus={() => setStatusMoveTask(child)}
                                    isDragging={false}
                                    mobileMode
                                    portraitMode={isPortrait}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                }

                const children = tasksByParent.get(task.id) || [];
                const expanded = Boolean(expandedParents[task.id]);
                return (
                  <div key={task.id} className={isPortrait ? 'space-y-2' : 'space-y-1.5'}>
                    <TaskCard
                      task={task}
                      onDragStart={handleDragStart}
                      onClick={() => setEditingTask(task)}
                      onMoveStatus={() => setStatusMoveTask(task)}
                      isDragging={false}
                      mobileMode
                      portraitMode={isPortrait}
                    />

                    {children.length > 0 && (
                      <div className="pl-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedParents(prev => ({ ...prev, [task.id]: !expanded }));
                          }}
                          className={`text-mc-text-secondary/80 underline underline-offset-2 ${isPortrait ? 'text-xs' : 'text-[11px]'}`}
                        >
                          {expanded ? `收起子任务 (${children.length})` : `展开子任务 (${children.length})`}
                        </button>

                        {expanded && (
                          <div className={isPortrait ? 'mt-2 space-y-2' : 'mt-1.5 space-y-1.5'}>
                            {children.map((child) => (
                              <div key={child.id} className="pl-2 border-l border-mc-border/40">
                                <TaskCard
                                  task={child}
                                  onDragStart={handleDragStart}
                                  onClick={() => setEditingTask(child)}
                                  onMoveStatus={() => setStatusMoveTask(child)}
                                  isDragging={false}
                                  mobileMode
                                  portraitMode={isPortrait}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {showCreateModal && <TaskModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />}
      {editingTask && <TaskModal task={editingTask} onClose={() => setEditingTask(null)} workspaceId={workspaceId} />}

      {statusBlockedModal && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 p-4 flex items-end sm:items-center sm:justify-center"
          onClick={() => setStatusBlockedModal(null)}
        >
          <div
            className="w-full sm:max-w-md bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-mc-text-secondary mb-2">{statusBlockedModal.title}</div>
            <div className="text-sm text-mc-text-secondary">{statusBlockedModal.message}</div>
          </div>
        </div>
      )}

      {rollbackModal && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 p-4 flex items-end sm:items-center sm:justify-center"
          onClick={() => {
            if (rollbackSubmitting) return;
            setRollbackModal(null);
          }}
        >
          <div
            className="w-full sm:max-w-md bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium mb-2">{t('rollbackReasonTitle')}</div>
            <div className="text-sm text-mc-text-secondary mb-3">
              {t('rollbackReasonHint', { from: rollbackModal.task.status, to: rollbackModal.targetStatus })}
            </div>
            <textarea
              value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)}
              placeholder={t('rollbackReasonPlaceholder')}
              className="w-full min-h-24 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
              disabled={rollbackSubmitting}
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg text-sm text-mc-text-secondary hover:bg-mc-bg-tertiary disabled:opacity-50"
                onClick={() => setRollbackModal(null)}
                disabled={rollbackSubmitting}
              >
                {t('rollbackReasonCancel')}
              </button>
              <button
                className="min-h-11 px-4 rounded-lg bg-mc-accent text-mc-bg text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
                disabled={rollbackSubmitting || !rollbackReason.trim()}
                onClick={async () => {
                  if (!rollbackModal) return;
                  setRollbackSubmitting(true);
                  const ok = await persistStatusChange(rollbackModal.task, rollbackModal.targetStatus, rollbackReason.trim());
                  setRollbackSubmitting(false);
                  if (ok) {
                    setRollbackModal(null);
                    setRollbackReason('');
                    // If mobile "move status" modal is open, close it after a successful rollback.
                    setStatusMoveTask(null);
                  }
                }}
              >
                {rollbackSubmitting ? t('rollbackReasonSubmitting') : t('rollbackReasonConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {mobileMode && statusMoveTask && (
        <div className="fixed inset-0 z-50 bg-black/60 p-4 flex items-end sm:items-center sm:justify-center" onClick={() => setStatusMoveTask(null)}>
          <div
            className="w-full sm:max-w-md bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-mc-text-secondary mb-2">
              {t('moveTaskModalTitle') /* 移动任务弹窗标题 / Move task modal title */}
            </div>
            <div className="font-medium mb-4 line-clamp-2">{statusMoveTask.title}</div>
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {COLUMNS.map((column) => (
                <button
                  key={column.id}
                  onClick={async () => {
                    const ok = await updateTaskStatusWithPersist(statusMoveTask, column.id);
                    if (ok) setStatusMoveTask(null);
                  }}
                  disabled={statusMoveTask.status === column.id || !isStatusAllowedByWorkflow(statusMoveTask, column.id)}
                  className="w-full min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg text-left text-sm disabled:opacity-40"
                >
                  {t(column.labelKey) /* 状态按钮文案 / Status button label */}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onDragStart: (e: React.DragEvent, task: Task) => void;
  onClick: () => void;
  onMoveStatus: () => void;
  isDragging: boolean;
  mobileMode: boolean;
  portraitMode?: boolean;
}

function TaskCard({task, onDragStart, onClick, onMoveStatus, isDragging, mobileMode, portraitMode = true}: TaskCardProps) {
  const t = useTranslations('missionQueue'); // 任务卡片文案国际化 / i18n for task card copy
  const locale = useLocale(); // 当前界面语言 / Current UI locale
  const dateLocale = locale === 'zh' ? zhCN : undefined; // 中文使用 zhCN，相对时间自动汉化 / Use zhCN for Chinese locale
  const priorityStyles = {
    low: 'text-mc-text-secondary',
    normal: 'text-mc-accent',
    high: 'text-mc-accent-yellow',
    urgent: 'text-mc-accent-red',
  };

  const priorityDots = {
    low: 'bg-mc-text-secondary/40',
    normal: 'bg-mc-accent',
    high: 'bg-mc-accent-yellow',
    urgent: 'bg-mc-accent-red',
  };

  const isPlanning = task.status === 'planning';
  const isAssigned = task.status === 'assigned';
  const dispatchError = task.planning_dispatch_error;

  return (
    <div
      draggable={!mobileMode}
      onDragStart={(e) => onDragStart(e, task)}
      onClick={onClick}
      className={`group bg-mc-bg-secondary border rounded-lg cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isPlanning ? 'border-purple-500/40 hover:border-purple-500' : 'border-mc-border/50 hover:border-mc-accent/40'}`}
    >
      {!mobileMode && (
        <div className="flex items-center justify-center py-1.5 border-b border-mc-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="w-4 h-4 text-mc-text-secondary/50 cursor-grab" />
        </div>
      )}

      <div className={portraitMode ? 'p-4' : 'p-3'}>
        <h4 className={`font-medium leading-snug line-clamp-2 ${portraitMode ? 'text-sm mb-3' : 'text-xs mb-2'}`}>{task.title}</h4>

        {isPlanning && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-purple-500/10 rounded-md border border-purple-500/20`}>
            <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-purple-400 font-medium">
              {t('continuePlanning') /* 继续规划提示 / Continue planning hint */}
            </span>
          </div>
        )}

        {isAssigned && dispatchError && (
          <div className={`flex items-start gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-red-500/10 rounded-md border border-red-500/30`}>
            <div className="w-2 h-2 bg-red-400 rounded-full mt-1 flex-shrink-0" />
            <span className="text-xs text-red-300">
              {t('assignedBlockedPrefix') /* 已分配但被阻塞前缀 / Assigned but blocked prefix */} {dispatchError}
            </span>
          </div>
        )}

        {isAssigned && !dispatchError && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-yellow-500/10 rounded-md border border-yellow-500/30`}>
            <div className="w-2 h-2 bg-yellow-400 rounded-full flex-shrink-0" />
            <span className="text-xs text-yellow-200">
              {t('assignedValidating') /* 已分配并校验提示 / Assigned and validating hint */}
            </span>
          </div>
        )}

        {task.status === 'inbox' && !task.assigned_agent_id && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-amber-500/10 rounded-md border border-amber-500/30`}>
            <div className="w-2 h-2 bg-amber-400 rounded-full flex-shrink-0" />
            <span className="text-xs text-amber-200">
              {t('needsAgent') /* 待分配智能体提示 / Needs agent hint */}
            </span>
          </div>
        )}

        {(task.status === 'testing' || task.status === 'verification' || /^verification_v\d+$/.test(String(task.status))) && dispatchError && (
          <div className={`flex items-start gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-red-500/10 rounded-md border border-red-500/30`}>
            <div className="w-2 h-2 bg-red-400 rounded-full mt-1 flex-shrink-0" />
            <span className="text-xs text-red-300">{dispatchError}</span>
          </div>
        )}

        {task.status === 'review' && !dispatchError && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-cyan-500/10 rounded-md border border-cyan-500/30`}>
            <div className="w-2 h-2 bg-cyan-400 rounded-full flex-shrink-0" />
            <span className="text-xs text-cyan-200">
              {t('inQueueVerification') /* 等待验证提示 / Waiting for verification hint */}
            </span>
          </div>
        )}

        {task.assigned_agent && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-1.5 px-2' : 'mb-2 py-1 px-2'} bg-mc-bg-tertiary/50 rounded`}>
            <span className="text-base">{(task.assigned_agent as unknown as { avatar_emoji: string }).avatar_emoji}</span>
            <span className="text-xs text-mc-text-secondary truncate">{(task.assigned_agent as unknown as { name: string }).name}</span>
          </div>
        )}

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-mc-border/20">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${priorityDots[task.priority]}`} />
            <span className={`text-xs capitalize ${priorityStyles[task.priority]}`}>{task.priority}</span>
          </div>
          <span className="text-[10px] text-mc-text-secondary/60">
            {formatDistanceToNow(new Date(task.updated_at || task.created_at), {
              addSuffix: true,
              locale: dateLocale, // 根据当前语言切换相对时间语言 / Localize relative time by UI locale
            })}
          </span>
        </div>

        {mobileMode && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveStatus();
            }}
            className={`w-full min-h-11 rounded-md border border-mc-border bg-mc-bg flex items-center justify-center gap-2 text-mc-text-secondary ${portraitMode ? 'mt-3 text-sm' : 'mt-2 text-xs'}`}
          >
            <ArrowRightLeft className="w-4 h-4" />
            {t('moveTaskModalButton') /* 移动状态按钮文案 / Move status button label */}
          </button>
        )}
      </div>
    </div>
  );
}

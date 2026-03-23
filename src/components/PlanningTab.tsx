'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, Circle, Lock, AlertCircle, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface PlanningOption {
  id: string;
  label: string;
}

interface PlanningQuestion {
  question: string;
  options: PlanningOption[];
}

interface PlanningMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  allow_new_agents?: boolean;
}

interface PlanningState {
  taskId: string;
  sessionKey?: string;
  messages: PlanningMessage[];
  currentQuestion?: PlanningQuestion;
  isComplete: boolean;
  dispatchError?: string;
  spec?: {
    title: string;
    summary: string;
    deliverables: string[];
    success_criteria: string[];
    constraints: Record<string, unknown>;
  };
  agents?: Array<{
    name: string;
    role: string;
    avatar_emoji: string;
    soul_md: string;
    instructions: string;
  }>;
  isStarted: boolean;
}

interface PlanningTabProps {
  taskId: string;
  onSpecLocked?: () => void;
}

export function PlanningTab({ taskId, onSpecLocked }: PlanningTabProps) {
  const t = useTranslations('taskModal');
  const [state, setState] = useState<PlanningState | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  // 支持多选：保存被选中的多个选项 **ID**，例如 "A" / "B" / "other"
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [retryingDispatch, setRetryingDispatch] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [stalePlanning, setStalePlanning] = useState(false);
  const [forceCompleting, setForceCompleting] = useState(false);
  const [noNewMessageCount, setNoNewMessageCount] = useState(0);
  const [allowNewAgents, setAllowNewAgents] = useState(true);

  // Refs to track polling state without triggering re-renders
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingHardTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastSubmissionRef = useRef<{ answer: string; otherText?: string } | null>(null);
  const currentQuestionRef = useRef<string | undefined>(undefined);
  


  // Load planning state (initial load only)
  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`);
      if (res.ok) {
        const data = await res.json();
        setState(data);
        currentQuestionRef.current = data.currentQuestion?.question;
        // Don't call onSpecLocked on initial load - only when planning completes actively
      }
    } catch (err) {
      console.error('Failed to load planning state:', err);
      setError('Failed to load planning state');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Stop polling (defined first to avoid circular dependency)
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingWarningTimeoutRef.current) {
      clearTimeout(pollingWarningTimeoutRef.current);
      pollingWarningTimeoutRef.current = null;
    }
    if (pollingHardTimeoutRef.current) {
      clearTimeout(pollingHardTimeoutRef.current);
      pollingHardTimeoutRef.current = null;
    }
    setIsWaitingForResponse(false);
  }, []);

  // Poll for updates using the poll endpoint (lightweight OpenClaw check)
  const pollForUpdates = useCallback(async () => {
    if (isPollingRef.current) return; // Prevent overlapping polls
    isPollingRef.current = true;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/poll`);
      if (res.ok) {
        const data = await res.json();

        // Track stale planning state from server
        if (data.stalePlanning) {
          setStalePlanning(true);
        }

        // Track consecutive "no updates" polls — if we get 15+ (30 seconds)
        // with no movement after submitting an answer, something is wrong
        if (!data.hasUpdates && isWaitingForResponse) {
          setNoNewMessageCount(prev => {
            const next = prev + 1;
            if (next >= 15) setStalePlanning(true);
            return next;
          });
        }

        if (data.hasUpdates) {
          // Clear any stale waiting warnings once updates are flowing
          setError(null);
          setStalePlanning(false);
          setNoNewMessageCount(0);

          const newQuestion = data.currentQuestion?.question;
          const questionChanged = newQuestion && currentQuestionRef.current !== newQuestion;

          // Force a full state reload from server to avoid stale state issues
          const freshRes = await fetch(`/api/tasks/${taskId}/planning`);
          if (freshRes.ok) {
            const freshData = await freshRes.json();
            setState(freshData);
          } else {
            setState(prev => ({
              ...prev!,
              messages: data.messages,
              isComplete: data.complete,
              spec: data.spec,
              agents: data.agents,
              currentQuestion: data.currentQuestion,
              dispatchError: data.dispatchError,
            }));
          }

          if (questionChanged) {
            currentQuestionRef.current = newQuestion;
            setSelectedOptions([]);
            setOtherText('');
            setIsSubmittingAnswer(false);
          }
          // Always clear submitting state when we have a question
          if (data.currentQuestion) {
            setIsSubmittingAnswer(false);
            setSubmitting(false);
          }

          // Show dispatch error if present
          if (data.dispatchError) {
            setError(`Planning completed but dispatch failed: ${data.dispatchError}`);
          }

          if (data.complete && onSpecLocked) {
            onSpecLocked();
          }

          // Only stop polling when we actually have a question or completion
          if (data.currentQuestion || data.complete || data.dispatchError) {
            setIsWaitingForResponse(false);
            stopPolling();
          }
        }
      }
    } catch (err) {
      console.error('Failed to poll for updates:', err);
    } finally {
      isPollingRef.current = false;
    }
  }, [taskId, onSpecLocked, stopPolling, setState, setError, setIsSubmittingAnswer, setOtherText, setSelectedOptions]);

  // Start polling when waiting for response
  const startPolling = useCallback(() => {
    stopPolling();
    setError(null);
    setIsWaitingForResponse(true);

    // Poll every 2 seconds for responsive UX
    pollingIntervalRef.current = setInterval(() => {
      pollForUpdates();
    }, 2000);

    // Soft warning at 90s, but keep polling so long responses can still complete
    pollingWarningTimeoutRef.current = setTimeout(() => {
      setError(t('planningOrchestratorWarning'));
    }, 90000);

    // Hard timeout at 5 minutes to avoid infinite wait states
    pollingHardTimeoutRef.current = setTimeout(() => {
      stopPolling();
      setSubmitting(false);
      setIsSubmittingAnswer(false);
      setError(t('planningOrchestratorTimeout'));
    }, 300000);
  }, [pollForUpdates, stopPolling, t]);

  // Update currentQuestion ref when state changes
  useEffect(() => {
    if (state?.currentQuestion) {
      currentQuestionRef.current = state.currentQuestion.question;
    }
  }, [state]);

  // Initial load
  useEffect(() => {
    loadState();
    return () => stopPolling();
  }, [loadState, stopPolling]);

  // Auto-start polling if planning is in progress but no question loaded yet
  useEffect(() => {
    if (state && state.isStarted && !state.isComplete && !state.currentQuestion && !isWaitingForResponse) {
      startPolling();
    }
  }, [state, isWaitingForResponse, startPolling]);

  // Start planning session
  const startPlanning = async () => {
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_new_agents: allowNewAgents }),
      });
      const data = await res.json();

      if (res.ok) {
        setState(prev => ({
          ...prev!,
          sessionKey: data.sessionKey,
          messages: data.messages || [],
          isStarted: true,
        }));

        // Start polling for the first question
        startPolling();
      } else {
        setError(data.error || 'Failed to start planning');
      }
    } catch (err) {
      setError('Failed to start planning');
    } finally {
      setStarting(false);
    }
  };

  // Submit answer
  const submitAnswer = async () => {
    if (!selectedOptions.length) return;
    if (!state?.currentQuestion) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true); // Show submitting state in UI
    setError(null);

    // Store submission for retry（先构造易于模型理解的自然语言答案）
    const hasOther = selectedOptions.includes('other');
    const optionMap = new Map(state.currentQuestion.options.map((o) => [o.id, o]));
    const normalizedAnswers = selectedOptions.map((id) => {
      const opt = optionMap.get(id);
      if (!opt) return id;
      if (id === 'other' && otherText.trim()) {
        // 把「其他」的补充说明带上
        return `${opt.label}: ${otherText.trim()}`;
      }
      return opt.label;
    });

    const submission = {
      answer: normalizedAnswers.join('; '),
      otherText: undefined,
    };
    lastSubmissionRef.current = submission;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        // Start polling for the next question or completion
        // Don't clear selection yet - keep it visible while waiting for response
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        setIsSubmittingAnswer(false); // Clear submitting state on error
        // Clear selection on error so user can try again
        setSelectedOptions([]);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      setIsSubmittingAnswer(false); // Clear submitting state on error
      // Clear selection on error so user can try again
      setSelectedOptions([]);
      setOtherText('');
    } finally {
      // Don't re-enable submit button here — wait until next question arrives
      // setSubmitting(false) is handled when polling gets the new question
    }
  };

  // Retry last submission
  const handleRetry = async () => {
    const submission = lastSubmissionRef.current;
    if (!submission) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true); // Show submitting state
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        // Clear submission state and selection on error so user can retry
        setIsSubmittingAnswer(false);
        setSelectedOptions([]);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      // Clear submission state and selection on error so user can retry
      setIsSubmittingAnswer(false);
      setSelectedOptions([]);
      setOtherText('');
    } finally {
      setSubmitting(false);
    }
  };

  // Retry dispatch for failed planning completions
  const retryDispatch = async () => {
    setRetryingDispatch(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/retry-dispatch`, {
        method: 'POST',
      });

      const data = await res.json();

      if (res.ok) {
        console.log('Dispatch retry successful:', data.message);
        setError(null);
      } else {
        setError(`Failed to retry dispatch: ${data.error}`);
      }
    } catch (err) {
      setError('Failed to retry dispatch');
    } finally {
      setRetryingDispatch(false);
    }
  };

  // Force complete planning when stuck
  const forceCompletePlanning = async () => {
    setForceCompleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/force-complete`, {
        method: 'POST',
      });

      const data = await res.json();

      if (res.ok) {
        setStalePlanning(false);
        setNoNewMessageCount(0);
        // Reload full state
        await loadState();
        if (onSpecLocked) onSpecLocked();
      } else {
        setError(data.error || 'Failed to force-complete planning');
      }
    } catch (err) {
      setError('Failed to force-complete planning');
    } finally {
      setForceCompleting(false);
    }
  };

  // Cancel planning
  const cancelPlanning = async () => {
    if (!confirm(t('planningCancelConfirm'))) {
      return;
    }

    setCanceling(true);
    setError(null);
    setIsSubmittingAnswer(false); // Clear submitting state when canceling
    stopPolling(); // Stop polling when canceling

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, {
        method: 'DELETE',
      });

      if (res.ok) {
        // Reset state
        setState({
          taskId,
          isStarted: false,
          messages: [],
          isComplete: false,
        });
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel planning');
      }
    } catch (err) {
      setError('Failed to cancel planning');
    } finally {
      setCanceling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-mc-accent" />
        <span className="ml-2 text-mc-text-secondary">Loading planning state...</span>
      </div>
    );
  }

  // Planning complete - show spec and agents
  if (state?.isComplete && state?.spec) {
    return (
      <div className="p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400">
            <Lock className="w-5 h-5" />
            <span className="font-medium">{t('planningCompleteTitle')}</span>
          </div>
          {state.dispatchError && (
            <div className="text-right">
              <span className="text-sm text-amber-400">⚠️ Dispatch Failed</span>
            </div>
          )}
        </div>
        
        {/* Dispatch Error with Retry */}
        {state.dispatchError && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-amber-400 text-sm font-medium mb-2">Task dispatch failed</p>
                <p className="text-amber-300 text-xs mb-3">{state.dispatchError}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={retryDispatch}
                    disabled={retryingDispatch}
                    className="px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs rounded disabled:opacity-50 flex items-center gap-1"
                  >
                    {retryingDispatch ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Retrying...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-3 h-3" />
                        Retry Dispatch
                      </>
                    )}
                  </button>
                  <span className="text-amber-400 text-xs">
                    This will attempt to assign the task to an agent
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Spec Summary */}
        <div className="bg-mc-bg border border-mc-border rounded-lg p-4">
          <h3 className="font-medium mb-2">{state.spec.title}</h3>
          <p className="text-sm text-mc-text-secondary mb-4">{state.spec.summary}</p>
          
          {state.spec.deliverables?.length > 0 && (
            <div className="mb-3">
              <h4 className="text-sm font-medium mb-1">Deliverables:</h4>
              <ul className="list-disc list-inside text-sm text-mc-text-secondary">
                {state.spec.deliverables.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          
          {state.spec.success_criteria?.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-1">Success Criteria:</h4>
              <ul className="list-disc list-inside text-sm text-mc-text-secondary">
                {state.spec.success_criteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        
        {/* Generated Agents */}
        {state.agents && state.agents.length > 0 && (
          <div>
            <h3 className="font-medium mb-2">{t('planningAgentsCreatedTitle')}</h3>
            <div className="space-y-2">
              {state.agents.map((agent, i) => (
                <div key={i} className="bg-mc-bg border border-mc-border rounded-lg p-3 flex items-center gap-3">
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  <div>
                    <p className="font-medium">{agent.name}</p>
                    <p className="text-sm text-mc-text-secondary">{agent.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Not started - show start button
  if (!state?.isStarted) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="text-center">
          <h3 className="text-lg font-medium mb-2">{t('planningStartTitle')}</h3>
          <p className="text-mc-text-secondary text-sm max-w-md">
            {t('planningStartDescription')}
          </p>
        </div>
        
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-mc-text-secondary">
          <input
            type="checkbox"
            checked={allowNewAgents}
            onChange={(e) => setAllowNewAgents(e.target.checked)}
            className="rounded border-mc-border"
          />
          是否允许生成新的Agent
        </label>

        <button
          onClick={startPlanning}
          disabled={starting}
          className="px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2"
        >
          {starting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              {t('planningStarting')}
            </>
          ) : (
            <>📋 {t('planningStartButton')}</>
          )}
        </button>
      </div>
    );
  }

  // Show current question
  return (
    <div className="flex flex-col h-full">
      {/* Progress indicator with cancel button */}
      <div className="p-4 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-mc-text-secondary">
          <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
          <span>{t('planningInProgress')}</span>
        </div>
        <button
          onClick={cancelPlanning}
          disabled={canceling}
          className="flex items-center gap-2 px-3 py-2 text-sm text-mc-accent-red hover:bg-mc-accent-red/10 rounded disabled:opacity-50"
        >
          {canceling ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('planningCanceling')}
            </>
          ) : (
            <>
              <X className="w-4 h-4" />
              {t('planningCancel')}
            </>
          )}
        </button>
      </div>

      {/* Question area */}
      <div className="flex-1 overflow-y-auto p-6">
        {state?.currentQuestion ? (
          <div className="max-w-xl mx-auto">
            <h3 className="text-lg font-medium mb-6">
              {state.currentQuestion.question}
            </h3>

            <div className="space-y-3">
              {state.currentQuestion.options.map((option) => {
                const isSelected = selectedOptions.includes(option.id);
                const isOther = option.id === 'other' || option.label.toLowerCase() === 'other';
                const isThisOptionSubmitting = isSubmittingAnswer && isSelected;

                return (
                  <div key={option.id}>
                    <button
                      onClick={() => {
                        setSelectedOptions((prev) =>
                          prev.includes(option.id)
                            ? prev.filter((l) => l !== option.id)
                            : [...prev, option.id]
                        );
                      }}
                      disabled={submitting}
                      className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-all text-left ${
                        isThisOptionSubmitting
                          ? 'border-mc-accent bg-mc-accent/20'
                          : isSelected
                          ? 'border-mc-accent bg-mc-accent/10'
                          : 'border-mc-border hover:border-mc-accent/50'
                      } disabled:opacity-50`}
                    >
                      <span className={`w-8 h-8 rounded flex items-center justify-center text-sm font-bold ${
                        isSelected ? 'bg-mc-accent text-mc-bg' : 'bg-mc-bg-tertiary'
                      }`}>
                        {option.id.toUpperCase()}
                      </span>
                      <span className="flex-1">{option.label}</span>
                      {isThisOptionSubmitting ? (
                        <Loader2 className="w-5 h-5 text-mc-accent animate-spin" />
                      ) : isSelected && !submitting ? (
                        <CheckCircle className="w-5 h-5 text-mc-accent" />
                      ) : null}
                    </button>

                    {/* Other text input */}
                    {isOther && isSelected && (
                      <div className="mt-2 ml-11">
                        <input
                          type="text"
                          value={otherText}
                          onChange={(e) => setOtherText(e.target.value)}
                          placeholder={t('planningPleaseSpecify')}
                          className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                          disabled={submitting}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {error && (
              <div
                className={`mt-4 p-3 border rounded-lg ${
                  error.includes('still processing')
                    ? 'bg-orange-500/10 border-orange-500/40'
                    : 'bg-red-500/10 border-red-500/30'
                }`}
              >
                <div className="flex items-start gap-2">
                  <AlertCircle
                    className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      error.includes('still processing') ? 'text-orange-300' : 'text-red-400'
                    }`}
                  />
                  <div className="flex-1">
                    <p className={`text-sm ${error.includes('still processing') ? 'text-orange-200' : 'text-red-400'}`}>
                      {error}
                    </p>
                    {!isWaitingForResponse && lastSubmissionRef.current && (
                      <button
                        onClick={handleRetry}
                        disabled={submitting}
                        className={`mt-2 text-xs underline disabled:opacity-50 ${
                          error.includes('still processing')
                            ? 'text-orange-300 hover:text-orange-200'
                            : 'text-red-400 hover:text-red-300'
                        }`}
                      >
                        {submitting ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Submit button */}
            <div className="mt-6">
              <button
                onClick={submitAnswer}
                disabled={
                  !selectedOptions.length ||
                  submitting ||
                  (selectedOptions.some((label) => label.toLowerCase() === 'other') && !otherText.trim())
                }
                className="w-full px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Continue →'
                )}
              </button>

              {/* Waiting indicator after submit */}
              {isSubmittingAnswer && !submitting && (
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-mc-text-secondary">
                  <Loader2 className="w-4 h-4 animate-spin text-mc-accent" />
                  <span>Waiting for response...</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              {stalePlanning ? (
                <>
                  <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
                  <p className="text-amber-300 font-medium mb-2">Planning appears stuck</p>
                  <p className="text-mc-text-secondary text-sm mb-4 max-w-sm">
                    The orchestrator hasn&apos;t responded in a while. This can happen when the completion message was processed but the dispatch didn&apos;t fire.
                  </p>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={forceCompletePlanning}
                      disabled={forceCompleting}
                      className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-sm rounded-lg border border-amber-500/30 disabled:opacity-50 flex items-center gap-2"
                    >
                      {forceCompleting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-4 h-4" />
                          Force Complete &amp; Dispatch
                        </>
                      )}
                    </button>
                    <button
                      onClick={cancelPlanning}
                      disabled={canceling}
                      className="px-4 py-2 text-mc-text-secondary hover:text-mc-accent-red text-sm rounded-lg border border-mc-border hover:border-mc-accent-red/30"
                    >
                      Cancel Planning
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <Loader2 className="w-8 h-8 animate-spin text-mc-accent mx-auto mb-2" />
                  <p className="text-mc-text-secondary">
                    {isWaitingForResponse ? 'Waiting for response...' : 'Waiting for next question...'}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Conversation history (collapsed by default) */}
      {state?.messages && state.messages.length > 0 && (
        <details className="border-t border-mc-border">
          <summary className="p-3 text-sm text-mc-text-secondary cursor-pointer hover:bg-mc-bg-tertiary">
            View conversation ({state.messages.length} messages)
          </summary>
          <div className="p-3 space-y-2 max-h-48 overflow-y-auto bg-mc-bg">
            {state.messages.map((msg, i) => (
              <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-mc-accent' : 'text-mc-text-secondary'}`}>
                <span className="font-medium">{msg.role === 'user' ? 'You' : 'Orchestrator'}:</span>{' '}
                <span className="opacity-75">{msg.content.substring(0, 100)}...</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

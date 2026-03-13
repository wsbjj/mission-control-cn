'use client';

import { create } from 'zustand';
import { debug } from './debug';
import type { Agent, Task, Conversation, Message, Event, TaskStatus, OpenClawSession } from './types';

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(['assigned', 'in_progress', 'testing', 'verification']);

function reconcileAgentStatuses(agents: Agent[], tasks: Task[]): Agent[] {
  const activeAgentIds = new Set(
    tasks
      .filter((t) => t.assigned_agent_id && ACTIVE_TASK_STATUSES.has(t.status as TaskStatus))
      .map((t) => t.assigned_agent_id as string)
  );

  return agents.map((agent) => {
    if (agent.status === 'offline') return agent;
    return {
      ...agent,
      status: activeAgentIds.has(agent.id) ? 'working' : 'standby',
    };
  });
}

interface MissionControlState {
  // Data
  agents: Agent[];
  tasks: Task[];
  conversations: Conversation[];
  events: Event[];
  currentConversation: Conversation | null;
  messages: Message[];

  // OpenClaw state
  agentOpenClawSessions: Record<string, OpenClawSession | null>; // agentId -> session
  openclawMessages: Message[]; // Messages from OpenClaw (displayed alongside regular messages)

  // UI State
  selectedAgent: Agent | null;
  selectedTask: Task | null;
  isOnline: boolean;
  isLoading: boolean;
  selectedBusiness: string;

  // Actions
  setAgents: (agents: Agent[]) => void;
  setTasks: (tasks: Task[]) => void;
  setConversations: (conversations: Conversation[]) => void;
  setEvents: (events: Event[]) => void;
  addEvent: (event: Event) => void;
  setCurrentConversation: (conversation: Conversation | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setSelectedAgent: (agent: Agent | null) => void;
  setSelectedTask: (task: Task | null) => void;
  setIsOnline: (online: boolean) => void;
  setIsLoading: (loading: boolean) => void;
  setSelectedBusiness: (business: string) => void;

  // Task mutations
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  updateTask: (task: Task) => void;
  addTask: (task: Task) => void;
  removeTask: (taskId: string) => void;

  // Agent mutations
  updateAgent: (agent: Agent) => void;
  addAgent: (agent: Agent) => void;

  // OpenClaw actions
  setAgentOpenClawSession: (agentId: string, session: OpenClawSession | null) => void;
  setOpenclawMessages: (messages: Message[]) => void;
  addOpenclawMessage: (message: Message) => void;
}

export const useMissionControl = create<MissionControlState>((set) => ({
  // Initial state
  agents: [],
  tasks: [],
  conversations: [],
  events: [],
  currentConversation: null,
  messages: [],
  agentOpenClawSessions: {},
  openclawMessages: [],
  selectedAgent: null,
  selectedTask: null,
  isOnline: false,
  isLoading: true,
  selectedBusiness: 'all',

  // Setters
  setAgents: (agents) =>
    set((state) => ({ agents: reconcileAgentStatuses(agents, state.tasks) })),
  setTasks: (tasks) => {
    debug.store('setTasks called', { count: tasks.length });
    set((state) => ({
      tasks,
      agents: reconcileAgentStatuses(state.agents, tasks),
    }));
  },
  setConversations: (conversations) => set({ conversations }),
  setEvents: (events) => set({ events }),
  addEvent: (event) =>
    set((state) => ({ events: [event, ...state.events].slice(0, 100) })),
  setCurrentConversation: (conversation) => set({ currentConversation: conversation }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  setSelectedAgent: (agent) => set({ selectedAgent: agent }),
  setSelectedTask: (task) => {
    debug.store('setSelectedTask called', { id: task?.id, status: task?.status });
    set({ selectedTask: task });
  },
  setIsOnline: (online) => {
    debug.store('setIsOnline called', { online });
    set({ isOnline: online });
  },
  setIsLoading: (loading) => set({ isLoading: loading }),
  setSelectedBusiness: (business) => set({ selectedBusiness: business }),

  // Task mutations
  updateTaskStatus: (taskId, status) => {
    debug.store('updateTaskStatus called', { taskId, status });
    set((state) => {
      const tasks = state.tasks.map((task) =>
        task.id === taskId ? { ...task, status } : task
      );
      return {
        tasks,
        agents: reconcileAgentStatuses(state.agents, tasks),
      };
    });
  },
  updateTask: (updatedTask) => {
    debug.store('updateTask called', { id: updatedTask.id, status: updatedTask.status });
    set((state) => {
      const oldTask = state.tasks.find(t => t.id === updatedTask.id);
      if (oldTask) {
        debug.store('Task state change', {
          id: updatedTask.id,
          oldStatus: oldTask.status,
          newStatus: updatedTask.status
        });
      } else {
        debug.store('Task not found in store, adding', { id: updatedTask.id });
      }
      const tasks = state.tasks.map((task) =>
        task.id === updatedTask.id ? updatedTask : task
      );
      return {
        tasks,
        agents: reconcileAgentStatuses(state.agents, tasks),
      };
    });
  },
  addTask: (task) => {
    debug.store('addTask called', { id: task.id, title: task.title });
    set((state) => {
      // Dedupe: don't add if already exists
      if (state.tasks.some((t) => t.id === task.id)) {
        debug.store('Task already exists, skipping add', { id: task.id });
        return state;
      }
      const tasks = [task, ...state.tasks];
      return {
        tasks,
        agents: reconcileAgentStatuses(state.agents, tasks),
      };
    });
  },
  removeTask: (taskId) => {
    debug.store('removeTask called', { taskId });
    set((state) => {
      const tasks = state.tasks.filter((task) => task.id !== taskId);
      return {
        tasks,
        agents: reconcileAgentStatuses(state.agents, tasks),
      };
    });
  },

  // Agent mutations
  updateAgent: (updatedAgent) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === updatedAgent.id ? updatedAgent : agent
      ),
    })),
  addAgent: (agent) => set((state) => ({ agents: [...state.agents, agent] })),

  // OpenClaw actions
  setAgentOpenClawSession: (agentId, session) =>
    set((state) => ({
      agentOpenClawSessions: { ...state.agentOpenClawSessions, [agentId]: session },
    })),
  setOpenclawMessages: (messages) => set({ openclawMessages: messages }),
  addOpenclawMessage: (message) =>
    set((state) => ({ openclawMessages: [...state.openclawMessages, message] })),
}));

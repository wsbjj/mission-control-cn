'use client';

import {useEffect, useState} from 'react';
import {useParams} from 'next/navigation';
import {AgentActivityDashboard} from '@/components/AgentActivityDashboard';
import type {Workspace} from '@/lib/types';

export default function WorkspaceActivityPage() {
  const params = useParams(); // 读取动态路由参数 / Read dynamic route params
  const slug = params.slug as string; // 工作区标识符 / Workspace identifier
  const [workspace, setWorkspace] = useState<Workspace | null>(null); // 当前工作区数据 / Current workspace data

  useEffect(() => {
    async function loadWorkspace() {
      try {
        const res = await fetch(`/api/workspaces/${slug}`); // 加载活动页所需的工作区信息 / Load workspace info for activity page
        if (res.ok) {
          setWorkspace(await res.json()); // 更新本地状态 / Update local state
        }
      } catch (error) {
        console.error('Failed to load workspace for activity page:', error); // 错误日志输出 / Log error
      }
    }

    loadWorkspace(); // 触发加载 / Trigger loading
  }, [slug]);

  return <AgentActivityDashboard workspace={workspace} />; // 渲染智能体活动仪表盘 / Render agent activity dashboard
}


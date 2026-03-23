'use client';

import { useRef, useEffect, useMemo } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ProductHealthScore } from '@/lib/types';

// Tree-shaken ECharts registration
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  LegendComponent,
  CanvasRenderer,
]);

interface Props {
  history: ProductHealthScore[];
  component: 'overall' | 'research_freshness' | 'pipeline_depth' | 'swipe_velocity' | 'build_success' | 'cost_efficiency';
  label: string;
  color: string;
}

const SCORE_KEY_MAP: Record<string, keyof ProductHealthScore> = {
  overall: 'overall_score',
  research_freshness: 'research_freshness_score',
  pipeline_depth: 'pipeline_depth_score',
  swipe_velocity: 'swipe_velocity_score',
  build_success: 'build_success_score',
  cost_efficiency: 'cost_efficiency_score',
};

export function HealthChart({ history, component, label, color }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const data = useMemo(() => {
    const key = SCORE_KEY_MAP[component];
    return history.map((h) => ({
      date: h.snapshot_date || h.calculated_at?.split('T')[0] || '',
      value: (h[key] as number) ?? 0,
    }));
  }, [history, component]);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current, undefined, {
        renderer: 'canvas',
      });
    }

    const chart = instanceRef.current;

    const option: echarts.EChartsCoreOption = {
      animation: true,
      animationDuration: 800,
      animationEasing: 'cubicOut',
      grid: {
        top: 30,
        right: 16,
        bottom: 50,
        left: 40,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#161b22',
        borderColor: '#30363d',
        textStyle: { color: '#c9d1d9', fontSize: 12 },
        formatter: (params: unknown) => {
          const p = (params as { data: [string, number] }[])[0];
          return `<b>${p.data[0]}</b><br/>${label}: <b>${p.data[1]}</b>`;
        },
      },
      dataZoom: [
        {
          type: 'inside',
          start: 0,
          end: 100,
        },
        {
          type: 'slider',
          height: 20,
          bottom: 4,
          borderColor: '#30363d',
          backgroundColor: '#0d1117',
          fillerColor: 'rgba(88, 166, 255, 0.15)',
          handleStyle: { color: '#58a6ff' },
          textStyle: { color: '#8b949e', fontSize: 10 },
        },
      ],
      xAxis: {
        type: 'category',
        data: data.map((d) => d.date),
        axisLine: { lineStyle: { color: '#30363d' } },
        axisLabel: { color: '#8b949e', fontSize: 10 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLine: { lineStyle: { color: '#30363d' } },
        axisLabel: { color: '#8b949e', fontSize: 10 },
        splitLine: { lineStyle: { color: '#21262d' } },
      },
      series: [
        {
          type: 'line',
          data: data.map((d) => [d.date, d.value]),
          smooth: true,
          showSymbol: data.length <= 15,
          symbolSize: 6,
          lineStyle: { color, width: 2.5 },
          itemStyle: { color },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: color + '33' },
              { offset: 1, color: color + '05' },
            ]),
          },
        },
      ],
    };

    chart.setOption(option);

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [data, label, color]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  return (
    <div
      ref={chartRef}
      style={{ width: '100%', height: '220px' }}
    />
  );
}

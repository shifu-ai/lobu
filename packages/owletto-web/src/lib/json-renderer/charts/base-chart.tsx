import type { EChartsOption, SeriesOption } from 'echarts';
import { useMemo } from 'react';
import { useECharts } from '@/hooks/use-echarts';

export interface BaseChartProps {
  data: Array<{ label: string; value: number }>;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}

const DEFAULT_GRID = {
  left: 60,
  right: 30,
  top: 40,
  bottom: 60,
  containLabel: true,
};

/**
 * Shared chart component for simple category-value charts (line, bar, area).
 * Extracts common grid, axis config, and render pattern.
 */
export function BaseChart({
  data,
  height = 300,
  xLabel = '',
  yLabel = '',
  series,
  tooltip,
  xAxisExtra,
}: BaseChartProps & {
  series: SeriesOption[];
  tooltip?: EChartsOption['tooltip'];
  xAxisExtra?: Record<string, unknown>;
}) {
  const option: EChartsOption = useMemo(
    () => ({
      tooltip: tooltip ?? { trigger: 'axis' },
      grid: DEFAULT_GRID,
      xAxis: {
        type: 'category',
        data: data.map((d) => d.label),
        name: xLabel,
        nameLocation: 'middle',
        nameGap: 35,
        ...xAxisExtra,
      },
      yAxis: {
        type: 'value',
        name: yLabel,
        nameLocation: 'middle',
        nameGap: 45,
      },
      series,
    }),
    [data, xLabel, yLabel, series, tooltip, xAxisExtra]
  );

  const { chartRef } = useECharts({ option });

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}

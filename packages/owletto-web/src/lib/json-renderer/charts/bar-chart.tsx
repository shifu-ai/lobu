import { useMemo } from 'react';
import { BaseChart, type BaseChartProps } from './base-chart';

export type BarChartProps = BaseChartProps;

export function BarChart({ data, ...props }: BarChartProps) {
  const series = useMemo(
    () => [
      {
        type: 'bar' as const,
        data: data.map((d) => d.value),
        itemStyle: { color: '#6366f1' },
        barMaxWidth: 50,
      },
    ],
    [data]
  );

  const tooltip = useMemo(
    () => ({ trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } }),
    []
  );
  const xAxisExtra = useMemo(
    () => ({
      axisLabel: { rotate: data.length > 10 ? 45 : 0, interval: 0 },
    }),
    [data.length]
  );

  return (
    <BaseChart data={data} series={series} tooltip={tooltip} xAxisExtra={xAxisExtra} {...props} />
  );
}

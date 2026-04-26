import { useMemo } from 'react';
import { BaseChart, type BaseChartProps } from './base-chart';

export type LineChartProps = BaseChartProps;

export function LineChart({ data, ...props }: LineChartProps) {
  const series = useMemo(
    () => [
      {
        type: 'line' as const,
        data: data.map((d) => d.value),
        smooth: true,
        lineStyle: { color: '#6366f1', width: 2 },
        itemStyle: { color: '#6366f1' },
      },
    ],
    [data]
  );

  return <BaseChart data={data} series={series} xAxisExtra={{ boundaryGap: false }} {...props} />;
}

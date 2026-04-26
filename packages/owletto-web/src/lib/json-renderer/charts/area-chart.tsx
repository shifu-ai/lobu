import { useMemo } from 'react';
import { BaseChart, type BaseChartProps } from './base-chart';

export type AreaChartProps = BaseChartProps;

export function AreaChart({ data, ...props }: AreaChartProps) {
  const series = useMemo(
    () => [
      {
        type: 'line' as const,
        data: data.map((d) => d.value),
        smooth: true,
        areaStyle: {
          color: {
            type: 'linear' as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(99, 102, 241, 0.3)' },
              { offset: 1, color: 'rgba(99, 102, 241, 0.05)' },
            ],
          },
        },
        lineStyle: { color: '#6366f1', width: 2 },
        itemStyle: { color: '#6366f1' },
      },
    ],
    [data]
  );

  const tooltip = useMemo(
    () => ({ trigger: 'axis' as const, axisPointer: { type: 'cross' as const } }),
    []
  );

  return (
    <BaseChart
      data={data}
      series={series}
      tooltip={tooltip}
      xAxisExtra={{ boundaryGap: false }}
      {...props}
    />
  );
}

import type { EChartsOption } from 'echarts';
import { useMemo } from 'react';
import { useECharts } from '@/hooks/use-echarts';

export interface PieDataItem {
  name: string;
  value: number;
  itemStyle?: { color?: string };
}

export interface PieChartProps {
  data: PieDataItem[];
  height?: number;
  showLabel?: boolean;
  showLegend?: boolean;
  radius?: string | [string, string];
  highlightName?: string | null;
}

export function PieChart({
  data,
  height = 400,
  showLabel = true,
  showLegend = true,
  radius = ['50%', '70%'],
  highlightName = null,
}: PieChartProps) {
  const option: EChartsOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'item',
        formatter: '{a} <br/>{b}: {c} ({d}%)',
      },
      legend: {
        show: showLegend,
        orient: 'vertical',
        right: 10,
        top: 'middle',
        textStyle: {
          fontSize: 13,
        },
      },
      series: [
        {
          name: 'Distribution',
          type: 'pie',
          radius,
          center: showLegend ? ['40%', '50%'] : ['50%', '50%'],
          data: data.map((item) => ({
            ...item,
            itemStyle: {
              ...item.itemStyle,
              opacity: highlightName && item.name !== highlightName ? 0.3 : 1,
            },
          })),
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)',
            },
          },
          label: {
            show: showLabel,
            formatter: '{b}: {d}%',
          },
        },
      ],
    }),
    [data, showLabel, showLegend, radius, highlightName]
  );

  const { chartRef } = useECharts({ option });

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}

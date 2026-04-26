import type { EChartsOption } from 'echarts';
import { useCallback, useEffect, useMemo } from 'react';
import { useECharts } from '@/hooks/use-echarts';

export interface SeriesConfig {
  key: string;
  name: string;
  color?: string;
}

export interface StackedAreaChartProps {
  data: Array<Record<string, number | string>>;
  series: SeriesConfig[];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  onSeriesClick?: (seriesKey: string) => void;
  onDateRangeSelect?: (start: string, end: string) => void;
}

// Color palette for platforms
const platformColors: Record<string, string> = {
  reddit: '#FF4500',
  github: '#333333',
  trustpilot: '#00B67A',
  hackernews: '#FF6600',
  x: '#1DA1F2',
  ios_appstore: '#007AFF',
  google_play: '#34A853',
  glassdoor: '#0CAA41',
  g2: '#FF492C',
  capterra: '#FF6B35',
  gmaps: '#4285F4',
};

// Default colors for unknown platforms
const defaultColors = [
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#14b8a6',
];

function getColorForPlatform(key: string, index: number): string {
  return platformColors[key.toLowerCase()] || defaultColors[index % defaultColors.length];
}

export function StackedAreaChart({
  data,
  series,
  height = 180,
  xLabel = '',
  yLabel = '',
  onSeriesClick,
  onDateRangeSelect,
}: StackedAreaChartProps) {
  const option: EChartsOption = useMemo(() => {
    const chartSeries = series.map((s, i) => ({
      name: s.name,
      type: 'line' as const,
      stack: 'total',
      areaStyle: {
        opacity: 0.6,
      },
      emphasis: {
        focus: 'series' as const,
      },
      smooth: true,
      data: data.map((d) => d[s.key] ?? 0),
      itemStyle: {
        color: s.color || getColorForPlatform(s.key, i),
      },
      lineStyle: {
        width: 1,
        color: s.color || getColorForPlatform(s.key, i),
      },
    }));

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          label: {
            backgroundColor: '#6a7985',
          },
        },
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        data: series.map((s) => s.name),
        selectedMode: 'multiple',
      },
      grid: {
        left: 50,
        right: 20,
        top: 20,
        bottom: 60,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: data.map((d) => d.date),
        name: xLabel,
        nameLocation: 'middle',
        nameGap: 30,
        axisLabel: {
          formatter: (value: string) => {
            const date = new Date(value);
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
        },
      },
      yAxis: {
        type: 'value',
        name: yLabel,
        nameLocation: 'middle',
        nameGap: 40,
        minInterval: 1,
      },
      dataZoom: [
        {
          type: 'inside',
          start: 0,
          end: 100,
        },
        {
          type: 'slider',
          show: false,
        },
      ],
      series: chartSeries,
    };
  }, [data, series, xLabel, yLabel]);

  // Handle data zoom for date range selection
  const handleDataZoom = useCallback(
    (params: { start?: number; end?: number }) => {
      if (
        onDateRangeSelect &&
        data.length > 0 &&
        params.start !== undefined &&
        params.end !== undefined
      ) {
        const startIdx = Math.floor((params.start / 100) * data.length);
        const endIdx = Math.ceil((params.end / 100) * data.length) - 1;
        if (startIdx >= 0 && endIdx < data.length) {
          const startDate = data[startIdx]?.date as string;
          const endDate = data[endIdx]?.date as string;
          if (startDate && endDate) {
            onDateRangeSelect(startDate, endDate);
          }
        }
      }
    },
    [data, onDateRangeSelect]
  );

  const { chartRef, getInstance } = useECharts({ option, onDataZoom: handleDataZoom });

  // Set up legend click listener
  useEffect(() => {
    const chart = getInstance();
    if (!chart || !onSeriesClick) return;

    const handleLegendClick = (params: { selected: Record<string, boolean> }) => {
      const changedSeries = Object.entries(params.selected).find(
        ([, selected]) => selected === false
      );
      if (changedSeries) {
        const seriesConfig = series.find((s) => s.name === changedSeries[0]);
        if (seriesConfig) {
          onSeriesClick(seriesConfig.key);
        }
      }
    };

    chart.on('legendselectchanged', handleLegendClick as () => void);

    return () => {
      chart.off('legendselectchanged', handleLegendClick as () => void);
    };
  }, [getInstance, series, onSeriesClick]);

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}

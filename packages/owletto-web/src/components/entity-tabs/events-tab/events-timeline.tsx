import * as echarts from 'echarts';
import { useCallback, useEffect, useMemo } from 'react';
import { useECharts } from '@/hooks/use-echarts';
import { useContentDistribution } from '@/lib/api';

interface EventsTimelineProps {
  entityId: number;
  organizationId: string;
  ownerSlug: string;
  selectedRange?: [Date, Date];
  onSelectRange?: (start: Date, end: Date) => void;
}

function parseTimelineDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function EventsTimeline({
  entityId,
  organizationId,
  ownerSlug,
  selectedRange,
  onSelectRange,
}: EventsTimelineProps) {
  const {
    data: distribution,
    isLoading,
    error,
  } = useContentDistribution(
    organizationId,
    {
      entityId,
    },
    { slug: ownerSlug }
  );

  // Process data for weekly aggregation if > 6 months
  const processedData = useMemo(() => {
    if (!distribution || distribution.length === 0) return [];

    const normalizedData = distribution
      .map((row) => {
        const date = parseTimelineDate(row.date);
        if (!date) return null;
        return { date, count: row.count };
      })
      .filter((row): row is { date: Date; count: number } => row !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (normalizedData.length === 0) return [];

    const firstDate = normalizedData[0].date;
    const lastDate = normalizedData[normalizedData.length - 1].date;
    const daysDiff = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24);
    const useWeekly = daysDiff > 180;

    if (useWeekly) {
      const weekMap = new Map<string, number>();
      for (const row of normalizedData) {
        const weekStart = new Date(row.date);
        weekStart.setDate(row.date.getDate() - row.date.getDay());
        const weekKey = toDateKey(weekStart);
        weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + row.count);
      }
      return Array.from(weekMap.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }

    return normalizedData.map((row) => ({
      date: toDateKey(row.date),
      count: row.count,
    }));
  }, [distribution]);

  // Handle click on chart
  const handleClick = useCallback(
    (params: echarts.ECElementEvent) => {
      if (params.name && onSelectRange) {
        const clickedDate = new Date(params.name as string);
        const endDate = new Date(clickedDate);
        endDate.setDate(endDate.getDate() + 1);
        onSelectRange(clickedDate, endDate);
      }
    },
    [onSelectRange]
  );

  // Handle data zoom
  const handleDataZoom = useCallback(
    (params: { start?: number; end?: number; startValue?: number; endValue?: number }) => {
      if (onSelectRange && params.startValue !== undefined && params.endValue !== undefined) {
        const start = new Date(params.startValue);
        const end = new Date(params.endValue);
        onSelectRange(start, end);
      }
    },
    [onSelectRange]
  );

  const chartOption = useMemo(() => {
    if (processedData.length === 0) return null;

    // Create mark area for selected range
    let markArea: echarts.MarkAreaComponentOption['data'] | undefined;
    if (selectedRange) {
      const startStr = selectedRange[0].toISOString().split('T')[0];
      const endStr = selectedRange[1].toISOString().split('T')[0];
      markArea = [[{ xAxis: startStr }, { xAxis: endStr }]];
    }

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        formatter: (params: { name: string; value: number }[]) => {
          const d = params[0];
          const date = new Date(d.name);
          return `${date.toLocaleDateString()}: ${d.value} items`;
        },
      },
      grid: {
        left: 50,
        right: 20,
        top: 20,
        bottom: 60,
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: processedData.map((d) => d.date),
        axisLabel: {
          formatter: (value: string) => {
            const date = new Date(value);
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
        },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } },
      },
      dataZoom: [
        {
          type: 'slider',
          start: 0,
          end: 100,
          height: 20,
          bottom: 10,
          borderColor: 'transparent',
          backgroundColor: 'rgba(0,0,0,0.02)',
          fillerColor: 'rgba(99, 102, 241, 0.1)',
          handleStyle: {
            color: '#6366f1',
          },
        },
      ],
      series: [
        {
          type: 'line',
          smooth: true,
          areaStyle: {
            opacity: 0.3,
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(99, 102, 241, 0.5)' },
              { offset: 1, color: 'rgba(99, 102, 241, 0.05)' },
            ]),
          },
          lineStyle: { width: 2, color: '#6366f1' },
          itemStyle: { color: '#6366f1' },
          showSymbol: false,
          data: processedData.map((d) => d.count),
          markLine: {
            silent: true,
            symbol: 'none',
            label: {
              position: 'insideEndTop',
              formatter: 'avg: {c}',
              fontSize: 10,
              color: '#9ca3af',
            },
            lineStyle: {
              color: '#d1d5db',
              type: 'dashed',
              width: 1,
            },
            data: [{ type: 'average', name: 'Average' }],
          },
          markArea: markArea
            ? {
                silent: true,
                itemStyle: {
                  color: 'rgba(99, 102, 241, 0.1)',
                },
                data: markArea,
              }
            : undefined,
        },
      ],
    };
  }, [processedData, selectedRange]);

  const { chartRef, setOption } = useECharts({
    onClick: handleClick,
    onDataZoom: handleDataZoom,
  });

  useEffect(() => {
    if (chartOption) {
      setOption(chartOption as echarts.EChartsOption, true);
    }
  }, [chartOption, setOption]);

  // Always render the chart container to keep the ref attached
  // Hide content with overlay when loading or empty
  const showChart = !isLoading && !error && processedData.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4 relative">
      <div ref={chartRef} className="h-48 w-full" />
      {!showChart && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-muted/30 rounded-lg">
          {isLoading
            ? 'Loading timeline...'
            : error
              ? 'Failed to load timeline'
              : 'No timeline data available'}
        </div>
      )}
    </div>
  );
}

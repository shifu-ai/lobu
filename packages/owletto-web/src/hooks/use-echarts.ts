import type { ECharts, EChartsOption } from 'echarts';
import * as echarts from 'echarts';
import { useCallback, useEffect, useRef } from 'react';

interface UseEChartsOptions {
  /** Initial chart options */
  option?: EChartsOption;
  /** Whether to auto-resize on window resize */
  autoResize?: boolean;
  /** Chart theme - 'light' | 'dark' or custom theme object */
  theme?: string | object;
  /** Callback when chart is ready */
  onReady?: (chart: ECharts) => void;
  /** Click event handler */
  onClick?: (params: echarts.ECElementEvent) => void;
  /** Data zoom event handler */
  onDataZoom?: (params: {
    start?: number;
    end?: number;
    startValue?: number;
    endValue?: number;
  }) => void;
}

interface UseEChartsReturn {
  /** Ref to attach to the chart container div */
  chartRef: React.RefObject<HTMLDivElement | null>;
  /** Update chart options */
  setOption: (option: EChartsOption, notMerge?: boolean) => void;
  /** Get the chart instance */
  getInstance: () => ECharts | null;
  /** Manually trigger resize */
  resize: () => void;
  /** Clear the chart */
  clear: () => void;
}

/**
 * Hook for managing ECharts instance with automatic lifecycle handling.
 *
 * @example
 * ```tsx
 * const { chartRef, setOption } = useECharts({
 *   option: { ... },
 *   onClick: (params) => console.log(params),
 * });
 *
 * return <div ref={chartRef} style={{ width: '100%', height: 300 }} />;
 * ```
 */
export function useECharts(options: UseEChartsOptions = {}): UseEChartsReturn {
  const { option, autoResize = true, theme, onReady, onClick, onDataZoom } = options;

  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<ECharts | null>(null);

  // Initialize chart
  useEffect(() => {
    if (!chartRef.current) return;

    // Create chart instance
    chartInstance.current = echarts.init(chartRef.current, theme);

    // Set initial options if provided
    if (option) {
      chartInstance.current.setOption(option);
    }

    // Call onReady callback
    if (onReady) {
      onReady(chartInstance.current);
    }

    // Cleanup on unmount
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose();
        chartInstance.current = null;
      }
    };
  }, [theme, onReady, option]); // Only re-init if theme changes

  // Update options when they change
  useEffect(() => {
    if (chartInstance.current && option) {
      chartInstance.current.setOption(option, true);
    }
  }, [option]);

  // Handle click events
  useEffect(() => {
    if (!chartInstance.current || !onClick) return;

    chartInstance.current.on('click', onClick);

    return () => {
      chartInstance.current?.off('click', onClick);
    };
  }, [onClick]);

  // Handle data zoom events
  useEffect(() => {
    if (!chartInstance.current || !onDataZoom) return;

    const handler = (params: unknown) => {
      const p = params as {
        batch?: Array<{ start?: number; end?: number; startValue?: number; endValue?: number }>;
      };
      if (p.batch?.[0]) {
        onDataZoom(p.batch[0]);
      }
    };

    chartInstance.current.on('datazoom', handler);

    return () => {
      chartInstance.current?.off('datazoom', handler);
    };
  }, [onDataZoom]);

  // Handle resize
  useEffect(() => {
    if (!autoResize || !chartRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      chartInstance.current?.resize();
    });

    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [autoResize]);

  const setOption = useCallback((newOption: EChartsOption, notMerge = false) => {
    chartInstance.current?.setOption(newOption, notMerge);
  }, []);

  const getInstance = useCallback(() => {
    return chartInstance.current;
  }, []);

  const resize = useCallback(() => {
    chartInstance.current?.resize();
  }, []);

  const clear = useCallback(() => {
    chartInstance.current?.clear();
  }, []);

  return {
    chartRef,
    setOption,
    getInstance,
    resize,
    clear,
  };
}

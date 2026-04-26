export interface SparklineProps {
  data: number[];
  height?: number;
  width?: number;
  color?: string;
  trend?: 'up' | 'down' | 'stable';
}

export function Sparkline({
  data,
  height = 40,
  width = 100,
  color = '#6366f1',
  trend,
}: SparklineProps) {
  const lineColor = trend === 'up' ? '#ef4444' : trend === 'down' ? '#22c55e' : color;
  const values = data.length > 0 ? data : [0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;

  const points = values
    .map((value, index) => {
      const x = values.length > 1 ? index * stepX : width / 2;
      const y = height - ((value - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(' ');

  const areaPoints = `${points} ${width},${height} 0,${height}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-hidden="true"
      className="overflow-visible"
    >
      <polygon points={areaPoints} fill={lineColor} fillOpacity="0.12" />
      <polyline
        points={points}
        fill="none"
        stroke={lineColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

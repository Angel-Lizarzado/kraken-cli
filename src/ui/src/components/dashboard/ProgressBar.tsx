interface ProgressBarProps {
  percent: number;
  color: 'success' | 'warning' | 'error';
}

export default function ProgressBar({ percent, color }: ProgressBarProps) {
  return (
    <div className="bar">
      <div
        className={`bar__fill bar__fill--${color}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}

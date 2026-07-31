interface MetricRowProps {
  label: string;
  value: string;
}

export default function MetricRow({ label, value }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs" style={{ color: '#a5a5a5' }}>{label}</span>
      <span className="text-xs font-mono">{value}</span>
    </div>
  );
}

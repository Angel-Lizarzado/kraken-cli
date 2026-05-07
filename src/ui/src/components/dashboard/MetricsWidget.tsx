import { motion } from 'framer-motion';
import type { ServerDiagnostics } from '../../types/server';

interface MetricsWidgetProps {
  diagnostics: ServerDiagnostics;
}

interface GaugeData {
  label: string;
  value: number;
  max: number;
  unit: string;
}

function Gauge({ data }: { data: GaugeData }) {
  const pct = Math.min((data.value / data.max) * 100, 100);
  const color = pct > 90 ? 'var(--color-error)' : pct > 70 ? 'var(--color-warning)' : 'var(--color-success)';
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r={radius} fill="none" stroke="var(--surface-overlay)" strokeWidth="6" />
        <motion.circle
          cx="45" cy="45" r={radius}
          fill="none" stroke={color} strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: 'easeOut' }}
          transform="rotate(-90 45 45)"
        />
      </svg>
      <span className="text-lg font-bold font-mono">{Math.round(pct)}%</span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{data.label}</span>
    </div>
  );
}

export default function MetricsWidget({ diagnostics }: MetricsWidgetProps) {
  const gauges: GaugeData[] = [
    { label: 'CPU', value: diagnostics.cpu.load, max: diagnostics.cpu.cores * 100, unit: '%' },
    { label: 'RAM', value: diagnostics.ram.percent, max: 100, unit: '%' },
    { label: 'Disco', value: diagnostics.disk.percent, max: 100, unit: '%' },
  ];

  return (
    <div>
      {/* Circle gauges — detail breakdown lives in "Recursos en detalle" section */}
      <div className="grid grid-cols-3 gap-4">
        {gauges.map(g => (
          <Gauge key={g.label} data={g} />
        ))}
      </div>
    </div>
  );
}

export { Gauge };
export type { GaugeData };

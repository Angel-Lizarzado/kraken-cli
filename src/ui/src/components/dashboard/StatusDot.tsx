import type { ServerStatus } from '../../types/server';

interface StatusDotProps {
  status?: ServerStatus;
}

export default function StatusDot({ status }: StatusDotProps) {
  const cls =
    status === 'online' ? 'status-dot status-dot--online' :
    status === 'offline' ? 'status-dot status-dot--offline' :
    'status-dot status-dot--unknown';

  return <span className={cls} />;
}

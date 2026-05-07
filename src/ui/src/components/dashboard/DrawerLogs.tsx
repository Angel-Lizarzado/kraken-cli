import LogPanel from './LogPanel';

interface DrawerLogsProps {
  serverLogs: string | null;
  logsLoading: boolean;
  onRefreshLogs: () => void;
}

export default function DrawerLogs({ serverLogs, logsLoading, onRefreshLogs }: DrawerLogsProps) {
  return (
    <LogPanel
      logs={serverLogs}
      loading={logsLoading}
      onRefresh={onRefreshLogs}
    />
  );
}

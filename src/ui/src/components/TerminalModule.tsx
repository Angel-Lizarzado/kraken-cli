import LogConsole from './logs/LogConsole';
import type { LogBufferEntry } from '../hooks/useLogBuffer';

interface TerminalModuleProps {
  entries: LogBufferEntry[];
  onClear: () => void;
}

export default function TerminalModule({ entries, onClear }: TerminalModuleProps) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-xl font-bold">Terminal</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Consola de eventos en vivo del sistema
        </p>
      </div>

      <LogConsole
        entries={entries}
        onClear={onClear}
        maxHeight={600}
        rowHeight={28}
      />
    </div>
  );
}

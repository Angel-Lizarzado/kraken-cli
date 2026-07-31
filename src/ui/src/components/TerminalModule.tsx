import LogConsole from './logs/LogConsole';
import type { LogBufferEntry } from '../hooks/useLogBuffer';

interface TerminalModuleProps {
  entries: LogBufferEntry[];
  onClear: () => void;
}

export default function TerminalModule({ entries, onClear }: TerminalModuleProps) {
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      
      {/* ── Page Header ── */}
      <div className="flex-none px-lg pt-lg pb-md border-b border-outline-variant/30">
        <h2 className="font-display-lg text-display-lg text-secondary mb-xs">
          Terminal
        </h2>
        <p className="font-body-md text-on-surface-variant max-w-2xl">
          Consola de eventos en vivo del sistema
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-lg pb-lg mt-md">
        <div className="max-w-6xl mx-auto h-full flex flex-col">
          <div className="flex-1 rounded border border-outline-variant/50 overflow-hidden bg-black/40 shadow-2xl min-h-[600px]">
            <LogConsole
              entries={entries}
              onClear={onClear}
              maxHeight={800}
              rowHeight={24}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

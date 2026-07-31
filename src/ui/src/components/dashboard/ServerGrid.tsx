import ServerCard from './ServerCard';
import type { Server } from '../../types/server';

interface ServerGridProps {
  servers: Server[];
  selectedServer: Server | null;
  onSelectServer: (server: Server) => void;
  compact?: boolean;
}

export default function ServerGrid({ servers, selectedServer, onSelectServer, compact = false }: ServerGridProps) {
  return (
    <div
      className="grid"
      style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(350px, 1fr))',
        gap: '16px',
      }}
    >
      {servers.map((server) => (
        <ServerCard
          key={server.name}
          server={server}
          isSelected={selectedServer?.name === server.name}
          onSelect={onSelectServer}
        />
      ))}
    </div>
  );
}

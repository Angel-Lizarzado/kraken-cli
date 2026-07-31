import { useState, useCallback } from 'react';

interface LookupBarProps {
  onLookup: (domain: string) => Promise<{ success: boolean; ip?: string; hostName?: string | null; error?: string }>;
}

interface LookupResult {
  ip: string;
  hostName: string | null;
}

export default function LookupBar({ onLookup }: LookupBarProps) {
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleLookup = useCallback(async () => {
    const d = domain.trim();
    if (!d) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await onLookup(d);
      if (res.success && res.ip) {
        setResult({ ip: res.ip, hostName: res.hostName || null });
      } else {
        setError(res.error || 'Error al resolver dominio');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [domain, onLookup]);

  const handleClear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return (
    <div className="flex items-center gap-2" style={{ maxWidth: '520px' }}>
      <div className="flex items-center gap-2 flex-1 overflow-hidden" style={{ minWidth: 0 }}>
        <input
          type="text"
          value={domain}
          onFocus={handleClear}
          onChange={e => { setDomain(e.target.value); handleClear(); }}
          onKeyDown={e => { if (e.key === 'Enter') handleLookup(); }}
          placeholder="Verificar dominio (ej. abogada.es)..."
          className="w-full bg-surface-container-low border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
          style={{
            flex: '1 1 auto',
            minWidth: '120px',
            transition: 'flex 0.3s ease, width 0.3s ease',
          }}
        />
        <span
          className="lookup-badge text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{
            flex: result || error ? '0 0 auto' : '0 0 0px',
            maxWidth: result || error ? '200px' : '0px',
            opacity: result || error ? 1 : 0,
            overflow: 'hidden',
            transition: 'flex 0.3s ease, max-width 0.3s ease, opacity 0.25s ease',
            backgroundColor: error ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
            color: error ? '#ef4444' : '#22c55e',
          }}
        >
          {error
            ? error.length > 22 ? error.slice(0, 20) + '\u2026' : error
            : result
              ? `${result.ip}${result.hostName && result.hostName.length > 0 ? ` \u00B7 ${result.hostName.length > 20 ? result.hostName.slice(0, 18) + '\u2026' : result.hostName}` : ''}`
              : ''
          }
        </span>
      </div>
      <button
        onClick={handleLookup}
        disabled={loading || !domain.trim()}
        className="px-3 py-1.5 bg-surface-container border border-outline-variant text-on-surface rounded font-title-sm text-xs hover:bg-surface-container-high transition-all active:scale-95 disabled:opacity-50"
        style={{ minWidth: '80px', flexShrink: 0 }}
      >
        {loading ? (
          <span className="flex items-center gap-1.5">
            <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
            ...
          </span>
        ) : (
          'Identificar'
        )}
      </button>
    </div>
  );
}

/**
 * Kleiner Verlaufsgraph als SVG - fuer zwei Linien braucht es keine
 * Diagrammbibliothek. Die Linie endet am aktuellen Wert, daneben die Zahl.
 */
export function Spark({ values, max, label, value, tone }: {
  values: number[]; max: number; label: string; value: string; tone: 'cpu' | 'ram';
}) {
  const w = 160, h = 36;
  const stroke = tone === 'cpu' ? '#F2A93B' : '#5B9DF5';
  const top = Math.max(max, ...values, 1);
  const pts = values.map((v, i) => `${values.length === 1 ? w : (i / (values.length - 1)) * w},${h - (v / top) * (h - 3) - 1.5}`);
  const last = values.at(-1);
  const hot = last !== undefined && last / top > 0.9;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="min-w-0">
        <div className="text-xs text-dim">{label}</div>
        <div className={`text-sm font-medium tabular-nums ${hot ? 'text-led-crash' : 'text-ink'}`}>{value}</div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-32 sm:w-40 shrink-0" role="img" aria-label={`${label}-Verlauf`}>
        <line x1="0" x2={w} y1={h - 1} y2={h - 1} stroke="#2C3749" />
        {pts.length > 1 && <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />}
      </svg>
    </div>
  );
}

import { KNOWN_REGIONS } from '@vault-lookup/shared';

/**
 * Ordered region preference (plan §4.2). Order is the whole point — first place
 * wins ties — so this is a ranked list with explicit move controls rather than a
 * set of checkboxes.
 */
export function RegionPicker({
  value,
  onChange,
  strict,
  onStrictChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  strict: boolean;
  onStrictChange: (next: boolean) => void;
}) {
  const available = KNOWN_REGIONS.filter((r) => !value.includes(r));

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };

  return (
    <div>
      <ul className="region-list">
        {value.map((region, i) => (
          <li key={region}>
            <span className="rank">{i + 1}</span>
            <span className="name">{region}</span>
            <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up">
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, i + 1)}
              disabled={i === value.length - 1}
              title="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => onChange(value.filter((r) => r !== region))}
              title="Remove"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {value.length === 0 && (
        <p className="muted" style={{ margin: '6px 0 10px' }}>
          No regions chosen yet — pick at least one below.
        </p>
      )}

      {available.length > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...value, e.target.value]);
            }}
            style={{ maxWidth: 240 }}
          >
            <option value="">Add a region…</option>
            {available.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="row" style={{ marginTop: 12, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={strict}
          onChange={(e) => onStrictChange(e.target.checked)}
          style={{ width: 'auto' }}
        />
        <span>Strict — never match outside these regions</span>
      </label>
    </div>
  );
}

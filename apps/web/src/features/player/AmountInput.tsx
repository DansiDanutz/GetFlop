import { useEffect, useState } from 'react';
import { parsePoints, points } from '../../lib/format';

interface AmountInputProps {
  valueCents: number;
  onCommit: (cents: number) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Amount field: typing replaces the amount; an empty or invalid entry keeps the
 * last one. The value is committed on blur or Enter.
 */
export function AmountInput({ valueCents, onCommit, label, disabled, className }: AmountInputProps) {
  const [draft, setDraft] = useState(points(valueCents));
  useEffect(() => { setDraft(points(valueCents)); }, [valueCents]);
  const commit = () => {
    const cents = parsePoints(draft);
    if (cents === null || cents <= 0) { setDraft(points(valueCents)); return; }
    onCommit(cents);
  };
  return (
    <input
      className={className} aria-label={label} inputMode="decimal" disabled={disabled} value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d.,]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

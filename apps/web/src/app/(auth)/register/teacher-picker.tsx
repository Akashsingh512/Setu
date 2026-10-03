'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { cn, Input } from '@/components/ui';
import { searchTeachers, type TeacherOption } from './actions';

/** Searchable teacher combobox. Submits the chosen teacher id as `name`. */
export function TeacherPicker({ name }: { name: string }) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<TeacherOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<TeacherOption | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Debounced search; stale responses are ignored.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      const results = await searchTeachers(query);
      if (mine === seq.current) {
        setOptions(results);
        setActive(0);
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, open]);

  function choose(t: TeacherOption) {
    setSelected(t);
    setQuery(t.full_name);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input type="hidden" name={name} value={selected?.id ?? ''} />
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        placeholder="Type to search teachers…"
        value={query}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && options[active]) {
            e.preventDefault();
            choose(options[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {selected ? (
        <p className="mt-1 text-xs text-ok">
          Selected: {selected.full_name}
          {selected.team_name ? ` · ${selected.team_name}` : ''}
        </p>
      ) : null}
      {open ? (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line-strong bg-surface py-1 text-sm shadow-lg">
          {loading && options.length === 0 ? <li className="px-3 py-2 text-ink-muted">Searching…</li> : null}
          {!loading && options.length === 0 ? <li className="px-3 py-2 text-ink-muted">No teachers found</li> : null}
          {options.map((t, i) => (
            <li
              key={t.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={selected?.id === t.id}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(t);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('cursor-pointer px-3 py-2', i === active && 'bg-accent-soft')}
            >
              <span className="font-medium">{t.full_name}</span>
              {t.team_name ? <span className="text-ink-muted"> · {t.team_name}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

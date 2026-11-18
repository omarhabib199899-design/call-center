import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import "./CommandPalette.css";

// Ctrl/⌘ K: type to jump to any page in the menu
export default function CommandPalette({ open, onClose, items, onPick }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((i) => `${i.label} ${i.group || ""}`.toLowerCase().includes(t)) : items;
  }, [q, items]);

  if (!open) return null;

  const pick = (item) => {
    if (!item) return;
    onPick(item);
    onClose();
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      pick(results[sel]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="cp-backdrop" onMouseDown={onClose}>
      <div className="cp" role="dialog" aria-label="Jump to page" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-input">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            id="omni-command-search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            placeholder="Search pages…"
            aria-label="Search pages"
          />
        </div>
        <ul className="cp-list" role="listbox">
          {results.length === 0 && <li className="cp-empty">No page matches “{q}”</li>}
          {results.map((i, idx) => (
            <li key={i.id} role="option" aria-selected={idx === sel}>
              <button
                type="button"
                className={idx === sel ? "is-sel" : ""}
                onMouseEnter={() => setSel(idx)}
                onClick={() => pick(i)}
              >
                <span>{i.label}</span>
                {i.group && <span className="cp-group">{i.group}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

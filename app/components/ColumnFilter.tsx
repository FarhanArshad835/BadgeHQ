/**
 * A column's own filter, as a menu anchored to its header.
 *
 * Filters used to sit in a row above the table, naming the same columns the
 * header already named. This puts the control on the thing it controls.
 *
 * It is not a native select. The option lists here are short and known, and a
 * select's popup cannot be styled at all — it arrives with operating-system
 * chrome against a table that looks nothing like it.
 */
import { useEffect, useRef, useState } from "react";

export type FilterOption = { value: string; label: string };

export function ColumnFilter({
  label,
  value,
  onPick,
  any,
  options,
}: {
  /** The column's name, used for the accessible label. */
  label: string;
  value: string;
  onPick: (v: string) => void;
  /** What the empty value reads as, e.g. "Any carrier". */
  any: string;
  options: FilterOption[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const on = !!value;

  // Dismissed the way the date popover is: an outside click, Escape, or a
  // resize. The header is sticky, so a menu left open would detach from it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <span className="th-fw" ref={ref}>
      <button
        type="button"
        className={"th-filter" + (on ? " on" : "")}
        aria-label={`Filter ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>{"\u2261"}</span>
      </button>
      {open && (
        <div className="th-menu" role="menu">
          {[{ value: "", label: any }, ...options].map((o) => (
            <button
              key={o.value || "any"}
              type="button"
              role="menuitemradio"
              aria-checked={value === o.value}
              className={"th-opt" + (value === o.value ? " on" : "")}
              onClick={() => {
                onPick(o.value);
                setOpen(false);
              }}
            >
              <span className="tick" aria-hidden>
                {value === o.value ? "\u2713" : ""}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

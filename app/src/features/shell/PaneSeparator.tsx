import { useRef, type PointerEvent as ReactPointerEvent } from "react";

export function PaneSeparator({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
  direction = 1,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
  readonly onReset: () => void;
  readonly direction?: 1 | -1;
}) {
  const drag = useRef<{ startX: number; value: number } | null>(null);
  const set = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next))));
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startX: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <div
      className="studio-pane-separator"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        set(drag.current.value + (event.clientX - drag.current.startX) * direction);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        if (event.key === "ArrowLeft") set(value - step * direction);
        else if (event.key === "ArrowRight") set(value + step * direction);
        else if (event.key === "Home") set(min);
        else if (event.key === "End") set(max);
        else return;
        event.preventDefault();
      }}
    />
  );
}

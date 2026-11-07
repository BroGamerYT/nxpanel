import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, Info } from 'lucide-react';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  delayMs?: number;
  className?: string;
}

export function Tooltip({ content, children, side = 'top', delayMs = 120, className = '' }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timeoutRef = useRef<number | null>(null);

  const updatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 8;
    let x = 0;
    let y = 0;

    switch (side) {
      case 'bottom':
        x = rect.left + rect.width / 2;
        y = rect.bottom + gap;
        break;
      case 'left':
        x = rect.left - gap;
        y = rect.top + rect.height / 2;
        break;
      case 'right':
        x = rect.right + gap;
        y = rect.top + rect.height / 2;
        break;
      case 'top':
      default:
        x = rect.left + rect.width / 2;
        y = rect.top - gap;
        break;
    }

    // Viewport-Kanten absichern
    x = Math.max(12, Math.min(window.innerWidth - 12, x));
    setCoords({ x, y });
  };

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      updatePosition();
      setOpen(true);
    }, delayMs);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!content) return <>{children}</>;

  const transformStyle: Record<TooltipSide, string> = {
    top: 'translate(-50%, -100%)',
    bottom: 'translate(-50%, 0)',
    left: 'translate(-100%, -50%)',
    right: 'translate(0, -50%)',
  };

  return (
    <span
      ref={triggerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
      className={`inline-flex items-center ${className}`}
    >
      {children}
      {open &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: `${coords.x}px`,
              top: `${coords.y}px`,
              transform: transformStyle[side],
            }}
            className="z-[99999] pointer-events-none px-2.5 py-1.5 max-w-xs text-xs font-normal text-ink bg-rack border border-seam/80 shadow-2xl rounded-md backdrop-blur-md animate-in fade-in zoom-in-95 duration-150"
            role="tooltip"
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * Dezentes Fragezeichen- oder Info-Symbol mit Hover-Erklärung.
 * Eignet sich perfekt neben Bezeichnungen und Einstellungen.
 */
export function InfoTip({
  text,
  side = 'top',
  icon = 'help',
  className = '',
}: {
  text: ReactNode;
  side?: TooltipSide;
  icon?: 'help' | 'info';
  className?: string;
}) {
  const Icon = icon === 'info' ? Info : HelpCircle;
  return (
    <Tooltip content={text} side={side}>
      <span
        tabIndex={0}
        aria-label="Hilfe"
        className={`inline-flex items-center justify-center text-dim/70 hover:text-amber focus:text-amber cursor-help transition-colors outline-none ml-1 ${className}`}
      >
        <Icon className="size-3.5" />
      </span>
    </Tooltip>
  );
}

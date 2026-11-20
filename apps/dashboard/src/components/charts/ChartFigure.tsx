/**
 * Accessible chart frame.
 *
 * The plot is exposed as a single image (`role="img"`) with an `aria-label`
 * summary, because SVG charts are not navigable by screen readers. Every
 * chart has a "View as table" toggle that reveals the same data as an HTML
 * table, and a legend so colour is never the only cue.
 */
import { useId, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'square' | 'line' | 'dashed' | 'circle' | 'band';
  /** Short text glyph drawn instead of a swatch (e.g. marker icons). */
  glyph?: string;
}

export function Legend({ items, label = 'Legend' }: { items: readonly LegendItem[]; label?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="legend" aria-label={label}>
      {items.map((item) => (
        <li key={item.label} className="legend__item">
          {item.glyph !== undefined ? (
            <span className="legend__glyph" aria-hidden="true">
              {item.glyph}
            </span>
          ) : (
            <span
              className={`legend__swatch legend__swatch--${item.shape ?? 'square'}`}
              style={{ '--swatch': item.color } as CSSProperties}
              aria-hidden="true"
            />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface ChartFigureProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Text alternative describing what the chart shows and its key finding. */
  summary: string;
  /** Plot height in px. */
  height?: number;
  legend?: readonly LegendItem[];
  /** Tabular equivalent revealed by "View as table". */
  table: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3;
  testId?: string;
  className?: string;
}

export function ChartFigure({
  title,
  subtitle,
  summary,
  height = 280,
  legend,
  table,
  actions,
  children,
  headingLevel = 3,
  testId,
  className,
}: ChartFigureProps) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <figure className={`chart${className ? ` ${className}` : ''}`} data-testid={testId}>
      <div className="chart__head">
        <div>
          <Heading className="chart__title">{title}</Heading>
          {subtitle !== undefined && <p className="chart__subtitle">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="chart__actions">{actions}</div>}
      </div>
      <div className="chart__plot" role="img" aria-label={summary} style={{ height }}>
        {children}
      </div>
      {legend !== undefined && <Legend items={legend} />}
      <div className="chart__foot">
        <button
          type="button"
          className="btn btn--link"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'Hide table' : 'View as table'}
        </button>
      </div>
      <div id={tableId} hidden={!showTable} className="chart__table">
        {showTable ? table : null}
      </div>
    </figure>
  );
}

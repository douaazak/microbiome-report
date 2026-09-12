import { useState, type ReactNode } from 'react';

interface ExplainerProps {
  /** One line naming the question this analysis answers. */
  question: string;
  children: ReactNode;
}

/**
 * Collapsible explanation shown at the top of each analysis tab.
 *
 * Open by default: the audience is wet-lab researchers who may not have run
 * these analyses before, and a closed panel is a panel nobody reads. Anyone
 * who already knows can collapse it, and the choice is per-tab.
 */
export function Explainer({ question, children }: ExplainerProps) {
  const [open, setOpen] = useState(true);

  return (
    <div className={`explainer${open ? '' : ' collapsed'}`}>
      <button
        type="button"
        className="explainer-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="chevron">{open ? '▾' : '▸'}</span>
        {question}
      </button>
      {open && <div className="explainer-body">{children}</div>}
    </div>
  );
}

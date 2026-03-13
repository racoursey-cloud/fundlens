import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore.js';

const FLAG_MESSAGES = {
  mandateFallback:  'Macro alignment scores unavailable for some funds',
  momentumFallback: 'Price momentum data unavailable for some funds',
  sharpeFallback:   'Risk-adjusted returns unavailable for some funds',
  managerFallback:  'Manager quality scores unavailable for some funds',
  expenseFallback:  'Expense ratio data unavailable for some funds',
  holdingsFallback: 'Holdings data unavailable for some funds',
};

export default function DataQualityBanner() {
  const dataQuality = useAppStore(s => s.dataQuality);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !dataQuality) return null;

  const activeFlags = Object.keys(FLAG_MESSAGES).filter(k => dataQuality[k] === true);

  if (activeFlags.length === 0) return null;

  return (
    <div
      className="flex items-start gap-3 rounded-lg px-4 py-3 mb-4"
      style={{
        background:   '#1c1a10',
        borderLeft:   '3px solid #f59e0b',
        border:       '1px solid #3d3410',
        borderLeftColor: '#f59e0b',
      }}
    >
      {/* Amber warning icon */}
      <svg
        className="mt-0.5 shrink-0"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M8 1.5L14.928 13.5H1.072L8 1.5Z"
          stroke="#f59e0b"
          strokeWidth="1.25"
          strokeLinejoin="round"
          fill="none"
        />
        <path d="M8 6V9.5" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.5" r="0.75" fill="#f59e0b" />
      </svg>

      {/* Message list */}
      <div className="flex-1 min-w-0">
        <p
          className="text-xs font-semibold mb-1"
          style={{ color: '#fbbf24' }}
        >
          Some scores are using fallback values
        </p>
        <ul className="space-y-0.5">
          {activeFlags.map(flag => (
            <li
              key={flag}
              className="text-xs"
              style={{ color: '#9ca3af' }}
            >
              {FLAG_MESSAGES[flag]}
            </li>
          ))}
        </ul>
      </div>

      {/* Dismiss button */}
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded p-0.5 transition-colors"
        style={{ color: '#6b7280' }}
        onMouseEnter={e => (e.currentTarget.style.color = '#d1d5db')}
        onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
        aria-label="Dismiss"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

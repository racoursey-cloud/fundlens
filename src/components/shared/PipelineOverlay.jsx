import { useAppStore } from '../../store/useAppStore.js';

const STEP_LABELS = {
  1:  'Fetching economic data',
  2:  'Generating investment thesis',
  3:  'Loading fund holdings',
  4:  'Fetching price metrics',
  5:  'Analyzing expense ratios',
  6:  'Evaluating fund managers',
  7:  'Scoring mandate alignment',
  8:  'Computing final scores',
  9:  'Detecting outliers \u0026 computing allocation',
  10: 'Saving results',
};

const TOTAL_STEPS = 10;

export default function PipelineOverlay() {
  const { loading, pipelineStep, pipelineDetail } = useAppStore();

  if (!loading) return null;

  const stepLabel   = STEP_LABELS[pipelineStep] ?? 'Initializing\u2026';
  const displayStep = Math.min(Math.max(pipelineStep, 1), TOTAL_STEPS);
  const pct         = Math.round((displayStep / TOTAL_STEPS) * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(14, 15, 17, 0.85)', backdropFilter: 'blur(4px)' }}
      aria-live="polite"
      aria-label="Pipeline progress"
    >
      {/* Card */}
      <div
        className="flex flex-col gap-5 rounded-2xl px-8 py-8 shadow-2xl"
        style={{
          backgroundColor: '#16181c',
          border: '1px solid rgba(255,255,255,0.07)',
          minWidth: '340px',
          maxWidth: '420px',
          width: '90vw',
        }}
      >
        {/* Spinner + heading */}
        <div className="flex items-center gap-3">
          <Spinner />
          <span
            className="text-lg font-semibold tracking-tight text-white"
            style={{ fontFamily: 'Inter, sans-serif' }}
          >
            Analyzing your funds{'\u2026'}
          </span>
        </div>

        {/* Step label */}
        <div>
          <p
            className="text-sm font-medium text-white"
            style={{ fontFamily: 'Inter, sans-serif' }}
          >
            {stepLabel}
          </p>

          {/* Detail text */}
          {pipelineDetail ? (
            <p
              className="mt-1 text-xs leading-relaxed"
              style={{ color: '#6b7280', fontFamily: 'Inter, sans-serif' }}
            >
              {pipelineDetail}
            </p>
          ) : null}
        </div>

        {/* Progress bar */}
        <div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(90deg, #2563eb, #3b82f6)',
              }}
            />
          </div>

          {/* Step counter */}
          <p
            className="mt-1.5 text-right text-xs"
            style={{ color: '#4b5563', fontFamily: 'Inter, sans-serif' }}
          >
            Step {displayStep} of {TOTAL_STEPS}
          </p>
        </div>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => {
            const num     = i + 1;
            const done    = num < displayStep;
            const current = num === displayStep;
            return (
              <div
                key={num}
                className="rounded-full transition-all duration-300"
                style={{
                  width:  current ? '20px' : '6px',
                  height: '6px',
                  backgroundColor: done || current ? '#3b82f6' : 'rgba(255,255,255,0.12)',
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Inline spinner (no external deps) ──────────────────────────────────── */
function Spinner() {
  return (
    <svg
      className="shrink-0 animate-spin"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r="8"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="2.5"
      />
      <path
        d="M10 2a8 8 0 0 1 8 8"
        stroke="#3b82f6"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

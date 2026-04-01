// =============================================================================
// FundLens v5 — src/components/layout/DataQualityBanner.jsx
// Thin amber banner rendered below the tab bar when live data sources are
// partially unavailable.  Only visible when source === 'live' AND at least
// one of { fredOk, gdeltOk } is false in the dataQuality object.
// Returns null in all other states (seed data, loading, or all sources OK).
// =============================================================================

import useAppStore from '../../store/useAppStore.js';

export default function DataQualityBanner() {
  const { source, dataQuality } = useAppStore();

  // Only show on live data runs.
  if (source !== 'live') return null;

  // No quality report yet — nothing to flag.
  if (!dataQuality) return null;

  const { fredOk, gdeltOk } = dataQuality;

  // All sources healthy — stay silent.
  if (fredOk !== false && gdeltOk !== false) return null;

  // Build the degraded-source list for the detail line.
  const degraded = [];
  if (fredOk  === false) degraded.push('FRED economic data');
  if (gdeltOk === false) degraded.push('GDELT geopolitical news');

  const detailText = `Degraded: ${degraded.join(', ')}.`;

  return (
    <div style={{
      background:   'rgba(120, 53, 15, 0.20)',   // #78350f at 20% opacity
      borderBottom: '1px solid #92400e',
      padding:      '8px 20px',
      display:      'flex',
      alignItems:   'center',
      gap:          10,
      flexShrink:   0,
    }}>

      {/* Icon */}
      <span style={{
        fontSize:   15,
        color:      '#f59e0b',
        flexShrink: 0,
        lineHeight: 1,
      }}>
        ◑
      </span>

      {/* Main message */}
      <span style={{
        fontSize:    13,
        fontFamily:  'Inter, sans-serif',
        fontWeight:  600,
        color:       '#fbbf24',
        flexShrink:  0,
      }}>
        Partial live data — sector thesis may be less precise
      </span>

      {/* Separator */}
      <span style={{ color: '#92400e', flexShrink: 0, fontSize: 12 }}>·</span>

      {/* Detail */}
      <span style={{
        fontSize:   12,
        fontFamily: 'Inter, sans-serif',
        color:      '#d97706',
        fontWeight: 400,
      }}>
        {detailText}
      </span>

    </div>
  );
}

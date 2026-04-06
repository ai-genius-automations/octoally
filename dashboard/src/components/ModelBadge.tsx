/**
 * ModelBadge — small color-coded pill showing which backend handled a routing decision.
 *
 * Parses a route_decision event's data payload and renders:
 *   [RouteLabel] [confidence%]
 *
 * Color mapping:
 *   claude / claude_code_plan  → blue  (#60a5fa)
 *   gemini / gemini_*          → yellow (#facc15)
 *   deepthink / *deep*         → purple (#c084fc)
 *   haiku                      → green  (#34d399)
 *   default                    → slate  (#94a3b8)
 */

export interface RouteDecisionData {
  route?: string;
  provider_backend?: string;
  capability_lane?: string;
  execution_mode?: string;
  availability_status?: string;
  confidence?: number;
}

interface ModelBadgeColors {
  bg: string;
  text: string;
  dot: string;
}

function resolveColors(route: string): ModelBadgeColors {
  const r = route.toLowerCase();
  if (r.includes('deepthink') || r.includes('deep')) {
    return { bg: '#c084fc18', text: '#c084fc', dot: '#c084fc' };
  }
  if (r.includes('gemini')) {
    return { bg: '#facc1518', text: '#facc15', dot: '#facc15' };
  }
  if (r.includes('haiku')) {
    return { bg: '#34d39918', text: '#34d399', dot: '#34d399' };
  }
  if (r.includes('claude')) {
    return { bg: '#60a5fa18', text: '#60a5fa', dot: '#60a5fa' };
  }
  // fallback
  return { bg: '#94a3b818', text: '#94a3b8', dot: '#94a3b8' };
}

function formatLabel(route: string, backend?: string): string {
  // Prefer the backend label when it adds specificity
  const src = backend || route;
  // Strip snake_case underscores for display, title-case first word
  const parts = src.split('_');
  const first = parts[0];
  const display = first.charAt(0).toUpperCase() + first.slice(1);
  // Append the second part only if it meaningfully differs (e.g. "claude_code_plan" → "Claude Code")
  if (parts[1] && parts[1] !== 'code' && parts[1] !== parts[0]) {
    return `${display} ${parts[1].charAt(0).toUpperCase() + parts[1].slice(1)}`;
  }
  if (parts[1] === 'code') {
    return `${display} Code`;
  }
  return display;
}

interface ModelBadgeProps {
  data: RouteDecisionData;
  /** Show the confidence percentage next to the label. Default: true */
  showConfidence?: boolean;
}

export function ModelBadge({ data, showConfidence = true }: ModelBadgeProps) {
  const route = data.route || data.provider_backend || 'unknown';
  const { bg, text, dot } = resolveColors(route);
  const label = formatLabel(route, data.provider_backend);
  const pct = data.confidence != null ? Math.round(data.confidence * 100) : null;

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
      style={{ background: bg, color: text }}
      title={[
        `Route: ${route}`,
        data.provider_backend ? `Backend: ${data.provider_backend}` : '',
        data.execution_mode ? `Mode: ${data.execution_mode}` : '',
        data.availability_status ? `Status: ${data.availability_status}` : '',
        pct != null ? `Confidence: ${pct}%` : '',
      ].filter(Boolean).join('\n')}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: dot }}
      />
      {label}
      {showConfidence && pct != null && (
        <span style={{ opacity: 0.75 }}>{pct}%</span>
      )}
    </span>
  );
}

/**
 * Parse the raw JSON string stored in event.data and return routing fields,
 * or null if the event is not a route_decision or has no routing info.
 */
export function parseRouteDecision(eventType: string, rawData: string | null): RouteDecisionData | null {
  if (eventType !== 'route_decision') return null;
  if (!rawData) return null;
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>;
    if (!parsed.route && !parsed.provider_backend) return null;
    return {
      route: parsed.route as string | undefined,
      provider_backend: parsed.provider_backend as string | undefined,
      capability_lane: parsed.capability_lane as string | undefined,
      execution_mode: parsed.execution_mode as string | undefined,
      availability_status: parsed.availability_status as string | undefined,
      confidence: parsed.confidence as number | undefined,
    };
  } catch {
    return null;
  }
}

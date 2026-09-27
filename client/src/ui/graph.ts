/**
 * Graph window content: renders validated graph specs with Plotly.
 *
 * The spec comes from the LLM as plain JSON data (arrays, ranges, labels,
 * annotations) plus optional function strings, which are compiled through
 * the safe math parser in mathexpr.ts — never eval'd.
 */

import { compileFunction, isFinitePoint } from './mathexpr';

export interface GraphSpec {
  x?: number[];
  y?: number[] | number[][];
  functions?: string[];
  x_range?: [number, number];
  labels?: { x?: string; y?: string; title?: string };
  annotations?: { x: number; y: number; text: string }[];
  style?: { type?: 'line' | 'scatter' | 'bar'; show_points?: boolean };
}

const LINE_COLORS = ['#7aa2ff', '#ffb36b', '#7ee2a8', '#f28bb0', '#c9a0ff', '#ffd166'];

function sampleFunction(expr: string, x0: number, x1: number): { x: number[]; y: number[] } {
  const fn = compileFunction(expr);
  const xs: number[] = [];
  const ys: number[] = [];
  if (!fn) return { x: xs, y: ys };
  const n = 160;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = fn(x);
    if (isFinitePoint(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  return { x: xs, y: ys };
}

export async function renderGraph(container: HTMLElement, spec: GraphSpec): Promise<void> {
  const Plotly = (await import('plotly.js-dist-min')).default;
  const labels = spec.labels ?? {};
  const style = spec.style ?? {};
  const range = spec.x_range ?? [-6, 6];
  const mode = style.type === 'scatter' || style.show_points
    ? 'lines+markers'
    : style.type === 'bar' ? undefined : 'lines';

  const traces: Record<string, unknown>[] = [];
  let idx = 0;

  if (spec.functions?.length) {
    for (const expr of spec.functions.slice(0, 4)) {
      const { x, y } = sampleFunction(expr, range[0], range[1]);
      if (!x.length) continue;
      traces.push({
        x, y,
        type: 'scatter',
        mode: mode ?? 'lines',
        name: expr,
        line: { color: LINE_COLORS[idx % LINE_COLORS.length], width: 2.4 },
      });
      idx++;
    }
  } else {
    const x = spec.x ?? [];
    const ySeries = spec.y ?? [];
    const seriesList = Array.isArray(ySeries[0]) ? (ySeries as number[][]) : [ySeries as number[]];
    for (const ys of seriesList) {
      if (style.type === 'bar') {
        traces.push({
          x,
          y: ys,
          type: 'bar',
          marker: { color: LINE_COLORS[idx % LINE_COLORS.length] },
        });
      } else {
        traces.push({
          x,
          y: ys,
          type: 'scatter',
          mode: mode ?? 'lines',
          name: labels.y ?? undefined,
          line: { color: LINE_COLORS[idx % LINE_COLORS.length], width: 2.4 },
        });
      }
      idx++;
    }
  }

  const annotations = (spec.annotations ?? []).map((a) => ({
    x: a.x,
    y: a.y,
    text: a.text,
    showarrow: true,
    arrowhead: 2,
    ax: 0,
    ay: -34,
    font: { size: 12, color: '#e8eaf2' },
    arrowcolor: '#9aa1b5',
  }));

  const layout = {
    title: { text: labels.title ?? '', font: { size: 14, color: '#e8eaf2' } },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(255,255,255,0.02)',
    font: { color: '#9aa1b5', size: 11 },
    margin: { l: 46, r: 16, t: 34, b: 40 },
    xaxis: {
      title: { text: labels.x ?? '', font: { size: 11 } },
      gridcolor: 'rgba(255,255,255,0.08)',
      zerolinecolor: 'rgba(255,255,255,0.18)',
      linecolor: 'rgba(255,255,255,0.14)',
      range: spec.functions?.length ? range : undefined,
    },
    yaxis: {
      title: { text: labels.y ?? '', font: { size: 11 } },
      gridcolor: 'rgba(255,255,255,0.08)',
      zerolinecolor: 'rgba(255,255,255,0.18)',
      linecolor: 'rgba(255,255,255,0.14)',
    },
    showlegend: traces.length > 1,
    legend: { font: { size: 10, color: '#9aa1b5' }, orientation: 'h' as const, y: -0.14 },
    annotations,
    autosize: true,
  };

  await Plotly.newPlot(container, traces, layout, {
    displayModeBar: false,
    responsive: true,
  });
}

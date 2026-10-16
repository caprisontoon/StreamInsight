// Chart.js 래퍼: 테마 색상 적용, 페이지 이동 시 정리
import { PLATFORMS, compact, num } from './ui.js';

const instances = new Set();
const SERIES = ['#2f6bff', '#00b679', '#9146ff', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

export const seriesColor = (i) => SERIES[i % SERIES.length];
export const platformColor = (p) => PLATFORMS[p]?.color ?? '#888';

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function destroyCharts() {
  for (const c of instances) c.destroy();
  instances.clear();
}

export function alpha(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function baseOptions({ yFormat = compact, stacked = false, legend = true, tooltipFormat = num } = {}) {
  const grid = css('--grid');
  const text = css('--muted');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position: 'bottom', labels: { color: text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 } },
      tooltip: {
        backgroundColor: css('--tooltip-bg'),
        titleColor: css('--tooltip-fg'),
        bodyColor: css('--tooltip-fg'),
        padding: 10,
        cornerRadius: 8,
        usePointStyle: true,
        callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${tooltipFormat(ctx.parsed.y ?? ctx.parsed)}` },
      },
    },
    scales: {
      x: { stacked, grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkip: true, autoSkipPadding: 16 }, border: { color: grid } },
      y: { stacked, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: text, callback: (v) => yFormat(v) } },
    },
  };
}

export function lineChart(canvas, { labels, datasets, area = false, stacked = false, yFormat, tooltipFormat, legend = datasets.length > 1 }) {
  const chart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d, i) => {
        const color = d.color ?? seriesColor(i);
        return {
          label: d.label,
          data: d.data,
          borderColor: color,
          backgroundColor: area ? alpha(color, stacked ? 0.55 : 0.12) : color,
          fill: area ? (stacked ? (i === 0 ? 'origin' : '-1') : 'origin') : false,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          spanGaps: true,
          ...d.extra,
        };
      }),
    },
    options: baseOptions({ yFormat, stacked, legend, tooltipFormat }),
  });
  instances.add(chart);
  return chart;
}

export function barChart(canvas, { labels, datasets, stacked = false, horizontal = false, yFormat, tooltipFormat, legend = datasets.length > 1 }) {
  const opts = baseOptions({ yFormat, stacked, legend, tooltipFormat });
  if (horizontal) {
    opts.indexAxis = 'y';
    [opts.scales.x, opts.scales.y] = [
      { ...opts.scales.y, ticks: { ...opts.scales.y.ticks } },
      { ...opts.scales.x, ticks: { ...opts.scales.x.ticks, callback: undefined } },
    ];
    opts.plugins.tooltip.callbacks.label = (ctx) => ` ${ctx.dataset.label}: ${(tooltipFormat || num)(ctx.parsed.x)}`;
  }
  const chart = new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map((d, i) => ({
        label: d.label,
        data: d.data,
        backgroundColor: d.colors ?? d.color ?? seriesColor(i),
        borderRadius: 4,
        maxBarThickness: 36,
      })),
    },
    options: opts,
  });
  instances.add(chart);
  return chart;
}

export function doughnutChart(canvas, { labels, data, colors, format = num }) {
  const chart = new window.Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: css('--surface'), borderWidth: 3, hoverOffset: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--tooltip-bg'),
          titleColor: css('--tooltip-fg'),
          bodyColor: css('--tooltip-fg'),
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
              return ` ${ctx.label}: ${format(ctx.parsed)} (${((ctx.parsed / total) * 100).toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });
  instances.add(chart);
  return chart;
}

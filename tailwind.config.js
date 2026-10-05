/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), sunken: v('sunken'), line: v('line'), ink: v('ink'), muted: v('muted'), faint: v('faint'),
        brand: v('brand'), 'brand-ink': v('brand-ink'), 'brand-soft': v('brand-soft'),
        good: v('good'), 'good-soft': v('good-soft'), warn: v('warn'), 'warn-soft': v('warn-soft'), bad: v('bad'), 'bad-soft': v('bad-soft'),
        info: v('info'), 'info-soft': v('info-soft'),
      },
      fontFamily: {
        sans: ['"Public Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { DEFAULT: '6px' },
    },
  },
  plugins: [],
};

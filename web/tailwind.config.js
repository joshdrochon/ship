/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Linear-inspired neutral palette.
      //
      // Contrast is stated per token below and is measured, not assumed. The previous
      // blanket claim here -- "All colors meet WCAG 2.1 AA contrast requirements
      // (4.5:1 minimum)" -- was false for `accent` used as text: #005ea2 is the USWDS
      // logo blue, designed for white backgrounds, and it measures 2.55-2.89:1 on this
      // palette's dark surfaces where 4.5:1 is required (W7-1, 24 failing nodes).
      colors: {
        background: '#0d0d0d',
        foreground: '#f5f5f5',
        // 5.65:1 on #262626, 6.41:1 on #0d0d0d. Raised from #8a8a8a, which cleared 4.5:1
        // against `background` (5.1:1) but not against `border` as a surface (4.38:1) --
        // the token was only ever validated against one background (W7-2).
        muted: '#9e9e9e',
        border: '#262626',
        // Surface blue only: bg-accent / border-accent / ring-accent. White on #005ea2 is
        // 6.73:1, so changing this token would have broken every filled button.
        accent: '#005ea2',
        'accent-hover': '#0071bc',
      },
      // `accent` as *text* resolves to a lighter shade of the same USWDS blue ramp.
      // Splitting the utility rather than the token is what keeps bg-accent intact:
      // one config edit instead of rewriting 78 text-accent class names, and no filled
      // control changes colour.
      textColor: {
        accent: '#2491ff', // USWDS blue-40v -- 6.08:1 on #0d0d0d, 4.74:1 on #262626
        'accent-hover': '#58b4ff', // USWDS blue-30v -- 8.69:1 on #0d0d0d
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};

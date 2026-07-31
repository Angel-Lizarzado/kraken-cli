/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      "colors": {
        "on-primary-fixed": "#1c1b1c",
        "on-error": "#690005",
        "inverse-primary": "#5f5e5f",
        "surface-container-high": "#2b2a2a",
        "on-secondary": "#1000a9",
        "primary-container": "#0a0a0b",
        "tertiary-fixed-dim": "#d4aa50",
        "on-secondary-fixed-variant": "#2f2ebe",
        "primary": "#c8c6c7",
        "on-tertiary-container": "#d4aa50",
        "primary-fixed-dim": "#c8c6c7",
        "surface-tint": "#c8c6c7",
        "tertiary-container": "#2a200a",
        "background": "#141313",
        "on-surface-variant": "#c7c6ca",
        "secondary": "#c0c1ff",
        "surface-container-low": "#1c1b1b",
        "tertiary-fixed": "#f0c96a",
        "on-secondary-fixed": "#07006c",
        "surface": "#141313",
        "on-background": "#e5e2e1",
        "inverse-surface": "#e5e2e1",
        "error-container": "#93000a",
        "outline": "#919094",
        "surface-container-highest": "#353434",
        "on-error-container": "#ffdad6",
        "on-tertiary-fixed": "#1d1b19",
        "secondary-container": "#3131c0",
        "surface-container-lowest": "#0e0e0e",
        "surface-bright": "#3a3939",
        "primary-fixed": "#e5e2e3",
        "on-primary-container": "#7a797a",
        "surface-container": "#201f1f",
        "on-secondary-container": "#b0b2ff",
        "on-primary": "#313031",
        "on-tertiary": "#32302d",
        "on-surface": "#e5e2e1",
        "surface-dim": "#141313",
        "secondary-fixed": "#e1e0ff",
        "outline-variant": "#46464a",
        "inverse-on-surface": "#313030",
        "secondary-fixed-dim": "#c0c1ff",
        "on-primary-fixed-variant": "#474647",
        "tertiary": "#d4aa50",
        "error": "#ffb4ab",
        "on-tertiary-fixed-variant": "#494643",
        "surface-variant": "#353434"
      },
      "borderRadius": {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "0.75rem"
      },
      "spacing": {
        "xs": "4px",
        "gutter": "12px",
        "md": "16px",
        "lg": "24px",
        "sidebar_expanded": "240px",
        "sm": "8px",
        "sidebar_width": "64px",
        "unit": "4px",
        "xl": "32px"
      },
      "fontFamily": {
        "display-lg": ["Geist", "sans-serif"],
        "body-sm": ["Geist", "sans-serif"],
        "code-md": ["JetBrains Mono", "monospace"],
        "headline-md": ["Geist", "sans-serif"],
        "title-sm": ["Geist", "sans-serif"],
        "code-sm": ["JetBrains Mono", "monospace"],
        "label-caps": ["JetBrains Mono", "monospace"],
        "body-md": ["Geist", "sans-serif"]
      },
      "fontSize": {
        "display-lg": ["32px", {"lineHeight": "40px", "letterSpacing": "-0.02em", "fontWeight": "600"}],
        "body-sm": ["12px", {"lineHeight": "16px", "fontWeight": "400"}],
        "code-md": ["13px", {"lineHeight": "20px", "fontWeight": "400"}],
        "headline-md": ["24px", {"lineHeight": "32px", "letterSpacing": "-0.01em", "fontWeight": "600"}],
        "title-sm": ["16px", {"lineHeight": "24px", "fontWeight": "500"}],
        "code-sm": ["11px", {"lineHeight": "16px", "fontWeight": "400"}],
        "label-caps": ["10px", {"lineHeight": "12px", "letterSpacing": "0.05em", "fontWeight": "700"}],
        "body-md": ["14px", {"lineHeight": "20px", "fontWeight": "400"}]
      }
    }
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries')
  ]
}

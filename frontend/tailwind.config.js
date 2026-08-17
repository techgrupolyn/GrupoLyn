/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'main-bg': '#0D0D0D',
        'surface': '#141414',
        'border': '#2E2E2E',
        'primary-text': '#F2F2F2',
        'secondary-text': '#737373',
        'accent': '#BFBFBF',
      },
    },
  },
  plugins: [],
};

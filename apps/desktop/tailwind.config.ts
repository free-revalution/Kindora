import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        kindora: {
          50: '#f5f7fb',
          100: '#e8eef7',
          200: '#cdd9ec',
          300: '#a4bad8',
          400: '#7395be',
          500: '#4f7aa6',
          600: '#3c608a',
          700: '#324d6e',
          800: '#2c4159',
          900: '#1a2533',
          950: '#10171f',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;

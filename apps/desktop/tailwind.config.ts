import type { Config } from 'tailwindcss';

/**
 * Editorial utilitarian palette (taste-skill / minimalist-ui).
 * Warm monochrome + scarce pastel accents. No teal, no violet, no glow.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        kindora: {
          50: '#FBFBFA',
          100: '#F7F6F3',
          200: '#EAEAEA',
          300: '#D4D3CF',
          400: '#A8A7A2',
          500: '#787774',
          600: '#5C5B58',
          700: '#3F3E3B',
          800: '#2F3437',
          900: '#1C1C1A',
          950: '#111111',
        },
        accent: {
          DEFAULT: '#111111',
          dim: '#333333',
          muted: '#F7F6F3',
        },
        pastel: {
          green: '#EDF3EC',
          greenInk: '#346538',
          blue: '#E1F3FE',
          blueInk: '#1F6C9F',
          red: '#FDEBEC',
          redInk: '#9F2F2D',
          yellow: '#FBF3DB',
          yellowInk: '#956400',
        },
      },
      fontFamily: {
        sans: [
          '"Public Sans"',
          '"Helvetica Neue"',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
        display: ['Newsreader', 'Georgia', 'Songti SC', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '6px',
      },
      boxShadow: {
        lift: '0 2px 8px rgba(0,0,0,0.04)',
      },
      keyframes: {
        enter: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        enter: 'enter 600ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
} satisfies Config;

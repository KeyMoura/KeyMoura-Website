import type { Config } from "tailwindcss";
import { colors as themeColors } from "./src/theme/tokens";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: themeColors.primary,
          primarySoft: themeColors.primarySoft,
          accent: themeColors.accent,
          accentSoft: themeColors.accentSoft,
          bgStart: themeColors.bgStart,
          bgEnd: themeColors.bgEnd,
          text: themeColors.text,
          textMuted: themeColors.textMuted,
        },
      },
    },
  },
  plugins: [],
};

export default config;

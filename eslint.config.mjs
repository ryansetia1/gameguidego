import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  {
    ignores: [".next/**", "out/**", "node_modules/**", "android/**", "public/**", "next-env.d.ts"],
  },
  {
    rules: {
      // React Compiler rules that arrived with eslint-plugin-react-hooks 7 (Next 16).
      // `next lint` never enforced them; the code predates them and flags 51 + 7
      // places across 30 files. Fixing means reworking effects and refs, which
      // can change behavior, so they stay off until a dedicated refactor.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },
];

export default config;

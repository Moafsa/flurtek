// Regimes tributários selecionáveis. Arquivo sem dependências para poder ser usado também na tela.
export const REGIMES = {
  SIMPLES_NACIONAL: { label: "Simples Nacional", crt: 1, taxCode: "CSOSN" },
  MEI: { label: "MEI", crt: 4, taxCode: "CSOSN" },
  LUCRO_PRESUMIDO: { label: "Lucro Presumido", crt: 3, taxCode: "CST" },
  LUCRO_REAL: { label: "Lucro Real", crt: 3, taxCode: "CST" },
} as const;
export type Regime = keyof typeof REGIMES;
export const REGIME_KEYS = Object.keys(REGIMES) as [Regime, ...Regime[]];

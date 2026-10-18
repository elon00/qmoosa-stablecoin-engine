export interface CollateralConfig {
  token: string;
  symbol: string;
  decimals: number;
  minCollateralRatioBps: bigint; // e.g., 15000n = 150%
  liquidationPenaltyBps: bigint; // e.g., 1000n = 10%
  stabilityFeeBps: bigint;       // e.g., 200n = 2% APR
  debtCeiling: bigint;           // max QUSD debt
  totalDebtIssued: bigint;
  isPaused: boolean;
}

export interface VaultPosition {
  vaultId: string;
  owner: string;
  collateralToken: string;
  collateralAmount: bigint;
  debtAmount: bigint;
  accruedInterest: bigint;
  lastAccrualTimestamp: number;
  updatedAt: number;
}

export interface VaultHealth {
  vaultId: string;
  collateralValueWad: bigint;
  totalDebtWad: bigint;
  collateralRatioBps: bigint;
  isSolvent: boolean;
  isLiquidatable: boolean;
  maxMintableAdditionalDebt: bigint;
}

export interface LiquidationQuote {
  vaultId: string;
  debtToRepay: bigint;
  collateralToSeize: bigint;
  penaltyCollateral: bigint;
  collateralReturnedToOwner: bigint;
}

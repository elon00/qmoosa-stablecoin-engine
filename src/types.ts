export * from "./interfaces.js";
export * from "./math.js";

export type AdminActionType =
  | "SET_COLLATERAL_CONFIG"
  | "SET_ORACLE_PRICE"
  | "OVERRIDE_ORACLE_PRICE"
  | "SET_PAUSED"
  | "SET_DEBT_CEILING";

export interface OraclePriceFeed {
  priceWad: bigint;
  updatedAt: number;
}

export interface SignedAdminIntent {
  action: AdminActionType;
  params: Record<string, any>;
  nonce: number;
  deadline: number;
  domain: string;
  signature: string;
}

export interface VaultOperationResult {
  txId: string;
  vaultId: string;
  operation: "OPEN" | "DEPOSIT" | "WITHDRAW" | "MINT" | "REPAY" | "LIQUIDATE";
  actor: string;
  collateralToken: string;
  collateralDelta: bigint;
  debtDelta: bigint;
  collateralRatioAfterBps: bigint;
  timestamp: number;
  success: boolean;
}

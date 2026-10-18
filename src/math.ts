export const BPS_DIVISOR = 10000n;
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31536000n;

/**
 * Normalizes collateral token amount into USD value with 18 decimal places (WAD)
 */
export function calculateCollateralValue(
  collateralAmount: bigint,
  priceWad: bigint,
  decimals: number = 18
): bigint {
  if (collateralAmount < 0n || priceWad < 0n) {
    throw new RangeError("NEGATIVE_VALUE: Amounts and prices must be non-negative");
  }
  if (decimals < 0 || decimals > 36) {
    throw new RangeError("INVALID_DECIMALS: Decimals must be between 0 and 36");
  }
  return (collateralAmount * priceWad) / (10n ** BigInt(decimals));
}

/**
 * Computes collateralization ratio in basis points (e.g. 15000 bps = 150%)
 */
export function calculateCollateralRatio(
  collateralValueWad: bigint,
  totalDebtWad: bigint
): bigint {
  if (collateralValueWad < 0n || totalDebtWad < 0n) {
    throw new RangeError("NEGATIVE_VALUE: Collateral value and debt must be non-negative");
  }
  if (totalDebtWad === 0n) {
    return 100000000n; // Infinite ratio when debt is 0
  }
  return (collateralValueWad * BPS_DIVISOR) / totalDebtWad;
}

/**
 * Determines maximum additional stablecoin debt mintable without violating minimum collateral ratio
 */
export function calculateMaxMintableDebt(
  collateralValueWad: bigint,
  minCollateralRatioBps: bigint,
  currentDebtWad: bigint = 0n
): bigint {
  if (minCollateralRatioBps < 10000n) {
    throw new RangeError("INVALID_MIN_RATIO: Minimum collateral ratio must be at least 10000 bps (100%)");
  }
  if (collateralValueWad < 0n || currentDebtWad < 0n) {
    throw new RangeError("NEGATIVE_VALUE: Inputs must be non-negative");
  }

  const maxTotalDebt = (collateralValueWad * BPS_DIVISOR) / minCollateralRatioBps;
  if (maxTotalDebt <= currentDebtWad) {
    return 0n;
  }
  return maxTotalDebt - currentDebtWad;
}

/**
 * Computes continuous stability fee interest accrued on outstanding debt over an elapsed time window
 */
export function calculateStabilityFeeAccrual(
  principalDebt: bigint,
  stabilityFeeBps: bigint,
  elapsedSeconds: bigint
): bigint {
  if (principalDebt < 0n || stabilityFeeBps < 0n || elapsedSeconds < 0n) {
    throw new RangeError("NEGATIVE_VALUE: Parameters must be non-negative");
  }
  if (principalDebt === 0n || stabilityFeeBps === 0n || elapsedSeconds === 0n) {
    return 0n;
  }

  return (principalDebt * stabilityFeeBps * elapsedSeconds) / (BPS_DIVISOR * SECONDS_PER_YEAR);
}

/**
 * Calculates collateral to seize during liquidation, including penalty reward for liquidator
 */
export function calculateLiquidationSeizure(
  debtToRepay: bigint,
  priceWad: bigint,
  collateralDecimals: number = 18,
  liquidationPenaltyBps: bigint = 1000n // default 10%
): { collateralToSeize: bigint; penaltyCollateral: bigint } {
  if (debtToRepay <= 0n) {
    throw new RangeError("INSUFFICIENT_DEBT_TO_REPAY: Repayment debt must be strictly positive");
  }
  if (priceWad <= 0n) {
    throw new RangeError("INVALID_PRICE: Collateral price must be strictly positive");
  }
  if (liquidationPenaltyBps < 0n || liquidationPenaltyBps > 5000n) {
    throw new RangeError("INVALID_PENALTY: Liquidation penalty must be between 0 and 5000 bps");
  }

  const repayValueWithPenalty = (debtToRepay * (BPS_DIVISOR + liquidationPenaltyBps)) / BPS_DIVISOR;
  const collateralToSeize = (repayValueWithPenalty * (10n ** BigInt(collateralDecimals))) / priceWad;
  const penaltyCollateral = (collateralToSeize * liquidationPenaltyBps) / (BPS_DIVISOR + liquidationPenaltyBps);

  return { collateralToSeize, penaltyCollateral };
}

/**
 * Evaluates whether a vault is currently solvent against the minimum collateral ratio
 */
export function isVaultSolvent(
  collateralValueWad: bigint,
  totalDebtWad: bigint,
  minRatioBps: bigint
): boolean {
  if (totalDebtWad === 0n) {
    return true;
  }
  const ratio = calculateCollateralRatio(collateralValueWad, totalDebtWad);
  return ratio >= minRatioBps;
}

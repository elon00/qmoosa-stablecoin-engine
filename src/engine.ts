import crypto from "node:crypto";
import {
  CollateralConfig,
  VaultPosition,
  VaultHealth,
  VaultOperationResult,
  SignedAdminIntent,
  calculateCollateralValue,
  calculateCollateralRatio,
  calculateMaxMintableDebt,
  calculateStabilityFeeAccrual,
  calculateLiquidationSeizure,
  isVaultSolvent,
  BPS_DIVISOR,
  WAD
} from "./types.js";
import { AdminAuthManager } from "./auth.js";

export class StablecoinEngine {
  private readonly vaults: Map<string, VaultPosition> = new Map();
  private readonly collaterals: Map<string, CollateralConfig> = new Map();
  private readonly oraclePrices: Map<string, bigint> = new Map();
  private readonly authManager: AdminAuthManager;
  private readonly chainId: number;
  private vaultCounter: number = 0;

  // Mock ledger balances for simulation and testing
  private readonly collateralBalances: Map<string, bigint> = new Map(); // "user:token" -> balance
  private readonly stablecoinBalances: Map<string, bigint> = new Map(); // "user" -> balance
  private protocolFeesAccrued: bigint = 0n;

  constructor(adminPublicKey: string, chainId: number = 31337) {
    this.authManager = new AdminAuthManager(adminPublicKey, chainId);
    this.chainId = chainId;
  }

  public registerCollateralDirect(config: CollateralConfig): void {
    this.collaterals.set(config.token, { ...config });
  }

  public setOraclePriceDirect(token: string, priceWad: bigint): void {
    if (priceWad <= 0n) {
      throw new RangeError("INVALID_ORACLE_PRICE: Price must be strictly positive");
    }
    this.oraclePrices.set(token, priceWad);
  }

  public setUserCollateralBalance(user: string, token: string, balance: bigint): void {
    this.collateralBalances.set(`${user}:${token}`, balance);
  }

  public getUserCollateralBalance(user: string, token: string): bigint {
    return this.collateralBalances.get(`${user}:${token}`) ?? 0n;
  }

  public setUserStablecoinBalance(user: string, balance: bigint): void {
    this.stablecoinBalances.set(user, balance);
  }

  public getUserStablecoinBalance(user: string): bigint {
    return this.stablecoinBalances.get(user) ?? 0n;
  }

  public getVault(vaultId: string): VaultPosition | undefined {
    return this.vaults.get(vaultId);
  }

  public getAllVaults(): VaultPosition[] {
    return Array.from(this.vaults.values());
  }

  public getCollateralConfig(token: string): CollateralConfig | undefined {
    return this.collaterals.get(token);
  }

  public executeAdminIntent(intent: SignedAdminIntent): void {
    this.authManager.verifyAndConsume(intent);

    switch (intent.action) {
      case "SET_COLLATERAL_CONFIG": {
        const { token, symbol, decimals, minCollateralRatioBps, liquidationPenaltyBps, stabilityFeeBps, debtCeiling } = intent.params;
        const existing = this.collaterals.get(token);
        this.collaterals.set(token, {
          token,
          symbol,
          decimals: Number(decimals),
          minCollateralRatioBps: BigInt(minCollateralRatioBps),
          liquidationPenaltyBps: BigInt(liquidationPenaltyBps),
          stabilityFeeBps: BigInt(stabilityFeeBps),
          debtCeiling: BigInt(debtCeiling),
          totalDebtIssued: existing ? existing.totalDebtIssued : 0n,
          isPaused: false
        });
        break;
      }
      case "SET_ORACLE_PRICE": {
        const { token, priceWad } = intent.params;
        this.setOraclePriceDirect(token, BigInt(priceWad));
        break;
      }
      case "SET_PAUSED": {
        const { token, paused } = intent.params;
        const config = this.collaterals.get(token);
        if (config) {
          config.isPaused = Boolean(paused);
        }
        break;
      }
      case "SET_DEBT_CEILING": {
        const { token, debtCeiling } = intent.params;
        const config = this.collaterals.get(token);
        if (config) {
          config.debtCeiling = BigInt(debtCeiling);
        }
        break;
      }
      default:
        throw new Error(`UNKNOWN_ADMIN_ACTION: ${(intent as any).action}`);
    }
  }

  public openVault(owner: string, collateralToken: string): VaultPosition {
    if (!owner || owner === "0x0000000000000000000000000000000000000000") {
      throw new Error("INVALID_OWNER_ADDRESS");
    }
    const config = this.collaterals.get(collateralToken);
    if (!config || config.isPaused) {
      throw new Error("COLLATERAL_NOT_SUPPORTED_OR_PAUSED");
    }

    this.vaultCounter++;
    const vaultId = `vault_${this.vaultCounter}`;
    const now = Math.floor(Date.now() / 1000);

    const vault: VaultPosition = {
      vaultId,
      owner,
      collateralToken,
      collateralAmount: 0n,
      debtAmount: 0n,
      accruedInterest: 0n,
      lastAccrualTimestamp: now,
      updatedAt: now
    };

    this.vaults.set(vaultId, vault);
    return vault;
  }

  public depositCollateral(vaultId: string, owner: string, amount: bigint): VaultOperationResult {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("VAULT_DOES_NOT_EXIST");
    if (amount <= 0n) throw new RangeError("DEPOSIT_AMOUNT_MUST_BE_POSITIVE");

    const userKey = `${owner}:${vault.collateralToken}`;
    const currentBalance = this.collateralBalances.get(userKey) ?? 0n;
    if (currentBalance < amount) {
      throw new Error("INSUFFICIENT_USER_COLLATERAL_BALANCE");
    }

    this.accrueInterest(vault);

    this.collateralBalances.set(userKey, currentBalance - amount);
    vault.collateralAmount += amount;
    vault.updatedAt = Math.floor(Date.now() / 1000);

    const health = this.getVaultHealth(vaultId);

    return {
      txId: `tx_dep_${crypto.randomBytes(8).toString("hex")}`,
      vaultId,
      operation: "DEPOSIT",
      actor: owner,
      collateralToken: vault.collateralToken,
      collateralDelta: amount,
      debtDelta: 0n,
      collateralRatioAfterBps: health.collateralRatioBps,
      timestamp: vault.updatedAt,
      success: true
    };
  }

  public withdrawCollateral(vaultId: string, owner: string, amount: bigint): VaultOperationResult {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("VAULT_DOES_NOT_EXIST");
    if (vault.owner !== owner) throw new Error("NOT_VAULT_OWNER");
    if (amount <= 0n || amount > vault.collateralAmount) throw new RangeError("INVALID_WITHDRAW_AMOUNT");

    this.accrueInterest(vault);

    // Tentatively deduct collateral
    vault.collateralAmount -= amount;
    const health = this.getVaultHealth(vaultId);

    if (vault.debtAmount > 0n && !health.isSolvent) {
      // Revert mutation atomically
      vault.collateralAmount += amount;
      throw new Error("WITHDRAWAL_BREAKS_SOLVENCY");
    }

    const userKey = `${owner}:${vault.collateralToken}`;
    const currentBalance = this.collateralBalances.get(userKey) ?? 0n;
    this.collateralBalances.set(userKey, currentBalance + amount);
    vault.updatedAt = Math.floor(Date.now() / 1000);

    return {
      txId: `tx_wth_${crypto.randomBytes(8).toString("hex")}`,
      vaultId,
      operation: "WITHDRAW",
      actor: owner,
      collateralToken: vault.collateralToken,
      collateralDelta: -amount,
      debtDelta: 0n,
      collateralRatioAfterBps: health.collateralRatioBps,
      timestamp: vault.updatedAt,
      success: true
    };
  }

  public mintStablecoin(vaultId: string, owner: string, amount: bigint): VaultOperationResult {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("VAULT_DOES_NOT_EXIST");
    if (vault.owner !== owner) throw new Error("NOT_VAULT_OWNER");
    if (amount <= 0n) throw new RangeError("MINT_AMOUNT_MUST_BE_POSITIVE");

    const config = this.collaterals.get(vault.collateralToken);
    if (!config || config.isPaused) throw new Error("COLLATERAL_PAUSED");

    if (config.totalDebtIssued + amount > config.debtCeiling) {
      throw new Error("DEBT_CEILING_BREACHED");
    }

    this.accrueInterest(vault);

    // Tentatively add debt
    vault.debtAmount += amount;
    const health = this.getVaultHealth(vaultId);

    if (!health.isSolvent) {
      // Rollback debt addition atomically
      vault.debtAmount -= amount;
      throw new Error("MINT_BREAKS_SOLVENCY");
    }

    config.totalDebtIssued += amount;
    const currentStable = this.stablecoinBalances.get(owner) ?? 0n;
    this.stablecoinBalances.set(owner, currentStable + amount);
    vault.updatedAt = Math.floor(Date.now() / 1000);

    return {
      txId: `tx_mnt_${crypto.randomBytes(8).toString("hex")}`,
      vaultId,
      operation: "MINT",
      actor: owner,
      collateralToken: vault.collateralToken,
      collateralDelta: 0n,
      debtDelta: amount,
      collateralRatioAfterBps: health.collateralRatioBps,
      timestamp: vault.updatedAt,
      success: true
    };
  }

  public repayDebt(vaultId: string, repayer: string, amount: bigint): VaultOperationResult {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("VAULT_DOES_NOT_EXIST");
    if (amount <= 0n) throw new RangeError("REPAY_AMOUNT_MUST_BE_POSITIVE");

    const userBalance = this.stablecoinBalances.get(repayer) ?? 0n;
    if (userBalance < amount) {
      throw new Error("INSUFFICIENT_STABLECOIN_BALANCE");
    }

    this.accrueInterest(vault);

    const actualRepay = amount > vault.debtAmount ? vault.debtAmount : amount;
    vault.debtAmount -= actualRepay;

    const config = this.collaterals.get(vault.collateralToken)!;
    config.totalDebtIssued = config.totalDebtIssued >= actualRepay ? config.totalDebtIssued - actualRepay : 0n;

    this.stablecoinBalances.set(repayer, userBalance - actualRepay);
    vault.updatedAt = Math.floor(Date.now() / 1000);

    const health = this.getVaultHealth(vaultId);

    return {
      txId: `tx_rpy_${crypto.randomBytes(8).toString("hex")}`,
      vaultId,
      operation: "REPAY",
      actor: repayer,
      collateralToken: vault.collateralToken,
      collateralDelta: 0n,
      debtDelta: -actualRepay,
      collateralRatioAfterBps: health.collateralRatioBps,
      timestamp: vault.updatedAt,
      success: true
    };
  }

  public liquidateVault(vaultId: string, liquidator: string, debtToCover: bigint): VaultOperationResult {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("VAULT_DOES_NOT_EXIST");
    if (vault.debtAmount <= 0n) throw new Error("ZERO_DEBT");
    if (debtToCover <= 0n) throw new RangeError("DEBT_TO_COVER_MUST_BE_POSITIVE");

    this.accrueInterest(vault);
    const health = this.getVaultHealth(vaultId);
    if (health.isSolvent) {
      throw new Error("VAULT_IS_SOLVENT: Cannot liquidate a healthy vault");
    }

    const liquidatorBalance = this.stablecoinBalances.get(liquidator) ?? 0n;
    if (liquidatorBalance < debtToCover) {
      throw new Error("INSUFFICIENT_LIQUIDATOR_STABLECOIN_BALANCE");
    }

    const config = this.collaterals.get(vault.collateralToken)!;
    const price = this.oraclePrices.get(vault.collateralToken)!;

    const actualCover = debtToCover > vault.debtAmount ? vault.debtAmount : debtToCover;
    const { collateralToSeize } = calculateLiquidationSeizure(
      actualCover,
      price,
      config.decimals,
      config.liquidationPenaltyBps
    );

    const seized = collateralToSeize > vault.collateralAmount ? vault.collateralAmount : collateralToSeize;

    vault.debtAmount -= actualCover;
    vault.collateralAmount -= seized;
    config.totalDebtIssued = config.totalDebtIssued >= actualCover ? config.totalDebtIssued - actualCover : 0n;

    // Burn liquidator stablecoin and transfer collateral to liquidator
    this.stablecoinBalances.set(liquidator, liquidatorBalance - actualCover);
    const liquidatorCollateralKey = `${liquidator}:${vault.collateralToken}`;
    const curColl = this.collateralBalances.get(liquidatorCollateralKey) ?? 0n;
    this.collateralBalances.set(liquidatorCollateralKey, curColl + seized);

    vault.updatedAt = Math.floor(Date.now() / 1000);
    const healthAfter = this.getVaultHealth(vaultId);

    return {
      txId: `tx_liq_${crypto.randomBytes(8).toString("hex")}`,
      vaultId,
      operation: "LIQUIDATE",
      actor: liquidator,
      collateralToken: vault.collateralToken,
      collateralDelta: -seized,
      debtDelta: -actualCover,
      collateralRatioAfterBps: healthAfter.collateralRatioBps,
      timestamp: vault.updatedAt,
      success: true
    };
  }

  public getVaultHealth(vaultId: string): VaultHealth {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("VAULT_DOES_NOT_EXIST");

    const config = this.collaterals.get(vault.collateralToken);
    if (!config) throw new Error("COLLATERAL_NOT_REGISTERED");

    const price = this.oraclePrices.get(vault.collateralToken) ?? 0n;
    const collateralValueWad = calculateCollateralValue(vault.collateralAmount, price, config.decimals);
    const ratioBps = calculateCollateralRatio(collateralValueWad, vault.debtAmount);
    const solvent = isVaultSolvent(collateralValueWad, vault.debtAmount, config.minCollateralRatioBps);
    const maxAdditionalDebt = calculateMaxMintableDebt(collateralValueWad, config.minCollateralRatioBps, vault.debtAmount);

    return {
      vaultId,
      collateralValueWad,
      totalDebtWad: vault.debtAmount,
      collateralRatioBps: ratioBps,
      isSolvent: solvent,
      isLiquidatable: !solvent && vault.debtAmount > 0n,
      maxMintableAdditionalDebt: maxAdditionalDebt
    };
  }

  private accrueInterest(vault: VaultPosition): void {
    if (vault.debtAmount === 0n) {
      vault.lastAccrualTimestamp = Math.floor(Date.now() / 1000);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const elapsed = BigInt(now - vault.lastAccrualTimestamp);
    if (elapsed > 0n) {
      const config = this.collaterals.get(vault.collateralToken);
      if (config) {
        const interest = calculateStabilityFeeAccrual(vault.debtAmount, config.stabilityFeeBps, elapsed);
        vault.debtAmount += interest;
        vault.accruedInterest += interest;
        config.totalDebtIssued += interest;
        this.protocolFeesAccrued += interest;
      }
      vault.lastAccrualTimestamp = now;
    }
  }
}

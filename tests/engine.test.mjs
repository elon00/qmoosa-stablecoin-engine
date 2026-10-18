import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StablecoinEngine,
  AdminAuthManager,
  WAD
} from "../dist/index.js";

function setupEngine() {
  const { publicKey, privateKey } = AdminAuthManager.generateKeyPair();
  const engine = new StablecoinEngine(publicKey, 31337);

  engine.registerCollateralDirect({
    token: "WETH",
    symbol: "WETH",
    decimals: 18,
    minCollateralRatioBps: 15000n, // 150%
    liquidationPenaltyBps: 1000n,  // 10%
    stabilityFeeBps: 200n,         // 2% APR
    debtCeiling: 1_000_000n * WAD,
    totalDebtIssued: 0n,
    isPaused: false
  });

  engine.setOraclePriceDirect("WETH", 3000n * WAD); // $3000

  // Alice setup
  const alice = "0xAlice1111111111111111111111111111111111";
  engine.setUserCollateralBalance(alice, "WETH", 20n * WAD);

  // Bob liquidator setup
  const bob = "0xBob2222222222222222222222222222222222";
  engine.setUserStablecoinBalance(bob, 50_000n * WAD);

  return { engine, publicKey, privateKey, alice, bob };
}

test("1. Open vault, deposit collateral, and mint stablecoin (solvent)", () => {
  const { engine, alice } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  assert.equal(vault.owner, alice);
  assert.equal(vault.collateralAmount, 0n);

  // Deposit 10 WETH ($30,000 value)
  const depResult = engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  assert.equal(depResult.success, true);
  assert.equal(engine.getUserCollateralBalance(alice, "WETH"), 10n * WAD);

  // Mint 10,000 QUSD (300% ratio)
  const mintResult = engine.mintStablecoin(vault.vaultId, alice, 10_000n * WAD);
  assert.equal(mintResult.success, true);
  assert.equal(engine.getUserStablecoinBalance(alice), 10_000n * WAD);

  const health = engine.getVaultHealth(vault.vaultId);
  assert.equal(health.isSolvent, true);
  assert.equal(health.collateralRatioBps, 30000n);
});

test("2. Undercollateralized minting strictly fails closed with atomic rollback", () => {
  const { engine, alice } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD); // $30k value

  // Minting 21,000 QUSD requires > 1.5 * 21000 = $31,500 collateral -> fails
  assert.throws(
    () => engine.mintStablecoin(vault.vaultId, alice, 21_000n * WAD),
    /MINT_BREAKS_SOLVENCY/
  );

  // Assert zero debt was created
  const v = engine.getVault(vault.vaultId);
  assert.equal(v.debtAmount, 0n);
  assert.equal(engine.getUserStablecoinBalance(alice), 0n);
});

test("3. Excessive collateral withdrawal violating solvency strictly fails closed", () => {
  const { engine, alice } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  engine.mintStablecoin(vault.vaultId, alice, 10_000n * WAD); // 10k debt against 10 ETH

  // Attempting to withdraw 6 ETH leaves 4 ETH ($12k value), ratio drops to 120% (< 150%)
  assert.throws(
    () => engine.withdrawCollateral(vault.vaultId, alice, 6n * WAD),
    /WITHDRAWAL_BREAKS_SOLVENCY/
  );

  // Assert collateral remains intact at 10 ETH
  const v = engine.getVault(vault.vaultId);
  assert.equal(v.collateralAmount, 10n * WAD);
});

test("4. Debt repayment and collateral withdrawal", () => {
  const { engine, alice } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  engine.mintStablecoin(vault.vaultId, alice, 5_000n * WAD);

  // Repay full 5000 QUSD
  const repayRes = engine.repayDebt(vault.vaultId, alice, 5_000n * WAD);
  assert.equal(repayRes.success, true);
  assert.equal(engine.getUserStablecoinBalance(alice), 0n);

  // Withdraw all 10 ETH
  const wthRes = engine.withdrawCollateral(vault.vaultId, alice, 10n * WAD);
  assert.equal(wthRes.success, true);
  assert.equal(engine.getUserCollateralBalance(alice, "WETH"), 20n * WAD);
});

test("5. Undercollateralized liquidation after oracle price crash", () => {
  const { engine, alice, bob } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  engine.mintStablecoin(vault.vaultId, alice, 18_000n * WAD); // $18k debt (166% ratio at $3000)

  // Price drops to $2000 -> 10 ETH = $20,000 -> Ratio = 111% (< 150%)
  engine.setOraclePriceDirect("WETH", 2000n * WAD);
  const health = engine.getVaultHealth(vault.vaultId);
  assert.equal(health.isSolvent, false);
  assert.equal(health.isLiquidatable, true);

  // Bob liquidates 10,000 QUSD debt
  const liqResult = engine.liquidateVault(vault.vaultId, bob, 10_000n * WAD);
  assert.equal(liqResult.success, true);

  // With 10% penalty, 10,000 debt requires $11,000 collateral. At $2000/ETH = 5.5 ETH seized
  const bobCollateral = engine.getUserCollateralBalance(bob, "WETH");
  assert.equal(bobCollateral, (55n * WAD) / 10n); // 5.5 ETH
});

test("6. Liquidating solvent vault strictly fails closed", () => {
  const { engine, alice, bob } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  engine.mintStablecoin(vault.vaultId, alice, 5_000n * WAD); // 600% ratio

  assert.throws(
    () => engine.liquidateVault(vault.vaultId, bob, 2_000n * WAD),
    /VAULT_IS_SOLVENT/
  );
});

test("7. Asymmetric Ed25519 admin intents & replay defense", () => {
  const { engine, privateKey } = setupEngine();

  const now = Math.floor(Date.now() / 1000);
  const intent = AdminAuthManager.signAdminIntent(
    "SET_ORACLE_PRICE",
    { token: "WETH", priceWad: 4000n * WAD },
    1,
    now + 3600,
    "QMOOSA:STABLECOIN_ENGINE:31337",
    privateKey
  );

  engine.executeAdminIntent(intent);

  // Replay of same nonce must strictly fail closed
  assert.throws(
    () => engine.executeAdminIntent(intent),
    /Nonce replay rejected/
  );
});

test("8. Oracle staleness & deviation circuit breaker protections", () => {
  const { engine } = setupEngine();

  // Attempting to set stale timestamp fails closed
  const pastTime = Math.floor(Date.now() / 1000) - 4000; // older than 3600s
  assert.throws(
    () => engine.setOraclePriceDirect("WETH", 3100n * WAD, pastTime),
    /ORACLE_PRICE_STALE/
  );

  // Attempting to exceed 50% deviation bounds fails closed without override
  assert.throws(
    () => engine.setOraclePriceDirect("WETH", 5000n * WAD), // 66% jump from 3000
    /PRICE_DEVIATION_EXCEEDED/
  );

  // Emergency override bypasses deviation circuit breaker
  engine.overrideOraclePriceDirect("WETH", 5000n * WAD);
  assert.equal(engine.getOraclePrice("WETH"), 5000n * WAD);
});

test("9. Protocol bad debt accumulation on severe underwater shortfall", () => {
  const { engine, alice, bob } = setupEngine();

  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 1n * WAD); // 1 ETH
  engine.mintStablecoin(vault.vaultId, alice, 1_500n * WAD); // $1500 debt

  // Crash to $500/ETH
  engine.overrideOraclePriceDirect("WETH", 500n * WAD);

  // Bob liquidates 1500 QUSD debt. The vault only has 1 ETH ($500).
  const liq = engine.liquidateVault(vault.vaultId, bob, 1_500n * WAD);
  assert.equal(liq.success, true);
  assert.equal(liq.collateralDelta, -1n * WAD);

  // Assert bad debt was tracked
  assert.ok(engine.getProtocolBadDebt() > 0n);
});

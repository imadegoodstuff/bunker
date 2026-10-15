const { expect } = require("chai");
const hre = require("hardhat");
const { defaultParams } = require("../scripts/lib.cjs");

const { ethers } = hre;
const abi = ethers.AbiCoder.defaultAbiCoder();
const DEAD = "0x000000000000000000000000000000000000dEaD";

// JS mirror of the curve (what sdk/src/launch.ts will carry)
const divCeil = (a, b) => (a + b - 1n) / b;
function buy(r, bnbIn) {
  const x = r.virtualBnb + r.realBnb;
  const y = r.virtualToken;
  const y2 = divCeil(x * y, x + bnbIn);
  const out = y - y2;
  if (out === 0n) throw new Error("Nothing");
  if (out > r.realToken) throw new Error("SoldOut");
  return [out, y2];
}
function sell(r, tokenIn) {
  const x = r.virtualBnb + r.realBnb;
  const y = r.virtualToken;
  const y2 = y + tokenIn;
  const out = x - divCeil(x * y, y2);
  if (out === 0n) throw new Error("Nothing");
  if (out > r.realBnb) throw new Error("InsufficientReserve");
  return [out, y2];
}

function exitData(kind, token, claimKey, minOut, claimBudget, relayerTip) {
  return abi.encode(["uint8", "address", "address", "uint256", "uint256", "uint256"], [kind, token, claimKey, minOut, claimBudget, relayerTip]);
}

describe("Launchpad", function () {
  let signers, harness, router, launchpad, params, treasury, agents, relayer;

  before(async () => {
    signers = await ethers.getSigners();
    agents = signers.slice(1, 5);
    treasury = signers[5];
    relayer = signers[6];
    harness = await (await ethers.getContractFactory("ExitHarness")).deploy();
    router = await (await ethers.getContractFactory("MockPancakeRouter")).deploy();
    params = defaultParams({ agents: agents.map((a) => a.address), treasury: treasury.address, router: await router.getAddress() });
    launchpad = await (await ethers.getContractFactory("Launchpad")).deploy(await harness.getAddress(), params);
  });

  async function launch(name = "Bunker Coin", symbol = "BNKR") {
    const tx = await launchpad.connect(signers[7]).launch(name, symbol, "ipfs://meta");
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return launchpad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launch");
    return ev.args.token;
  }

  it("virtual BNB is sized so the curve sells out at graduation", () => {
    const r = { virtualBnb: params.virtualBnb, realBnb: 0n, virtualToken: params.virtualToken, realToken: params.curveSupply };
    const [out] = buy(r, params.graduationWei);
    expect(out).to.be.lte(params.curveSupply);
    expect(params.curveSupply - out).to.be.lt(params.curveSupply / 10_000n);
  });

  it("launch mints the supply to the curve and opens a pool", async () => {
    const token = await launch();
    const t = await ethers.getContractAt("LaunchToken", token);
    expect(await t.balanceOf(await launchpad.getAddress())).to.equal(params.totalSupply);
    expect(await t.decimals()).to.equal(6);
    expect(await t.allowance(signers[8].address, await harness.getAddress())).to.equal(ethers.MaxUint256);
    const c = await launchpad.curves(token);
    expect(c.realToken).to.equal(params.curveSupply);
    expect(c.virtualBnb).to.equal(params.virtualBnb);
    expect(c.tradeFeeBps).to.equal(100);
    expect(await launchpad.tokenCount()).to.equal(1n);
  });

  it("curve math on-chain equals the JS mirror and k never decreases", async () => {
    const c0 = { virtualBnb: params.virtualBnb, realBnb: 0n, virtualToken: params.virtualToken, realToken: params.curveSupply };
    const mk = (r) => ({ creator: ethers.ZeroAddress, createdBlock: 1, virtualBnb: r.virtualBnb, virtualToken: r.virtualToken, realBnb: r.realBnb, realToken: r.realToken, feesAccrued: 0n, graduated: false, tradeFeeBps: 0, settledEpoch: 0, votes: [[0, 0], [0, 0], [0, 0], [0, 0]], ammPair: ethers.ZeroAddress, buys: 0, sells: 0, bnbVolume: 0n });
    let r = { ...c0 };
    const k0 = (r.virtualBnb + r.realBnb) * r.virtualToken;
    let seed = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 40; i++) {
      seed ^= (seed << 13n) & ((1n << 64n) - 1n); seed ^= seed >> 7n; seed ^= (seed << 17n) & ((1n << 64n) - 1n);
      if ((seed & 3n) !== 0n || r.realBnb === 0n) {
        const bnb = 1n + (seed % (10n ** 17n));
        try {
          const [out, y2] = buy(r, bnb);
          const [o2, yy2] = await launchpad.buy(mk(r), bnb);
          expect(o2).to.equal(out); expect(yy2).to.equal(y2);
          r = { ...r, realBnb: r.realBnb + bnb, virtualToken: y2, realToken: r.realToken - out };
        } catch (e) { if (!/SoldOut|Nothing/.test(e.message)) throw e; }
      } else {
        const sold = c0.realToken - r.realToken;
        if (sold > 0n) {
          const tok = 1n + (seed % sold);
          try {
            const [out, y2] = sell(r, tok);
            const [o2, yy2] = await launchpad.sell(mk(r), tok);
            expect(o2).to.equal(out); expect(yy2).to.equal(y2);
            r = { ...r, realBnb: r.realBnb - out, virtualToken: y2, realToken: r.realToken + tok };
          } catch (e) { if (!/InsufficientReserve|Nothing/.test(e.message)) throw e; }
        }
      }
      expect((r.virtualBnb + r.realBnb) * r.virtualToken).to.be.gte(k0);
    }
    // capped buy
    const [out, y2, used] = await launchpad.buyCapped(mk(c0), 25n * 10n ** 18n);
    expect(out).to.equal(c0.realToken);
    expect(y2).to.equal(c0.virtualToken - c0.realToken);
    expect(used).to.be.gt(params.graduationWei - 10n ** 15n);
    expect(used).to.be.lt(params.graduationWei + 10n ** 15n);
    await expect(launchpad.buy(mk(c0), 25n * 10n ** 18n)).to.be.revertedWithCustomError(launchpad, "SoldOut");
    expect(await launchpad.fee(10_000n, 100)).to.equal(100n);
    for (const net of [1n, 999n, 1_000_000n, 123_456_789_012n]) {
      const f = await launchpad.feeOnNet(net, 100);
      const g = await launchpad.fee(net + f, 100);
      expect(g > f ? g - f : f - g).to.be.lte(1n);
    }
  });

  it("buys and sells through the exit hook pay the claim key and the relayer", async () => {
    const token = await launch("Two", "TWO");
    const t = await ethers.getContractAt("LaunchToken", token);
    const claim = ethers.Wallet.createRandom().connect(ethers.provider);
    const budget = ethers.parseEther("0.002");
    const tip = ethers.parseEther("0.0005");
    const amount = ethers.parseEther("0.5");
    const gross = amount - budget - tip;
    const fee = (gross * 100n) / 10_000n;
    const [expOut] = buy({ virtualBnb: params.virtualBnb, realBnb: 0n, virtualToken: params.virtualToken, realToken: params.curveSupply }, gross - fee);

    await expect(launchpad.onExit(ethers.ZeroAddress, amount, relayer.address, exitData(1, token, claim.address, 0, budget, tip))).to.be.revertedWithCustomError(launchpad, "NotFromPool");
    await expect(harness.connect(relayer).exitBnb(await launchpad.getAddress(), exitData(1, token, claim.address, expOut + 1n, budget, tip), { value: amount })).to.be.revertedWithCustomError(launchpad, "Slippage");
    const relBefore = await ethers.provider.getBalance(relayer.address);
    const tx = await harness.connect(relayer).exitBnb(await launchpad.getAddress(), exitData(1, token, claim.address, expOut, budget, tip), { value: amount });
    const rc = await tx.wait();
    expect(await t.balanceOf(claim.address)).to.equal(expOut);
    expect(await ethers.provider.getBalance(claim.address)).to.equal(budget);
    const relAfter = await ethers.provider.getBalance(relayer.address);
    expect(relAfter).to.equal(relBefore - amount - rc.gasUsed * rc.gasPrice + tip);
    let c = await launchpad.curves(token);
    expect(c.realBnb).to.equal(gross - fee);
    expect(c.feesAccrued).to.equal(fee);
    expect(c.buys).to.equal(1n);

    // sell half back through a fresh claim key
    const claim2 = ethers.Wallet.createRandom();
    const half = expOut / 2n;
    const [grossOut] = sell({ virtualBnb: c.virtualBnb, realBnb: c.realBnb, virtualToken: c.virtualToken, realToken: c.realToken }, half);
    const fee2 = (grossOut * 100n) / 10_000n;
    const out2 = grossOut - fee2 - tip;
    const impersonated = await ethers.getImpersonatedSigner(claim.address);
    await signers[9].sendTransaction({ to: claim.address, value: ethers.parseEther("1") });
    await expect(harness.connect(impersonated).exitToken(await launchpad.getAddress(), token, half, exitData(2, token, claim2.address, 0, out2, tip))).to.be.revertedWithCustomError(launchpad, "AmountTooSmall");
    await harness.connect(impersonated).exitToken(await launchpad.getAddress(), token, half, exitData(2, token, claim2.address, out2, budget, tip));
    expect(await ethers.provider.getBalance(claim2.address)).to.equal(out2);
    c = await launchpad.curves(token);
    expect(c.realBnb).to.equal(gross - fee - grossOut);
    expect(c.feesAccrued).to.equal(fee + fee2);
    expect(c.sells).to.equal(1n);

    // harvest to treasury
    const tb = await ethers.provider.getBalance(treasury.address);
    await launchpad.harvest(token);
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(tb + fee + fee2);
    await expect(launchpad.harvest(token)).to.be.revertedWithCustomError(launchpad, "Nothing");
  });

  it("agents vote; the fee follows the median one step per epoch", async () => {
    const token = await launch("Vote", "VOTE");
    await expect(launchpad.connect(signers[9]).vote(token, 200)).to.be.revertedWithCustomError(launchpad, "NotAgent");
    await expect(launchpad.connect(agents[0]).vote(token, 600)).to.be.revertedWithCustomError(launchpad, "BadParams");
    await launchpad.connect(agents[0]).vote(token, 500);
    await launchpad.connect(agents[1]).vote(token, 300);
    await launchpad.connect(agents[2]).vote(token, 250);
    const c = await launchpad.curves(token);
    expect(c.votes[0].feeBps).to.equal(500);
    // same epoch: nothing moves
    await hre.network.provider.send("hardhat_mine", ["0x1"]);
    await launchpad.rollPolicy(token);
    expect((await launchpad.curves(token)).tradeFeeBps).to.equal(100);
    // next epoch: +100
    await hre.network.provider.send("hardhat_mine", ["0x50"]);
    await launchpad.rollPolicy(token);
    expect((await launchpad.curves(token)).tradeFeeBps).to.equal(200);
    await hre.network.provider.send("hardhat_mine", ["0x50"]);
    expect((await launchpad.curveRolled(token)).tradeFeeBps).to.equal(300);
    await launchpad.rollPolicy(token);
    expect((await launchpad.curves(token)).tradeFeeBps).to.equal(300);
    // a lone vote has no quorum
    const t2 = await launch("Lone", "LONE");
    await launchpad.connect(agents[3]).vote(t2, 0);
    await hre.network.provider.send("hardhat_mine", ["0xa0"]);
    await launchpad.rollPolicy(t2);
    expect((await launchpad.curves(t2)).tradeFeeBps).to.equal(100);
  });

  it("rollPure: catch-up is capped and stale votes expire", async () => {
    const mk = (fee, settled, votes) => ({ creator: ethers.ZeroAddress, createdBlock: 1, virtualBnb: 1n, virtualToken: 1n, realBnb: 0n, realToken: 1n, feesAccrued: 0n, graduated: false, tradeFeeBps: fee, settledEpoch: settled, votes, ammPair: ethers.ZeroAddress, buys: 0, sells: 0, bnbVolume: 0n });
    const E = 80;
    let [f] = await launchpad.rollPure(mk(0, 0, [[500, 10], [500, 20], [0, 0], [0, 0]]), 3 * E);
    expect(f).to.equal(300);
    [f] = await launchpad.rollPure(mk(100, 1, [[300, 10], [300, 20], [0, 0], [0, 0]]), 100 * E);
    expect(f).to.equal(100);
    [f] = await launchpad.rollPure(mk(100, 1, [[300, 2 * E + 1], [300, 2 * E + 2], [0, 0], [0, 0]]), 2 * E + 10);
    expect(f).to.equal(100);
    [f] = await launchpad.rollPure(mk(100, 2, [[300, 2 * E + 1], [300, 2 * E + 2], [0, 0], [0, 0]]), 3 * E);
    expect(f).to.equal(200);
    expect(await launchpad.feeTarget([[100, 1], [110, 1], [120, 1], [500, 1]], 2, 0)).to.equal(115);
  });

  it("graduates when sold out and migrates to the AMM with LP burned", async () => {
    const token = await launch("Grad", "GRAD");
    const t = await ethers.getContractAt("LaunchToken", token);
    const claim = ethers.Wallet.createRandom();
    const amount = params.graduationWei + ethers.parseEther("1");
    const budget = ethers.parseEther("0.002");
    await expect(launchpad.migrate(token)).to.be.revertedWithCustomError(launchpad, "NotMigratable");
    const tx = await harness.connect(relayer).exitBnb(await launchpad.getAddress(), exitData(1, token, claim.address, 0, budget, 0), { value: amount });
    const rc = await tx.wait();
    const names = rc.logs.map((l) => { try { return launchpad.interface.parseLog(l)?.name; } catch { return null; } });
    expect(names).to.include("Graduate");
    const c = await launchpad.curves(token);
    expect(c.graduated).to.equal(true);
    expect(c.realToken).to.equal(0n);
    expect(await t.balanceOf(claim.address)).to.equal(params.curveSupply);
    // the buyer got back what the curve did not need
    const refund = await ethers.provider.getBalance(claim.address);
    expect(refund).to.be.gt(budget + ethers.parseEther("0.9"));
    // frozen
    await expect(harness.connect(relayer).exitBnb(await launchpad.getAddress(), exitData(1, token, claim.address, 0, budget, 0), { value: 10n ** 16n })).to.be.revertedWithCustomError(launchpad, "Migrated");
    await expect(launchpad.connect(agents[0]).vote(token, 100)).to.be.revertedWithCustomError(launchpad, "Migrated");
    await expect(launchpad.harvest(token)).to.be.revertedWithCustomError(launchpad, "Migrated");
    // migrate
    const tb = await ethers.provider.getBalance(treasury.address);
    const fees = c.feesAccrued;
    const bnbIn = c.realBnb;
    const tokensLeft = await t.balanceOf(await launchpad.getAddress());
    expect(tokensLeft).to.equal(params.totalSupply - params.curveSupply);
    const lpBefore = await ethers.provider.getBalance(await launchpad.getAddress());
    await launchpad.migrate(token);
    const c2 = await launchpad.curves(token);
    expect(c2.ammPair).to.not.equal(ethers.ZeroAddress);
    const pair = await ethers.getContractAt("MockPair", c2.ammPair);
    expect(await pair.balanceOf(DEAD)).to.be.gt(0n);
    expect(await pair.balanceOf(await launchpad.getAddress())).to.equal(0n);
    expect(await t.balanceOf(c2.ammPair)).to.equal(tokensLeft);
    expect(await ethers.provider.getBalance(c2.ammPair)).to.equal(0n); // mock keeps BNB in the router
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(tb + fees);
    expect(c2.realBnb).to.equal(0n);
    expect(await ethers.provider.getBalance(await launchpad.getAddress())).to.equal(lpBefore - bnbIn - fees);
    await expect(launchpad.migrate(token)).to.be.revertedWithCustomError(launchpad, "Migrated");
  });
});

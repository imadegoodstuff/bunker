const { expect } = require("chai");
const hre = require("hardhat");
const { createHash } = require("node:crypto");
const { buildPoseidon } = require("circomlibjs");
const { deployAll, emptyLeaf, ensurePoseidonT3, FIELD } = require("../scripts/lib.cjs");

const { ethers } = hre;

describe("ShieldedPool", function () {
  let d, poseidon, signers;

  before(async () => {
    signers = await ethers.getSigners();
    poseidon = await buildPoseidon();
    d = await deployAll(ethers, { agents: signers.slice(1, 5).map((s) => s.address), treasury: signers[5].address });
  });

  const H = (a, b) => poseidon.F.toObject(poseidon([a, b]));

  it("PoseidonT3 matches circomlibjs", async () => {
    const addr = await ensurePoseidonT3(ethers);
    const lib = new ethers.Contract(addr, ["function hash(uint256[2]) pure returns (uint256)"], signers[0]);
    for (const [a, b] of [[1n, 2n], [0n, 0n], [FIELD - 1n, 123456789n]]) {
      expect(await lib.hash([a, b])).to.equal(H(a, b));
    }
  });

  it("starts at the SDK's empty root", async () => {
    let z = await emptyLeaf();
    expect(await d.pool.zeros(0)).to.equal(z);
    for (let i = 1; i < 26; i++) {
      z = H(z, z);
      expect(await d.pool.zeros(i)).to.equal(z);
    }
    z = H(z, z);
    expect(await d.pool.getLastRoot()).to.equal(z);
    expect(await d.pool.isKnownRoot(z)).to.equal(true);
    expect(await d.pool.isKnownRoot(0n)).to.equal(false);
  });

  it("asset ids are sha256('bunker_asset' || 32-byte address) mod p", async () => {
    for (const token of [ethers.ZeroAddress, signers[3].address]) {
      const h = createHash("sha256").update(Buffer.from("bunker_asset")).update(Buffer.from(ethers.zeroPadValue(token, 32).slice(2), "hex")).digest();
      expect(await d.pool.assetId(token)).to.equal(BigInt("0x" + h.toString("hex")) % FIELD);
    }
  });

  it("native pool exists with gwei units; ERC-20 pools are permissionless and bounded", async () => {
    const native = await d.pool.pools(ethers.ZeroAddress);
    expect(native.exists).to.equal(true);
    expect(native.unit).to.equal(10n ** 9n);
    const T = await ethers.getContractFactory("MockERC20");
    const t = await T.deploy("Mock", "MCK", 18);
    await expect(d.pool.createPool(await t.getAddress(), 8, ethers.MaxUint256)).to.be.revertedWithCustomError(d.pool, "BadUnit");
    await expect(d.pool.createPool(await t.getAddress(), 19, ethers.MaxUint256)).to.be.revertedWithCustomError(d.pool, "BadUnit");
    await d.pool.createPool(await t.getAddress(), 9, 1000n);
    await expect(d.pool.createPool(await t.getAddress(), 9, 1000n)).to.be.revertedWithCustomError(d.pool, "AlreadyInitialized");
    const p = await d.pool.pools(await t.getAddress());
    expect(p.unit).to.equal(10n ** 9n);
    expect(p.tvlCap).to.equal(1000n);
    // a 6-decimals token may use unit 1
    const t6 = await T.deploy("Six", "SIX", 6);
    await d.pool.createPool(await t6.getAddress(), 0, ethers.MaxUint256);
    expect((await d.pool.pools(await t6.getAddress())).unit).to.equal(1n);
  });

  it("share math mirrors the SDK", async () => {
    const p = { exists: true, decimals: 18, unit: 1n, totalShares: 1000n, totalAssets: 1500n, totalIn: 0n, totalOut: 0n, tvlCap: 0n };
    const V = 1_000_000n;
    const amount = 777n;
    expect(await d.pool.sharesForDeposit(p, amount)).to.equal((amount * (p.totalShares + V)) / (p.totalAssets + V));
    const shares = 500n;
    const ts = p.totalShares + V;
    expect(await d.pool.amountForMint(p, shares)).to.equal((shares * (p.totalAssets + V) + ts - 1n) / ts);
    expect(await d.pool.amountForBurn(p, shares)).to.equal((shares * (p.totalAssets + V)) / ts);
  });

  it("guardian can pause shields and lower caps, nothing else", async () => {
    const g = signers[0];
    await expect(d.pool.connect(signers[1]).setShieldPaused(true)).to.be.revertedWithCustomError(d.pool, "Unauthorized");
    await d.pool.connect(g).setShieldPaused(true);
    expect(await d.pool.shieldPaused()).to.equal(true);
    await d.pool.connect(g).setShieldPaused(false);
    await expect(d.pool.connect(g).lowerTvlCap(ethers.ZeroAddress, ethers.MaxUint256)).to.be.revertedWithCustomError(d.pool, "CapNotLower");
    await d.pool.connect(g).lowerTvlCap(ethers.ZeroAddress, 10n ** 12n);
    expect((await d.pool.pools(ethers.ZeroAddress)).tvlCap).to.equal(10n ** 12n);
    await d.pool.connect(g).setGuardian(ethers.ZeroAddress);
    await expect(d.pool.connect(g).setShieldPaused(true)).to.be.revertedWithCustomError(d.pool, "Unauthorized");
  });

  it("refuses a donation nobody can receive and malformed transacts", async () => {
    await expect(d.pool.donate(ethers.ZeroAddress, 1n, { value: 10n ** 9n })).to.be.revertedWithCustomError(d.pool, "NotInitialized");
    const proof = { a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] };
    const ext = { recipient: ethers.ZeroAddress, relayer: ethers.ZeroAddress, relayerFee: 0n, exitTarget: ethers.ZeroAddress, exitData: "0x", ciphertext0: "0x", ciphertext1: "0x", outCiphertext: "0x" };
    const root = await d.pool.getLastRoot();
    await expect(d.pool.transact(proof, ethers.ZeroAddress, 1n, 0n, 0n, ethers.ZeroAddress, [1n, 2n], [3n, 4n], ext)).to.be.revertedWithCustomError(d.pool, "UnknownRoot");
    await expect(d.pool.transact(proof, ethers.ZeroAddress, root, 0n, 0n, ethers.ZeroAddress, [1n, 2n, 3n], [3n, 4n], ext)).to.be.revertedWithCustomError(d.pool, "MalformedProof");
    await expect(d.pool.transact(proof, ethers.ZeroAddress, root, 1n << 64n, 0n, ethers.ZeroAddress, [1n, 2n], [3n, 4n], ext)).to.be.revertedWithCustomError(d.pool, "PublicAmountOutOfRange");
    await expect(d.pool.transact(proof, ethers.ZeroAddress, root, 0n, 0n, ethers.ZeroAddress, [1n, 2n], [3n, 4n], ext)).to.be.revertedWithCustomError(d.pool, "InvalidProof");
    await expect(d.pool.transact(proof, ethers.ZeroAddress, root, 0n, 7n, signers[0].address, [1n, 2n], [3n, 4n], ext)).to.be.revertedWithCustomError(d.pool, "UnknownAspRoot");
  });

  it("ASP roots are a 32-entry ring per provider", async () => {
    const prov = signers[6];
    for (let i = 1; i <= 33; i++) await d.pool.connect(prov).publishAspRoot(BigInt(i));
    expect(await d.pool.isKnownAspRoot(prov.address, 1n)).to.equal(false);
    expect(await d.pool.isKnownAspRoot(prov.address, 2n)).to.equal(true);
    expect(await d.pool.isKnownAspRoot(prov.address, 33n)).to.equal(true);
    expect(await d.pool.isKnownAspRoot(signers[7].address, 33n)).to.equal(false);
  });

  it("extDataHash is sha256(abi.encode(ext)) mod p", async () => {
    const ext = {
      recipient: signers[1].address,
      relayer: signers[2].address,
      relayerFee: 12345n,
      exitTarget: ethers.ZeroAddress,
      exitData: "0x",
      ciphertext0: "0x" + "ab".repeat(100),
      ciphertext1: "0x" + "cd".repeat(100),
      outCiphertext: "0x" + "ef".repeat(40),
    };
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address recipient,address relayer,uint256 relayerFee,address exitTarget,bytes exitData,bytes ciphertext0,bytes ciphertext1,bytes outCiphertext)"],
      [ext],
    );
    const h = createHash("sha256").update(Buffer.from(encoded.slice(2), "hex")).digest("hex");
    expect(await d.pool.extDataHash(ext)).to.equal(BigInt("0x" + h) % FIELD);
  });
});

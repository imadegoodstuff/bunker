const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;
const abi = ethers.AbiCoder.defaultAbiCoder();

describe("SwapExit", function () {
  let signers, harness, router, wbnb, token, swapExit, poolAddr;

  before(async () => {
    signers = await ethers.getSigners();
    harness = await (await ethers.getContractFactory("ExitHarness")).deploy();
    poolAddr = await harness.getAddress();
    router = await (await ethers.getContractFactory("MockPancakeRouter")).deploy();
    wbnb = await router.WETH();
    const T = await ethers.getContractFactory("MockERC20");
    token = await T.deploy("Mock", "MCK", 18);
    await token.mint(signers[0].address, ethers.parseEther("1000000"));
    await token.approve(await router.getAddress(), ethers.MaxUint256);
    await router.seedPair(await token.getAddress(), ethers.parseEther("100000"), { value: ethers.parseEther("100") });
    swapExit = await (await ethers.getContractFactory("SwapExit")).deploy(poolAddr, await router.getAddress());
  });

  const data = (path, minOut) => abi.encode(["address[]", "uint256"], [path, minOut]);

  it("BNB in → tokens land in the pool", async () => {
    const tk = await token.getAddress();
    const amount = ethers.parseEther("1");
    const [, expOut] = await router.getAmountsOut(amount, [wbnb, tk]);
    await expect(swapExit.onExit(ethers.ZeroAddress, amount, signers[0].address, data([wbnb, tk], 0))).to.be.revertedWithCustomError(swapExit, "NotFromPool");
    await expect(harness.exitBnb(await swapExit.getAddress(), data([tk, wbnb], 0), { value: amount })).to.be.revertedWithCustomError(swapExit, "BadPath");
    await expect(harness.exitBnb(await swapExit.getAddress(), data([wbnb, tk], expOut + 1n), { value: amount })).to.be.revertedWith("SLIPPAGE");
    await harness.exitBnb(await swapExit.getAddress(), data([wbnb, tk], expOut), { value: amount });
    expect(await token.balanceOf(poolAddr)).to.equal(expOut);
    expect(await token.balanceOf(await swapExit.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await swapExit.getAddress())).to.equal(0n);
  });

  it("tokens in → BNB lands in the pool", async () => {
    const tk = await token.getAddress();
    const amount = ethers.parseEther("500");
    await token.approve(poolAddr, amount);
    const [, expOut] = await router.getAmountsOut(amount, [tk, wbnb]);
    const before = await ethers.provider.getBalance(poolAddr);
    const tx = await harness.exitToken(await swapExit.getAddress(), tk, amount, data([tk, wbnb], expOut));
    const rc = await tx.wait();
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(before + expOut);
    expect(rc.status).to.equal(1);
    expect(await ethers.provider.getBalance(await swapExit.getAddress())).to.equal(0n);
  });
});

const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;
const abi = ethers.AbiCoder.defaultAbiCoder();

describe("MigrateExit (v1 -> v2 bridge)", function () {
  let signers, v1, v2, token, bridge, v1Addr, v2Addr;
  const shieldIface = new ethers.Interface(["function shield(address token) payable"]);

  before(async () => {
    signers = await ethers.getSigners();
    v1 = await (await ethers.getContractFactory("ExitHarness")).deploy();
    v1Addr = await v1.getAddress();
    v2 = await (await ethers.getContractFactory("MockShieldPool")).deploy();
    v2Addr = await v2.getAddress();
    const T = await ethers.getContractFactory("MockERC20");
    token = await T.deploy("Mock", "MCK", 18);
    await token.mint(signers[0].address, ethers.parseEther("1000"));
    bridge = await (await ethers.getContractFactory("MigrateExit")).deploy(v1Addr, v2Addr);
  });

  const data = (refund, token) => abi.encode(["address", "bytes"], [refund, shieldIface.encodeFunctionData("shield", [token])]);

  it("only the v1 pool may call it", async () => {
    await expect(bridge.onExit(ethers.ZeroAddress, 1n, signers[0].address, data(ethers.ZeroAddress, ethers.ZeroAddress)))
      .to.be.revertedWithCustomError(bridge, "NotFromPool");
  });

  it("BNB: shields the whole amount into v2, nothing stays behind", async () => {
    const amount = ethers.parseEther("1");
    await v2.setWant(amount);
    await v1.exitBnb(await bridge.getAddress(), data(ethers.ZeroAddress, ethers.ZeroAddress), { value: amount });
    expect(await v2.shielded()).to.equal(amount);
    expect(await ethers.provider.getBalance(await bridge.getAddress())).to.equal(0n);
  });

  it("BNB: dust the v2 pool hands back goes to `refund`", async () => {
    const amount = ethers.parseEther("1");
    const want = amount - 12345n;
    await v2.setWant(want);
    const refund = signers[5].address;
    const before = await ethers.provider.getBalance(refund);
    await v1.exitBnb(await bridge.getAddress(), data(refund, ethers.ZeroAddress), { value: amount });
    expect(await ethers.provider.getBalance(refund)).to.equal(before + 12345n);
    expect(await ethers.provider.getBalance(await bridge.getAddress())).to.equal(0n);
  });

  it("BNB: refund defaults to the relayer (msg.sender of transact)", async () => {
    const amount = ethers.parseEther("1");
    await v2.setWant(amount - 7n);
    const relayer = signers[1];
    const before = await ethers.provider.getBalance(relayer.address);
    const tx = await v1.connect(relayer).exitBnb(await bridge.getAddress(), data(ethers.ZeroAddress, ethers.ZeroAddress), { value: amount });
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect(await ethers.provider.getBalance(relayer.address)).to.equal(before - amount - gas + 7n);
  });

  it("a failing v2 shield reverts the whole migration (the v1 note stays unspent)", async () => {
    const amount = ethers.parseEther("1");
    await v2.setWant(amount);
    await v2.setFail(true);
    await expect(v1.exitBnb(await bridge.getAddress(), data(ethers.ZeroAddress, ethers.ZeroAddress), { value: amount }))
      .to.be.revertedWithCustomError(bridge, "ShieldFailed");
    await v2.setFail(false);
  });

  it("tokens: approves exactly once, shields, returns leftovers, leaves no allowance", async () => {
    const tk = await token.getAddress();
    const amount = ethers.parseEther("100");
    const want = amount - ethers.parseEther("1");
    await v2.setWant(want);
    await token.approve(v1Addr, amount);
    const refund = signers[6].address;
    await v1.exitToken(await bridge.getAddress(), tk, amount, data(refund, tk));
    expect(await token.balanceOf(v2Addr)).to.equal(want);
    expect(await token.balanceOf(refund)).to.equal(ethers.parseEther("1"));
    expect(await token.balanceOf(await bridge.getAddress())).to.equal(0n);
    expect(await token.allowance(await bridge.getAddress(), v2Addr)).to.equal(0n);
  });
});

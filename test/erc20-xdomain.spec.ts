import { expect } from './setup'

import hre, { ethers } from 'hardhat'
import { constants, Contract, Signer } from 'ethers'

describe('Layer 1 <> Layer 2 ERC20 Transfers', () => {
  const l2ethers = (hre as any).l2ethers

  // `l2account1` will have the same private key as `l1account1`, just a different provider.
  let l1account1: Signer
  let l2account1: Signer
  before(async () => {
    ;[l1account1] = await ethers.getSigners()
    ;[l2account1] = await l2ethers.getSigners()
  })

  const name = 'Some Really Cool Token Name'
  const initialSupply = 10000000

  // Create all the contracts.
  let L1_ERC20: Contract
  let L1_ERC20Adapter: Contract
  let L2_ERC20: Contract
  beforeEach(async () => {
    L1_ERC20 = await (await ethers.getContractFactory('ERC20'))
      .connect(l1account1)
      .deploy(initialSupply, name)

    L1_ERC20Adapter = await (await ethers.getContractFactory('L1_ERC20Adapter'))
      .connect(l1account1)
      .deploy(L1_ERC20.address)
    
    // Deploy the Layer 2 ERC20 without an initial supply.
    L2_ERC20 = await (await l2ethers.getContractFactory('L2_ERC20'))
      .connect(l2account1)
      .deploy(0, name)
  })

  // Initialize the bridges.
  beforeEach(async () => {
    await L1_ERC20Adapter.createBridge(
      L2_ERC20.address,
      l2ethers.contracts.L1CrossDomainMessenger.address
    )

    await L2_ERC20.createBridge(
      L1_ERC20Adapter.address,
      l2ethers.contracts.L2CrossDomainMessenger.address
    )
  })

  it('should do the full flow', async () => {
    const amount = 2500000

    // Start by moving funds into Layer 2.
    // Approve some funds to be deposited.
    await L1_ERC20.connect(l1account1).approve(
      L1_ERC20Adapter.address,
      amount
    )

    // Now actually transfer the funds to Layer 2.
    const receipt1 = await L1_ERC20Adapter.connect(l1account1).deposit(
      amount
    )
    
    // Wait for the message to be sent to Layer 2.
    await l2ethers.waitForBridgeRelay(receipt1)

    // Balance on Layer 1 should be original minus the deposited amount.
    expect(
      await L1_ERC20.balanceOf(
        await l1account1.getAddress()
      )
    ).to.equal(initialSupply - amount)

    // Should have a balance on Layer 2 now!
    expect(
      await L2_ERC20.balanceOf(
        await l2account1.getAddress()
      )
    ).to.equal(amount)

    // Now try to withdraw the funds.
    const receipt2 = await L2_ERC20.connect(l2account1).withdraw(
      amount
    )

    // Wait for the message to be relayed to Layer 1.
    await l2ethers.waitForBridgeRelay(receipt2)

    // Balance on Layer 1 should be back to original amount.
    expect(
      await L1_ERC20.balanceOf(
        await l1account1.getAddress()
      )
    ).to.equal(initialSupply)

    // Balance on Layer 2 should be back to zero.
    expect(
      await L2_ERC20.balanceOf(
        await l2account1.getAddress()
      )
    ).to.equal(0)
  })

  describe('fast withdrawals', async () => {
    const amount = 2500000

    let withdrawalTx: any

    let marketMaker: Contract
    let mmAccount: Signer
    let inventoryAcc: Signer

    before(async () => {
      const signers = await ethers.getSigners()
      inventoryAcc = signers[6]
      mmAccount = signers[5]
    })

    beforeEach(async () => {
      // 1. deploy the MM
      marketMaker = await (await ethers.getContractFactory('MarketMaker'))
      .connect(mmAccount)
      .deploy(l2ethers.contracts.L1CrossDomainMessenger.address)

      // 2. fund the inventory address and approve the MM for it
      await L1_ERC20.connect(l1account1).transfer(await inventoryAcc.getAddress(), 2 * amount)
      await L1_ERC20.connect(inventoryAcc).approve(marketMaker.address, constants.MaxUint256)

      // 3. register the contracts
      await marketMaker.connect(mmAccount).registerDepositBox(
        L1_ERC20.address,
        L1_ERC20Adapter.address,
      )
      await marketMaker.connect(mmAccount).registerDepositBox(
        L1_ERC20.address,
        L2_ERC20.address,
      )

      // make a test deposit and start the withdrawal
      await L1_ERC20.connect(l1account1).approve(
        L1_ERC20Adapter.address,
        amount
      )
      const receipt1 = await L1_ERC20Adapter.connect(l1account1).deposit(
        amount
      )
      await l2ethers.waitForBridgeRelay(receipt1)

      // save the withdrawal receipt
      withdrawalTx = await L2_ERC20.connect(l2account1).withdraw(
        marketMaker.address,
        amount
      )
    })

    // TODO: Add data decoding helpers for the SentMessage event from the L2 bridge.

    it("market maker greenlights, user gets paid, mm claims a week later", async () => {
      const beneficiary = await l1account1.getAddress()

      let balBefore = await L1_ERC20.balanceOf(beneficiary)
      let balBeforeMM = await L1_ERC20.balanceOf(marketMaker.address)
      await marketMaker.connect(mmAccount).greenlight(
        L1_ERC20.address,
        await inventoryAcc.getAddress(),
        beneficiary,
        amount,
      )
      let balAfter = await L1_ERC20.balanceOf(beneficiary)
      let balAfterMM = await L1_ERC20.balanceOf(marketMaker.address)
      // beneficiary + amount
      expect(balAfter.sub(balBefore)).to.be.eq(amount)
      // mm - amount
      expect(balBeforeMM.sub(balAfterMM)).to.be.eq(amount)

      // receipt gets relayed
      balBefore = await L1_ERC20.balanceOf(marketMaker.address)
      await l2ethers.waitForBridgeRelay(withdrawalTx)
      balAfter = await L1_ERC20.balanceOf(marketMaker.address)
      // mm + amount
      expect(balAfter.sub(balBefore)).to.be.eq(amount)

      // market maker claim by the user fails because it's greenlit
      const nonce = 0 // TODO: How do we get this nonce? From the emitted event on L2?
      await expect(marketMaker.connect(l1account1).claim(
        L1_ERC20.address,
        beneficiary,
        amount,
        nonce,
      )).to.be.revertedWith("message already greenlighted")

      // market maker claim by owner success
      const owner = await mmAccount.getAddress()
      balBeforeMM = await L1_ERC20.balanceOf(marketMaker.address)
      balBefore = await L1_ERC20.balanceOf(owner)
      await marketMaker.connect(mmAccount).claim(
        L1_ERC20.address,
        owner,
        amount,
        nonce,
      )
      balAfter = await L1_ERC20.balanceOf(owner)
      balAfterMM = await L1_ERC20.balanceOf(marketMaker.address)
      // owner + amount
      expect(balAfter.sub(balBefore)).to.be.eq(amount)
      // mm - amount
      expect(balBeforeMM.sub(balAfterMM)).to.be.eq(amount)
    })

    // it("market maker AFK, user gets paid a week later", async () => {
    //   // receipt gets relayed
    //   await l2ethers.waitForBridgeRelay(withdrawalTx)

    //   // market maker contract balance increased
    //   await L1_ERC20.balanceOf(marketMaker.address)

    //   // makret maker claim by user success
    //   await marketMaker.claims(...)

    //   // market maker claim by owner failure because it's already claimed
    //   await marketMaker.claims(...)
    // })

    // it("market maker greenlights after the tx is relayed (same as 1)", async () => {
    //   // receipt gets relayed
    //   await l2ethers.waitForBridgeRelay(withdrawalTx)

    //   await marketMaker.greenlight()
    //   expect(user balance to be increased)

    //   // market maker contract balance increased
    //   await L1_ERC20.balanceOf(marketMaker.address)

    //   // market maker claim by the user fails because it's greenlit
    //   await marketMaker.claims(...)

    //   // makret maker claim by owner success
    //   await marketMaker.claims(...)

    // })
})

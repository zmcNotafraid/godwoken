import { normalizers, Reader, RPC } from "ckb-js-toolkit";
import {
  core,
  utils,
  values,
  Cell,
  CellDep,
  Hash,
  HexNumber,
  HexString,
  Script,
  Transaction,
  QueryOptions,
  Indexer,
} from "@ckb-lumos/base";
import { Set } from "immutable";
import { common } from "@ckb-lumos/common-scripts";
import { getConfig } from "@ckb-lumos/config-manager";
import {
  TransactionSkeleton,
  TransactionSkeletonType,
  sealTransaction,
  scriptToAddress,
  minimalCellCapacity,
} from "@ckb-lumos/helpers";
import { ChainService, SubmitTxs } from "@ckb-godwoken/godwoken";
import {
  asyncSleep,
  waitForBlockSync,
  DeploymentConfig,
  schemas,
  types,
} from "@ckb-godwoken/base";
import {
  DepositionEntry,
  scanDepositionCellsInCommittedL2Block,
  tryExtractDepositionRequest,
  RunnerConfig,
  StateValidatorLockGenerator,
  Logger,
} from "./utils";
import { AlwaysSuccessGenerator } from "./locks";
import { generator as poaGeneratorModule } from "clerkb-lumos-integrator";
import * as secp256k1 from "secp256k1";
import { exit } from "process";

const FINALIZED_BLOCKS = 100;
function isRollupTransction(
  tx: Transaction,
  rollupTypeScript: Script
): boolean {
  const rollupValue = new values.ScriptValue(rollupTypeScript, {
    validate: false,
  });
  for (const output of tx.outputs) {
    if (output.type) {
      const value = new values.ScriptValue(output.type, { validate: false });
      if (value.equals(rollupValue)) {
        return true;
      }
    }
  }
  return false;
}

function buildDefaultCustodianLockArgs() {
  return {
    depositionLockArgs: {
      owner_lock_hash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      layer2_lock: {
        code_hash:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        hash_type: "type",
        args: "0x",
      },
      cancel_timeout: "0x0",
    },
    depositionBlockHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    depositionBlockNumber: "0x0",
  };
}

export class Runner {
  rpc: RPC;
  indexer: Indexer;
  chainService: ChainService;
  config: RunnerConfig;
  lastBlockNumber: bigint;
  cancelListener: () => void;
  logger: Logger;
  rollupTypeHash: Hash;
  privateKey: HexString;

  lockGenerator?: StateValidatorLockGenerator;

  constructor(
    rpc: RPC,
    indexer: Indexer,
    chainService: ChainService,
    config: RunnerConfig,
    privateKey: HexString,
    logger: Logger
  ) {
    this.rpc = rpc;
    this.indexer = indexer;
    this.chainService = chainService;
    this.config = config;
    this.cancelListener = () => {};
    this.logger = logger;
    this.privateKey = privateKey;
    this.rollupTypeHash = utils
      .ckbHash(
        core.SerializeScript(
          normalizers.NormalizeScript(
            config.godwokenConfig.chain.rollup_type_script
          )
        )
      )
      .serializeJson();

    const lastSynced = new schemas.HeaderInfo(
      new Reader(chainService.lastSynced()).toArrayBuffer()
    );
    this.lastBlockNumber = lastSynced.getNumber().toLittleEndianBigUint64();

    if (!this._readOnlyMode()) {
      if (config.aggregatorConfig.type === "poa") {
        this.lockGenerator = new poaGeneratorModule.PoAGenerator(
          this._ckbAddress(),
          this.indexer,
          [config.deploymentConfig.poa_state_dep!],
          (message) => {
            this.logger("debug", `[aggregator] ${message}`);
          }
        );
      } else {
        this.lockGenerator = new AlwaysSuccessGenerator();
      }
    }
  }

  _readOnlyMode(): boolean {
    return !this.privateKey;
  }

  _ckbAddress(): string {
    if (this._readOnlyMode()) {
      throw new Error("Read only mode is used!");
    }
    const privateKeyBuffer = new Reader(this.privateKey).toArrayBuffer();
    const publicKeyArray = secp256k1.publicKeyCreate(
      new Uint8Array(privateKeyBuffer)
    );
    const publicKeyHash = utils
      .ckbHash(publicKeyArray.buffer)
      .serializeJson()
      .substr(0, 42);
    const scriptConfig = getConfig().SCRIPTS.SECP256K1_BLAKE160!;
    const script = {
      code_hash: scriptConfig.CODE_HASH,
      hash_type: scriptConfig.HASH_TYPE,
      args: publicKeyHash,
    };
    return scriptToAddress(script);
  }

  _deploymentConfig(): DeploymentConfig {
    return this.config.deploymentConfig;
  }

  _rollupCellQueryOptions(): QueryOptions {
    return {
      type: {
        script: this.config.godwokenConfig.chain.rollup_type_script,
        ioType: "output",
        argsLen: "any",
      },
      // TODO: when persistent store is built, we can add fromBlock here.
      order: "asc",
    };
  }

  _depositionCellQueryOptions(): QueryOptions {
    return {
      lock: {
        script: {
          code_hash: this.config.deploymentConfig.deposition_lock.code_hash,
          hash_type: this.config.deploymentConfig.deposition_lock.hash_type,
          args: this.rollupTypeHash,
        },
        ioType: "output",
        argsLen: "any",
      },
      order: "asc",
    };
  }

  async _syncL2Block(transaction: Transaction, headerInfo: types.HeaderInfo) {
    const depositionRequests = await scanDepositionCellsInCommittedL2Block(
      transaction,
      this.config,
      this.rpc
    );
    const context: SubmitTxs = {
      type: "submit_txs",
      deposition_requests: depositionRequests,
    };
    const update = {
      transaction: new Reader(
        core.SerializeTransaction(normalizers.NormalizeTransaction(transaction))
      ).serializeJson(),
      header_info: new Reader(
        schemas.SerializeHeaderInfo(types.NormalizeHeaderInfo(headerInfo))
      ).serializeJson(),
      context,
    };
    const syncParam = {
      reverts: [],
      updates: [update],
      // TODO: figure out next block context values
      next_block_context: {
        aggregator_id: "0x0",
        timestamp: "0x" + (BigInt(Date.now()) / 1000n).toString(16),
      },
    };
    // TODO: process sync event.
    const event = await this.chainService.sync(syncParam);
    this.logger(
      "info",
      `Synced l2 blocks at l1 block number: ${headerInfo.number}`
    );
  }

  async _syncToTip() {
    while (true) {
      const blockNumber = this.lastBlockNumber + 1n;
      const block = await this.rpc.get_block_by_number(
        "0x" + blockNumber.toString(16)
      );
      if (!block) {
        // Already synced to tip
        await waitForBlockSync(this.indexer, this.rpc, undefined, blockNumber);
        return;
      }
      const headerInfo: types.HeaderInfo = {
        number: block.header.number,
        block_hash: block.header.hash,
      };
      for (const tx of block.transactions) {
        if (
          isRollupTransction(
            tx,
            this.config.godwokenConfig.chain.rollup_type_script
          )
        ) {
          await this._syncL2Block(tx, headerInfo);
        }
      }
      this.lastBlockNumber = BigInt(headerInfo.number);
    }
  }

  async start() {
    this.logger("debug", `Rollup Type Hash: ${this.rollupTypeHash}`);
    if (this._readOnlyMode()) {
      this.logger("info", "Current server is running in readonly mode!");
    } else {
      this.logger("debug", `CKB Address: ${this._ckbAddress()}`);
    }
    // Wait for indexer sync
    await this.indexer.waitForSync();

    this.logger("info", "Catching up to tip!");
    await this._syncToTip();

    // Now we can boot godwoken to a normal working state: we listen for each new block,
    // look for godwoken state changes, which we need to send to the internal godwoken
    // state machine. Each new block will also incur new timestamp change. At certain
    // time, we need to decide to issue a new L2 block.

    this.logger("info", "Subscribe to median time!");
    const callback = this._newBlockReceived.bind(this);
    const medianTimeEmitter = this.indexer.subscribeMedianTime();
    medianTimeEmitter.on("changed", callback);
    this.cancelListener = () => {
      medianTimeEmitter.off("changed", callback);
    };
  }
  async _queryValidDepositionRequests(
    maximum = 20
  ): Promise<Array<DepositionEntry>> {
    const tipHeader = await this.rpc.get_tip_header();
    const collector = this.indexer.collector(
      this._depositionCellQueryOptions()
    );
    const results = [];
    for await (const cell of collector.collect()) {
      // Since custodian cells requires much bigger storage, ignore
      // deposition request with less than 400 CKB for now.
      if (BigInt(cell.cell_output.capacity) < 40000000000n) {
        continue;
      }
      const cellHeader = await this.rpc.get_header(cell.block_hash);
      const entry = await tryExtractDepositionRequest(
        cell,
        this.config,
        tipHeader,
        cellHeader
      );
      if (entry) {
        results.push(entry);
        if (results.length === maximum) {
          break;
        }
      }
    }
    return results;
  }

  // Use the transaction containing specified cell to look for a dep cell
  // one can use here.
  // TODO: this works but is quite slow, maybe we can cache found cell deps
  // to reduce queries to CKB.
  async _queryTypeScriptCellDep(cell: Cell): Promise<CellDep> {
    const tx: Transaction = (
      await this.rpc.get_transaction(cell.out_point!.tx_hash)
    ).transaction;
    for (const cellDep of tx.cell_deps) {
      if (cellDep.dep_type === "dep_group") {
        throw new Error("TODO: dep group support!");
      }
      const codeCell = await this.rpc.get_live_cell(cellDep.out_point, true);
      if (cell.cell_output.type!.hash_type == "data") {
        if (codeCell.cell.data.hash === cell.cell_output.type!.code_hash) {
          return cellDep;
        }
      } else if (codeCell.cell.output.type) {
        const typeHash = utils.computeScriptHash(codeCell.cell.output.type);
        if (typeHash === cell.cell_output.type!.code_hash) {
          return cellDep;
        }
      }
    }
    throw new Error(`Cannot find cell dep for ${cell.cell_output.type!}`);
  }

  async _queryLiveRollupCell(): Promise<Cell> {
    const collector = this.indexer.collector(this._rollupCellQueryOptions());
    const results = [];
    for await (const cell of collector.collect()) {
      results.push(cell);
    }
    if (results.length !== 1) {
      throw new Error(`Invalid number of rollup cells: ${results.length}`);
    }
    return results[0];
  }

  _generateCustodianCells(
    packedl2Block: HexString,
    depositionEntries: DepositionEntry[]
  ) {
    const l2Block = new schemas.L2Block(
      new Reader(packedl2Block).toArrayBuffer()
    );
    const rawL2Block = l2Block.getRaw();
    const data: DataView = (rawL2Block as any).view;
    const l2BlockHash = utils.ckbHash(data.buffer).serializeJson();
    const l2BlockNumber =
      "0x" + rawL2Block.getNumber().toLittleEndianBigUint64().toString(16);
    return depositionEntries.map(({ cell, lockArgs }) => {
      const custodianLockArgs = {
        deposition_lock_args: types.DenormalizeDepositionLockArgs(lockArgs),
        deposition_block_hash: l2BlockHash,
        deposition_block_number: l2BlockNumber,
      };
      const lock = {
        code_hash: this.config.deploymentConfig.custodian_lock.code_hash,
        hash_type: this.config.deploymentConfig.custodian_lock.hash_type,
        args: this._packCustodianLockArgs(custodianLockArgs),
      };
      return {
        cell_output: {
          capacity: cell.cell_output.capacity,
          lock,
          type: cell.cell_output.type,
        },
        data: cell.data,
      };
    });
  }

  _newBlockReceived(medianTimeHex: HexNumber) {
    (async () => {
      this.logger(
        "info",
        `New block received! Median time: ${medianTimeHex}(${BigInt(
          medianTimeHex
        )})`
      );
      await this._syncToTip();
      const tipCell = await this._queryLiveRollupCell();
      if (
        !this._readOnlyMode() &&
        (await this.lockGenerator!.shouldIssueNewBlock(
          medianTimeHex,
          tipCell
        )) === "Yes"
      ) {
        this.logger("info", "Generating new block!");
        const depositionEntries = await this._queryValidDepositionRequests();
        this.logger(
          "debug",
          `Valid deposition entries: ${depositionEntries.length}`
        );
        const depositionRequests = depositionEntries.map(
          ({ packedRequest }) => packedRequest
        );
        const param = {
          aggregator_id: "0x0",
          deposition_requests: depositionRequests,
        };
        const {
          block: packedl2Block,
          global_state,
        } = await this.chainService.produceBlock(param);
        const cell = await this._queryLiveRollupCell();

        let txSkeleton = TransactionSkeleton({ cellProvider: this.indexer });
        txSkeleton = txSkeleton.update("cellDeps", (cellDeps) => {
          cellDeps = cellDeps
            .push(this.config.deploymentConfig.state_validator_lock_dep)
            .push(this.config.deploymentConfig.state_validator_type_dep);
          if (depositionEntries.length > 0) {
            cellDeps = cellDeps.push(
              this.config.deploymentConfig.deposition_lock_dep
            );
          }
          return cellDeps;
        });
        txSkeleton = txSkeleton.update("inputs", (inputs) => inputs.push(cell));
        txSkeleton = txSkeleton.update("witnesses", (witnesses) => {
          const witnessArgs = {
            output_type: new Reader(packedl2Block).serializeJson(),
          };
          const packedWitnessArgs = new Reader(
            core.SerializeWitnessArgs(
              normalizers.NormalizeWitnessArgs(witnessArgs)
            )
          ).serializeJson();
          return witnesses.push(packedWitnessArgs);
        });
        txSkeleton = txSkeleton.update("outputs", (outputs) => {
          return outputs.push({
            cell_output: cell.cell_output,
            data: new Reader(global_state).serializeJson(),
          });
        });
        const addedCellDeps = Set();
        for (const { cell } of depositionEntries) {
          txSkeleton = txSkeleton.update("inputs", (inputs) =>
            inputs.push(cell)
          );
          // Placeholders so we can make sure cells used to pay fees have signature
          // at correct place.
          txSkeleton = txSkeleton.update("witnesses", (witnesses) =>
            witnesses.push("0x")
          );
          // Some deposition cells might have type scripts for sUDTs, handle cell deps
          // here.
          if (cell.cell_output.type) {
            const cellDep = await this._queryTypeScriptCellDep(cell);
            const packedCellDep = new Reader(
              core.SerializeCellDep(normalizers.NormalizeCellDep(cellDep))
            ).serializeJson();
            if (!addedCellDeps.has(packedCellDep)) {
              txSkeleton = txSkeleton.update("cellDeps", (cellDeps) =>
                cellDeps.push(cellDep)
              );
              addedCellDeps.add(packedCellDep);
            }
          }
        }
        for (const cell of this._generateCustodianCells(
          packedl2Block,
          depositionEntries
        )) {
          txSkeleton = txSkeleton.update("outputs", (outputs) =>
            outputs.push(cell)
          );
        }
        txSkeleton = await this.lockGenerator!.fixTransactionSkeleton(
          medianTimeHex,
          txSkeleton
        );
        // TODO: stake cell

        txSkeleton = await this._injectWithdrawalRequest(
          txSkeleton,
          packedl2Block
        );

        txSkeleton = await common.payFeeByFeeRate(
          txSkeleton,
          [this._ckbAddress()],
          BigInt(1000)
        );
        txSkeleton = common.prepareSigningEntries(txSkeleton);
        const signatures = [];
        for (const { message } of txSkeleton.get("signingEntries").toArray()) {
          const signObject = secp256k1.ecdsaSign(
            new Uint8Array(new Reader(message).toArrayBuffer()),
            new Uint8Array(new Reader(this.privateKey).toArrayBuffer())
          );
          const signatureBuffer = new ArrayBuffer(65);
          const signatureArray = new Uint8Array(signatureBuffer);
          signatureArray.set(signObject.signature, 0);
          signatureArray.set([signObject.recid], 64);
          const signature = new Reader(signatureBuffer).serializeJson();
          signatures.push(signature);
        }
        const tx = sealTransaction(txSkeleton, signatures);

        try {
          const hash = await this.rpc.send_transaction(tx);
          this.logger("info", `Submitted l2 block in ${hash}`);
        } catch (e) {
          this.logger("error", `Error submiting block: ${e}`);
          this.lockGenerator!.cancelIssueBlock().catch((e) => {
            console.error(`Error cancelling block: ${e}`);
          });
        }
      }
    })().catch((e) => {
      console.error(`Error processing new block: ${e} ${e.stack}`);
      exit(1);
    });
  }

  async _injectWithdrawalRequest(
    txSkeleton: TransactionSkeletonType,
    packedl2Block: HexString
  ): Promise<TransactionSkeletonType> {
    const l2Block = new schemas.L2Block(
      new Reader(packedl2Block).toArrayBuffer()
    );
    const rawL2Block = l2Block.getRaw();
    const data: DataView = (rawL2Block as any).view;
    const l2BlockHash = utils.ckbHash(data.buffer).serializeJson();
    const l2BlockNumber =
      "0x" + rawL2Block.getNumber().toLittleEndianBigUint64().toString(16);
    const withdrawalRequestVec = l2Block.getWithdrawalRequests();
    if (withdrawalRequestVec.length() === 0) {
      return txSkeleton;
    }
    // add custodian lock dep
    txSkeleton = txSkeleton.update("cellDeps", (cellDeps) => {
      return cellDeps.push(this.config.deploymentConfig.custodian_lock_dep);
    });
    // collect all finalized and live custodian cells
    let toBlockNumber = BigInt(l2BlockNumber) - BigInt(FINALIZED_BLOCKS);
    const toBlock = "0x" + toBlockNumber.toString(16);
    const validCustodianCells = await this._queryValidCustodianCells(toBlock);
    const deposition_block_hash = validCustodianCells[0].block_hash!;
    const deposition_block_number = validCustodianCells[0].block_number!;
    let ckbWithdrawalCapacity = 0n;
    let sudtWithdrawalAssets: Map<HexString, BigInt> = new Map();
    // build withdrawal cells
    for (let i = 0; i < withdrawalRequestVec.length(); i++) {
      const rawWithdrawalRequest = withdrawalRequestVec.indexAt(i).getRaw();
      const withdrawalCapacity =
        "0x" +
        rawWithdrawalRequest
          .getCapacity()
          .toLittleEndianBigUint64()
          .toString(16);
      // Record withdrawal assets info for inject input cells later
      ckbWithdrawalCapacity =
        ckbWithdrawalCapacity + BigInt(withdrawalCapacity);
      const sudtScriptHash = new Reader(
        rawWithdrawalRequest.getSudtScriptHash().raw()
      ).serializeJson();
      let withdrawalType: Script | undefined = undefined;
      let outputData = "0x";
      // check if it includes sudt withdrawal request
      if (
        sudtScriptHash !=
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        const sudtAmount = new Reader(
          rawWithdrawalRequest.getAmount().raw()
        ).serializeJson();
        withdrawalType = {
          code_hash: this.config.deploymentConfig.sudt_type.code_hash,
          hash_type: this.config.deploymentConfig.sudt_type.hash_type,
          args: sudtScriptHash,
        };
        outputData = utils.toBigUInt128LE(BigInt(sudtAmount));
        if (sudtWithdrawalAssets.has(sudtScriptHash)) {
          const updatedAmount =
            BigInt(sudtWithdrawalAssets.get(sudtScriptHash)) +
            BigInt(sudtAmount);
          sudtWithdrawalAssets.set(sudtScriptHash, updatedAmount);
        } else {
          sudtWithdrawalAssets.set(sudtScriptHash, BigInt(sudtAmount));
        }
      }
      // build withdrawalLockArgs
      const withdrawalLockArgs = this._buildWithdrawalLockArgs(
        rawWithdrawalRequest,
        deposition_block_hash,
        deposition_block_number,
        l2BlockHash,
        l2BlockNumber
      );

      const withdrawalLock: Script = {
        code_hash: this.config.deploymentConfig.withdrawal_lock.code_hash,
        hash_type: this.config.deploymentConfig.withdrawal_lock.hash_type,
        args: this._packWithdrawalLockArgs(withdrawalLockArgs),
      };
      const withdrawalOutput: Cell = {
        cell_output: {
          lock: withdrawalLock,
          type: withdrawalType,
          capacity: withdrawalCapacity,
        },
        data: outputData,
      };
      const minimalCapacity = minimalCellCapacity(withdrawalOutput);
      // Withdraw sudt only or ckb with capacity less than minimal capacity is not support so far.
      if (BigInt(withdrawalCapacity) < BigInt(minimalCapacity)) {
        throw new Error(
          "Try to withdraw capacity less than minimalCellCapacity"
        );
      }
      txSkeleton = txSkeleton.update("outputs", (outputs) => {
        return outputs.push(withdrawalOutput);
      });
    }
    // add sudt type dep
    if (sudtWithdrawalAssets.size > 0) {
      txSkeleton = txSkeleton.update("cellDeps", (cellDeps) => {
        return cellDeps.push(this.config.deploymentConfig.sudt_type_dep);
      });
    }
    txSkeleton = this._injectCustodianInputsAndChanges(
      txSkeleton,
      ckbWithdrawalCapacity,
      sudtWithdrawalAssets,
      validCustodianCells
    );
    return txSkeleton;
  }

  _injectCustodianInputsAndChanges(
    txSkeleton: TransactionSkeletonType,
    ckbWithdrawalCapacity: BigInt,
    sudtWithdrawalAssets: Map<Hash, BigInt>,
    validCustodianCells: Cell[]
  ): TransactionSkeletonType {
    const getInputKey = (input: Cell) =>
      `${input.out_point!.tx_hash}_${input.out_point!.index}`;
    let previousInputs = Set<string>();
    let inputCkbCapacitySum = BigInt(0);
    let outputCkbCapacitySumForSudtCustodianCells = BigInt(0);
    for (let [sudtScriptHash, targetSudtAmount] of sudtWithdrawalAssets) {
      let inputSudtAmountSum = BigInt(0);
      for (const cell of validCustodianCells) {
        if (
          cell.cell_output.type ||
          cell.cell_output.type!.args === sudtScriptHash
        ) {
          const key = getInputKey(cell);
          if (previousInputs.has(key)) {
            continue;
          }
          previousInputs.add(key);
          const inputCkbCapacity = BigInt(cell.cell_output.capacity);
          const inputSudtAmount = utils.readBigUInt128LE(cell.data);
          inputCkbCapacitySum += inputCkbCapacity;
          inputSudtAmountSum += inputSudtAmount;
          txSkeleton = txSkeleton.update("inputs", (inputs) => {
            return inputs.push(cell);
          });
          if (inputSudtAmountSum >= targetSudtAmount) {
            break;
          }
        }
      }
      if (inputSudtAmountSum < targetSudtAmount) {
        throw new Error("Insufficient sudt amount in valid custodian cells");
      }
      // build sudt change custodian cell
      const custodianLock: Script = {
        code_hash: this.config.deploymentConfig.custodian_lock.code_hash,
        hash_type: this.config.deploymentConfig.custodian_lock.hash_type,
        args: this._packCustodianLockArgs(buildDefaultCustodianLockArgs()),
      };
      const custodianType: Script = {
        code_hash: this.config.deploymentConfig.sudt_type.code_hash,
        hash_type: this.config.deploymentConfig.sudt_type.hash_type,
        args: sudtScriptHash,
      };
      let sudtChangeCustodian: Cell = {
        cell_output: {
          lock: custodianLock,
          type: custodianType,
          capacity: "0x0",
        },
        data: utils.toBigUInt128LE(
          BigInt(inputSudtAmountSum) - BigInt(targetSudtAmount)
        ),
      };
      const minimalCapacity = minimalCellCapacity(sudtChangeCustodian);
      sudtChangeCustodian.cell_output.capacity =
        "0x" + minimalCapacity.toString(16);
      outputCkbCapacitySumForSudtCustodianCells += minimalCapacity;
      txSkeleton = txSkeleton.update("outputs", (outputs) => {
        return outputs.push(sudtChangeCustodian);
      });
    }
    if (
      BigInt(inputCkbCapacitySum) ===
      BigInt(ckbWithdrawalCapacity) +
        BigInt(outputCkbCapacitySumForSudtCustodianCells)
    ) {
      // so lucky with it, just return
      return txSkeleton;
    }
    // build ckb change custodian cell
    const custodianLock: Script = {
      code_hash: this.config.deploymentConfig.custodian_lock.code_hash,
      hash_type: this.config.deploymentConfig.custodian_lock.hash_type,
      args: this._packCustodianLockArgs(buildDefaultCustodianLockArgs()),
    };
    let ckbChangeCustodian: Cell = {
      cell_output: {
        lock: custodianLock,
        type: undefined,
        capacity: "0x0",
      },
      data: utils.toBigUInt128LE(BigInt(0)),
    };
    const minimalCapacity = minimalCellCapacity(ckbChangeCustodian);
    const changeCapacity =
      BigInt(inputCkbCapacitySum) -
      BigInt(ckbWithdrawalCapacity) -
      BigInt(outputCkbCapacitySumForSudtCustodianCells);
    if (BigInt(changeCapacity) >= BigInt(minimalCapacity)) {
      // With enough input ckb capacity to build a minimal change cell
      ckbChangeCustodian.cell_output.capacity =
        "0x" + changeCapacity.toString(16);
      txSkeleton = txSkeleton.update("outputs", (outputs) => {
        return outputs.push(ckbChangeCustodian);
      });
      return txSkeleton;
    }
    // Gonna collect some more ckb to build the change cell
    for (const cell of validCustodianCells) {
      if (!cell.cell_output.type) {
        const key = getInputKey(cell);
        if (previousInputs.has(key)) {
          continue;
        }
        previousInputs.add(key);
        const inputCkbCapacity = BigInt(cell.cell_output.capacity);
        inputCkbCapacitySum += inputCkbCapacity;
        txSkeleton = txSkeleton.update("inputs", (inputs) => {
          return inputs.push(cell);
        });
        if (
          BigInt(inputCkbCapacitySum) >=
          BigInt(ckbWithdrawalCapacity) +
            BigInt(outputCkbCapacitySumForSudtCustodianCells) +
            BigInt(minimalCapacity)
        ) {
          break;
        }
      }
    }
    // We explicitly throw an error here.
    // checks should be make in Godwoken:
    // 1. if someone chooses to withdraw SUDT, he/she must withdraw CKB of enough capacity to store the SUDTs.
    // 2. Also, the left CKBs must be enough to hold a left-over custodian cell.
    // otherwise the withdraw request should be reject.
    if (
      BigInt(inputCkbCapacitySum) <
      BigInt(ckbWithdrawalCapacity) +
        BigInt(outputCkbCapacitySumForSudtCustodianCells) +
        BigInt(minimalCapacity)
    ) {
      throw new Error("Insufficient CKB capacity in valid custodian cells");
    }
    const newChangeCapacity =
      BigInt(inputCkbCapacitySum) -
      BigInt(ckbWithdrawalCapacity) -
      BigInt(outputCkbCapacitySumForSudtCustodianCells);
    ckbChangeCustodian.cell_output.capacity =
      "0x" + newChangeCapacity.toString(16);
    txSkeleton = txSkeleton.update("outputs", (outputs) => {
      return outputs.push(ckbChangeCustodian);
    });
    return txSkeleton;
  }

  _buildWithdrawalLockArgs(
    rawWithdrawalRequest: schemas.RawWithdrawalRequest,
    deposition_block_hash: HexString,
    deposition_block_number: HexNumber,
    withdrawal_block_hash: HexString,
    withdrawal_block_number: HexNumber
  ) {
    return {
      deposition_block_hash: deposition_block_hash,
      deposition_block_number: deposition_block_number,
      withdrawal_block_hash: withdrawal_block_hash,
      withdrawal_block_number: withdrawal_block_number,
      sudt_script_hash: new Reader(
        rawWithdrawalRequest.getSudtScriptHash().raw()
      ).serializeJson(),
      sell_amount: new Reader(
        rawWithdrawalRequest.getAmount().raw()
      ).serializeJson(),
      sell_capacity: new Reader(
        rawWithdrawalRequest.getCapacity().raw()
      ).serializeJson(),
      owner_lock_hash: new Reader(
        rawWithdrawalRequest.getOwnerLockHash().raw()
      ).serializeJson(),
      payment_lock_hash: new Reader(
        rawWithdrawalRequest.getPaymentLockHash().raw()
      ).serializeJson(),
    };
  }

  // valid means finalized and live
  async _queryValidCustodianCells(toBlock: HexNumber): Promise<Cell[]> {
    const collector = this.indexer.collector(
      this._custodianCellQueryOptions(toBlock)
    );
    const cells = [];
    for await (const cell of collector.collect()) {
      cells.push(cell);
    }
    return cells;
  }

  _custodianCellQueryOptions(toBlock: HexNumber): QueryOptions {
    return {
      lock: {
        script: {
          code_hash: this.config.deploymentConfig.custodian_lock.code_hash,
          hash_type: this.config.deploymentConfig.custodian_lock.hash_type,
          args: this.rollupTypeHash,
        },
        argsLen: "any",
      },
      toBlock: toBlock,
    };
  }
  _packCustodianLockArgs(custodianLockArgs: object): HexString {
    const packedCustodianLockArgs = schemas.SerializeCustodianLockArgs(
      types.NormalizeCustodianLockArgs(custodianLockArgs)
    );
    return this._packArgsHelper(packedCustodianLockArgs);
  }

  _packWithdrawalLockArgs(withdrawalLockArgs: object): HexString {
    const packedWithdrawalLockArgs = schemas.SerializeWithdrawalLockArgs(
      types.NormalizeWithdrawalLockArgs(withdrawalLockArgs)
    );
    return this._packArgsHelper(packedWithdrawalLockArgs);
  }

  _packArgsHelper(args: ArrayBuffer): HexString {
    const buffer = new ArrayBuffer(32 + args.byteLength);
    const array = new Uint8Array(buffer);
    array.set(
      new Uint8Array(new Reader(this.rollupTypeHash).toArrayBuffer()),
      0
    );
    array.set(new Uint8Array(args), 32);
    return new Reader(buffer).serializeJson();
  }
}

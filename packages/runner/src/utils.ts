import { RPC, Reader } from "ckb-js-toolkit";
import {
  Cell,
  Header,
  OutPoint,
  Transaction,
  denormalizers,
  since as sinceUtils,
  utils,
} from "@ckb-lumos/base";
import { DepositionRequest } from "@ckb-godwoken/godwoken";
import { DeploymentConfig } from "./config";
import { DepositionLockArgs } from "../schemas/godwoken";

const { DenormalizeScript } = denormalizers;
const { readBigUInt128LE } = utils;

export async function scanDepositionCellsInCommittedL2Block(
  l2Block: Transaction,
  config: DeploymentConfig,
  rpc: RPC
): Promise<Array<DepositionRequest>> {
  const results: Array<DepositionRequest> = [];
  for (const input of l2Block.inputs) {
    const cell = await resolveOutPoint(input.previous_output, rpc);
    const entry = await tryExtractDepositionRequest(cell, config);
    if (entry) {
      results.push(entry.request);
    }
  }
  return results;
}

async function resolveOutPoint(outPoint: OutPoint, rpc: RPC): Promise<Cell> {
  const txStatus = await rpc.get_transaction(outPoint.tx_hash);
  if (!txStatus || !txStatus.transaction) {
    throw new Error(`Transaction ${outPoint.tx_hash} cannot be found!`);
  }
  const tx: Transaction = txStatus.transaction;
  const index = Number(BigInt(outPoint.index));
  if (index >= tx.outputs.length) {
    throw new Error(
      `Transaction ${outPoint.tx_hash} does not have output ${index}!`
    );
  }
  return {
    cell_output: tx.outputs[index],
    data: tx.outputs_data[index],
    out_point: outPoint,
    block_hash: txStatus.tx_status.block_hash,
  };
}

export interface DepositionEntry {
  cell: Cell;
  request: DepositionRequest;
}

export async function tryExtractDepositionRequest(
  cell: Cell,
  config: DeploymentConfig,
  tipHeader?: Header,
  cellHeader?: Header
): Promise<DepositionEntry | undefined> {
  if (
    cell.cell_output.lock.code_hash !== config.deposition_lock.code_hash ||
    cell.cell_output.lock.hash_type !== config.deposition_lock.hash_type
  ) {
    return undefined;
  }
  const args = new Reader(cell.cell_output.lock.args);
  if (args.length() < 32) {
    throw new Error("Invalid args length!");
  }
  const rollupTypeHash = args.serializeJson().substr(0, 66);
  if (rollupTypeHash !== config.rollup_type_hash) {
    return undefined;
  }
  const lockArgs = new DepositionLockArgs(new Reader(rollupTypeHash));
  if (tipHeader) {
    // Timeout validation
    const packedSince = new Reader(
      lockArgs.getCancelTimeout().raw()
    ).serializeJson();
    // TODO: lumos since validation bug
    if (sinceUtils.validateSince(packedSince, tipHeader, cellHeader)) {
      // Since has reached, meaning deposition request has timed out.
      return undefined;
    }
  }
  const isSudt = !!cell.cell_output.type;
  let amount;
  if (isSudt) {
    // SUDT
    amount = "0x" + readBigUInt128LE(cell.data).toString(16);
  } else {
    // CKB
    amount = cell.cell_output.capacity;
  }
  const sudtScript = cell.cell_output.type || {
    code_hash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    hash_type: "data",
    args: "0x",
  };
  return {
    cell,
    request: {
      script: DenormalizeScript(lockArgs.getLayer2Lock()),
      sudt_script: sudtScript,
      amount,
    },
  };
}

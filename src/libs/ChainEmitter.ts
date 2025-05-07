import { AnchorProvider, Program, Provider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonUrl = pathToFileURL(path.join(__dirname, '../../IDL/SwarmEventEmitter.json')).href;

const { default: svmIdl } = await import(jsonUrl, {
  assert: { type: 'json' },
});
import { SwarmEventEmitter, SwarmEventEmitter__factory } from '../types/index.js';

import { ErrorHandler } from './error.js';
import { Logger } from './logger.js';

const CHAIN_TYPE = process.env.CHAIN_TYPE!;
const RPC_URL = process.env.RPC_URL!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const EVM_PRIVATE_KEYS = process.env.EVM_PRIVATE_KEYS!;
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY!;

export class ChainEmitter {
  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private signerIndex = 0;
  private evmProvider?: JsonRpcProvider | WebSocketProvider;
  private evmContract?: SwarmEventEmitter;
  private evmSigners?: Array<ethers.Wallet>;

  private svmProvider?: Provider;
  private svmProgram?: Program;
  private svmKeypair?: Keypair;

  constructor() {
    this.init();
  }

  private init() {
    if (CHAIN_TYPE === 'EVM') {
      this.initEvm();
    } else if (CHAIN_TYPE === 'SVM') {
      this.initSvm();
    } else {
      throw new Error(`Unsupported CHAIN_TYPE: ${CHAIN_TYPE}`);
    }
  }

  private initEvm() {
    this.evmProvider = RPC_URL.startsWith('ws')
      ? new ethers.WebSocketProvider(RPC_URL)
      : new ethers.JsonRpcProvider(RPC_URL);

    const privateKeys = JSON.parse(EVM_PRIVATE_KEYS);
    this.evmSigners = privateKeys.map((key: string) => new ethers.Wallet(key, this.evmProvider));
    this.evmContract = SwarmEventEmitter__factory.connect(CONTRACT_ADDRESS, this.evmProvider);
  }

  private initSvm() {
    this.svmKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(SVM_PRIVATE_KEY)));

    const connection = new Connection(RPC_URL, 'confirmed');
    const wallet = new Wallet(this.svmKeypair);

    this.svmProvider = new AnchorProvider(connection, wallet, {});
    this.svmProgram = new Program(svmIdl, this.svmProvider);
  }

  public async emitEventWithRetry(message: string, retries = 20, delay = 500) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (CHAIN_TYPE === 'EVM') {
          this.logger.info('Emitting EVM event...');
          await this.emitEvm(message);
        } else if (CHAIN_TYPE === 'SVM') {
          this.logger.info('Emitting SVM event...');
          await this.emitSvm(message);
        }

        return;
      } catch (error) {
        this.errorHandler.handleError(error);

        if (attempt < retries) {
          const backoff = delay * attempt;
          this.logger.info(`Retrying in ${backoff}ms...`);
          await new Promise((res) => setTimeout(res, backoff));
        } else {
          this.logger.error('All retry attempts failed.');
        }
      }
    }
  }

  private async emitEvm(message: string) {
    if (!this.evmContract || !this.evmSigners || this.evmSigners.length === 0) {
      throw new Error('EVM contract or signers not initialized');
    }

    const signer = this.evmSigners[this.signerIndex];
    this.signerIndex = (this.signerIndex + 1) % this.evmSigners.length;

    const contractWithSigner = this.evmContract.connect(signer);

    const tx = (await contractWithSigner.emitMessage(message)) as ethers.TransactionResponse;
    await signer.provider!.waitForTransaction(tx.hash);

    this.logger.info(`Emitted EVM event: ${tx.hash}`);
  }

  private async emitSvm(message: string) {
    if (!this.svmProgram || !this.svmKeypair) throw new Error('SVM program not initialized');

    const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('state')], this.svmProgram.programId);

    await this.svmProgram.methods
      .emitMessage(message)
      .accounts({
        state: statePda,
        user: this.svmKeypair.publicKey,
      })
      .signers([this.svmKeypair])
      .rpc();

    this.logger.info('Emitted SVM event');
  }
}

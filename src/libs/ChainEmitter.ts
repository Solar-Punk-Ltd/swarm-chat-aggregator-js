import { AnchorProvider, Program, Provider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';

import evmAbi from '../../ABI/SwarmEventEmitter.json';
import svmIdl from '../../IDL/SwarmEventEmitter.json';

import { ErrorHandler } from './error';
import { Logger } from './logger';

const CHAIN_TYPE = process.env.CHAIN_TYPE!;
const RPC_URL = process.env.RPC_URL!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;

export class ChainEmitter {
  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private evmProvider?: JsonRpcProvider | WebSocketProvider;
  private evmContract?: ethers.Contract;
  private evmSigner?: ethers.Wallet;

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

    this.evmSigner = new ethers.Wallet(PRIVATE_KEY, this.evmProvider);
    this.evmContract = new ethers.Contract(CONTRACT_ADDRESS, evmAbi.abi, this.evmSigner);
  }

  private initSvm() {
    this.svmKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)));

    const connection = new Connection(RPC_URL, 'confirmed');
    const wallet = new Wallet(this.svmKeypair);

    this.svmProvider = new AnchorProvider(connection, wallet, {});
    this.svmProgram = new Program(svmIdl, this.svmProvider);
  }

  public async emitEventWithRetry(message: string, retries = 3, delay = 1500) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (CHAIN_TYPE === 'EVM') {
          await this.emitEvm(message);
        } else if (CHAIN_TYPE === 'SVM') {
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
    if (!this.evmContract) throw new Error('EVM contract not initialized');

    const tx = await this.evmContract.emitMessage(message);
    await tx.wait();
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

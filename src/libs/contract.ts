import { ethers } from 'ethers';

import 'dotenv/config';

import SwarmEventEmitterMeta from '../../ABI/SwarmEventEmitter.json';

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

export const contract = new ethers.Contract(CONTRACT_ADDRESS, SwarmEventEmitterMeta.abi, wallet);

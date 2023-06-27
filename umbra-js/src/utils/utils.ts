/**
 * @dev Assortment of helper methods
 */

import {
  AddressZero,
  BigNumber,
  computeAddress,
  Contract,
  getAddress,
  HashZero,
  isHexString,
  JsonRpcSigner,
  keccak256,
  Overrides,
  resolveProperties,
  serialize as serializeTransaction,
  splitSignature,
  StaticJsonRpcProvider,
  UnsignedTransaction,
} from '../ethers';
import { Point, Signature, utils as nobleUtils } from '@noble/secp256k1';
import { ens, cns } from '..';
import { default as Resolution } from '@unstoppabledomains/resolution';
import { StealthKeyRegistry } from '../classes/StealthKeyRegistry';
import { TxHistoryProvider } from '../classes/TxHistoryProvider';
import { EthersProvider, TransactionResponseExtended } from '../types';

// Lengths of various properties when represented as full hex strings
export const lengths = {
  address: 42, // 20 bytes + 0x prefix
  txHash: 66, // 32 bytes + 0x prefix
  privateKey: 66, // 32 bytes + 0x prefix
  publicKey: 132, // 64 bytes + 0x04 prefix
};

// Define addresses that should never be used as the stealth address. If you're sending to these a mistake was
// made somewhere and the funds will not be accessible. Ensure any addresses added to this list are checksum addresses
export const blockedStealthAddresses = [
  AddressZero,
  '0xdcc703c0E500B653Ca82273B7BFAd8045D85a470', // generated from hashing an empty public key, e.g. keccak256('0x')
  '0x59274E3aE531285c24e3cf57C11771ecBf72d9bf', // generated from hashing the zero public key, e.g. keccak256('0x000...000')
];

/**
 * @notice Given a transaction hash, return the public key of the transaction's sender
 * @dev See https://github.com/ethers-io/ethers.js/issues/700 for an example of
 * recovering public key from a transaction with ethers
 * @param txHash Transaction hash to recover public key from
 * @param provider ethers provider instance
 */
export async function recoverPublicKeyFromTransaction(txHash: string, provider: EthersProvider) {
  // Get transaction data
  if (typeof txHash !== 'string' || txHash.length !== lengths.txHash) {
    throw new Error('Invalid transaction hash provided');
  }
  const tx = await getTransactionByHash(txHash, provider);
  if (!tx) {
    throw new Error('Transaction not found. Are the provider and transaction hash on the same network?');
  }

  // Reconstruct transaction payload that was originally signed. Relevant EIPs:
  //   - https://eips.ethereum.org/EIPS/eip-155  (EIP-155: Simple replay attack protection)
  //   - https://eips.ethereum.org/EIPS/eip-2718 (EIP-2718: Typed Transaction Envelope)
  //   - https://eips.ethereum.org/EIPS/eip-2930 (EIP-2930: Optional access lists)
  //   - https://eips.ethereum.org/EIPS/eip-1559 (EIP-1559: Fee market change for ETH 1.0 chain)
  //
  // Properly defining the `txData` signed by the sender is essential to ensuring sent funds can be
  // accessed by the recipient. This only affects the "advanced mode" option of sending directly
  // to a recipient's standard public key, i.e. is does not affect users sending via the
  // recommended approach of the StealthKeyRegistry.
  //
  // Any time a new transaction type is added to Ethereum, the below will need to be updated to
  // support that transaction type
  const txData: UnsignedTransaction = {};

  // First we add fields that are always required
  txData.type = tx.type;
  txData.nonce = tx.nonce;
  txData.gasLimit = tx.gasLimit;
  txData.to = tx.to;
  txData.value = tx.value;
  txData.data = tx.data;
  if (tx.chainId) {
    txData.chainId = tx.chainId;
  }

  // Now we add fields specific to the transaction type
  if (tx.type === 0 || !tx.type) {
    // LegacyTransaction is rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
    txData.gasPrice = tx.gasPrice;
  } else if (tx.chainId === 42161 && tx.type === 120) {
    // This block is for handling Classic (pre-Nitro) transactions on Arbitrum. If given a legacy
    // transaction hash on Arbitrum, when querying a Nitro node for that pre-nitro tx, the type
    // should be 120. However, if you query classic node for the data, the type would be 0.
    // Different RPC providers handle this differently. For example, `https://arb1.arbitrum.io/rpc`
    // and Infura will return type 120, but Alchemy will return type 0. If type 0 is returned, it's
    // handled by the previous block. If type 120 is returned, we handle it here. This block is
    // required since ethers.js v5 won't serialize transactions unless the `type` is null,  0, 1,
    // or 2, as seen here:
    //   https://github.com/ethers-io/ethers.js/blob/aaf40a1ccedd2664041938f1541d8a0fc3b8ae4d/packages/transactions/src.ts/index.ts#L305-L328
    // These transactions can be serialized the same way as legacy type 0 transactions, so we just
    // override the type here. For reference, the arbitrum transaction type definitions can be
    // found here:
    //  https://github.com/OffchainLabs/go-ethereum/blob/141b0fcdf0e4d8e9e5de3f0466533b86563f2d29/core/types/transaction.go#L54.

    // LegacyTransaction is rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
    txData.gasPrice = tx.gasPrice;
    txData.type = 0;
  } else if (tx.type === 1) {
    // 0x01 || rlp([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, v, r, s])
    txData.gasPrice = tx.gasPrice;
    txData.accessList = tx.accessList;
  } else if (tx.type === 2) {
    // 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, v, r, s])
    txData.accessList = tx.accessList;
    txData.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
    txData.maxFeePerGas = tx.maxFeePerGas;
  } else {
    throw new Error(`Unsupported transaction type: ${tx.type}`);
  }

  // Properly format transaction payload to get the correct message
  const resolvedTx = await resolveProperties(txData);
  const rawTx = serializeTransaction(resolvedTx);
  const msgHash = keccak256(rawTx);

  // Recover sender's public key.
  // Even though the type definitions say v,r,s are optional, they will always be defined: https://github.com/ethers-io/ethers.js/issues/1181
  const signature = new Signature(BigInt(tx.r!), BigInt(tx.s!));
  signature.assertValidity();
  const recoveryParam = splitSignature({ r: tx.r as string, s: tx.s, v: tx.v }).recoveryParam;
  const publicKey = Point.fromSignature(msgHash.slice(2), signature, recoveryParam);
  publicKey.assertValidity();

  // Verify that recovered public key derives to the transaction from address.
  const publicKeyHex = `0x${publicKey.toHex()}`;
  if (computeAddress(publicKeyHex) !== tx.from) {
    throw new Error('Public key not recovered properly');
  }
  return publicKeyHex;
}

/**
 * @notice Returns the transaction hash of the first transaction sent by an address, or
 * undefined if none was found
 * @param address Address to lookup
 * @param provider ethers provider instance
 */
export async function getSentTransaction(address: string, ethersProvider: EthersProvider) {
  address = getAddress(address); // address input validation
  const { chainId } = await ethersProvider.getNetwork();
  const txHistoryProvider = new TxHistoryProvider(chainId);
  const history = await txHistoryProvider.getHistory(address);
  let txHash;
  // Use the first transaction found
  for (let i = 0; i < history.length; i += 1) {
    const tx = history[i];
    if (tx.from === address) {
      // On Arbitrum, we need to make sure this is actually a signed transaction that we can recover a public key
      // from, since not all transactions returned by Etherscan are actually signed transactions: some are just
      // messages. This is a bit inefficient since it's an additional RPC call, and this method just returns the
      // txHash instead of the full transaction data, so we end up  making the same RPC call again later, but
      // that's ok for now. We identify signed transactions by just looking for the presence of a signature.
      if (chainId === 42161) {
        const txData = await getTransactionByHash(tx.hash, ethersProvider);
        const isSignedTx = txData.r !== HashZero && txData.s !== HashZero;
        if (!isSignedTx) continue;
      }
      txHash = tx.hash;
      break;
    }
  }
  return txHash;
}

// Takes an ENS, CNS, or address, and returns the checksummed address
export async function toAddress(name: string, provider: EthersProvider) {
  // First try ENS
  let address: string | null = null;
  address = await resolveEns(name, provider); // will never throw, but returns null on failure
  if (address) return address;

  // Then try CNS
  address = await resolveCns(name); // will never throw, but returns null on failure
  if (address) return address;

  return getAddress(name);
}

/**
 * @notice Returns public keys from the recipientId
 * @dev When providing a public key, transaction hash, or address with advanced mode, the spending and viewing
 * public keys will be the same. Only keys retrieved from the StealthKeyRegistry will have different spending
 * and viewing keys
 * @param id Recipient identifier, must be an ENS name, CNS name, address, transaction hash, or public key
 * @param provider ethers provider to use
 * @param options Object containing lookup options:
 *   advanced: looks for public keys in StealthKeyRegistry when false, recovers them from on-chain transaction when true
 *   supportPubKey: default false, when true allows a public key to be provided directly
 *   supportTxHash: default false, when true allows public key to be recovered from the specified transaction hash
 */
export async function lookupRecipient(
  id: string,
  provider: EthersProvider,
  {
    advanced,
    supportPubKey,
    supportTxHash,
  }: { advanced?: boolean; supportPubKey?: boolean; supportTxHash?: boolean } = {}
) {
  // Check if identifier is a public key. If so we just return that directly
  const isPublicKey = id.length === 132 && isHexString(id);
  if (supportPubKey && isPublicKey) {
    assertValidPoint(id);
    return { spendingPublicKey: id, viewingPublicKey: id };
  }

  // Check if identifier is a transaction hash. If so, we recover the sender's public keys from the transaction
  const isTxHash = id.length === 66 && isHexString(id);
  if (supportTxHash && isTxHash) {
    const publicKey = await recoverPublicKeyFromTransaction(id, provider);
    assertValidPoint(publicKey);
    return { spendingPublicKey: publicKey, viewingPublicKey: publicKey };
  }

  // The remaining checks are dependent on the advanced mode option. The provided identifier is now either an
  // ENS name, CNS name, or address, so we resolve it to an address
  const address = await toAddress(id, provider); // throws if an invalid address is provided

  // If we're not using advanced mode, use the StealthKeyRegistry
  if (!advanced) {
    const registry = new StealthKeyRegistry(provider);
    return registry.getStealthKeys(address);
  }

  // Otherwise, get public key based on the most recent transaction sent by that address
  const txHash = await getSentTransaction(address, provider);
  if (!txHash) throw new Error('Could not get public key because the provided account has not sent any transactions');
  const publicKey = await recoverPublicKeyFromTransaction(txHash, provider);
  assertValidPoint(publicKey);
  return { spendingPublicKey: publicKey, viewingPublicKey: publicKey };
}

export async function getBlockNumberUserRegistered(address: string, startblock = 0, Signer: JsonRpcSigner) {
  address = getAddress(address); // address input validation
  const { chainId } = await Signer.provider.getNetwork();
  const txHistoryProvider = new TxHistoryProvider(chainId);
  const history = await txHistoryProvider.getHistory(address, startblock);
  // Address of the StealthKeyRegistry is the same on all supported networks
  const StealthKeyRegistryAddress = '0x31fe56609C65Cd0C510E7125f051D440424D38f3';
  const registryBlock = history.find((tx) => tx.to === StealthKeyRegistryAddress);
  return registryBlock?.blockNumber;
}

/**
 * @notice Throws if provided public key is not on the secp256k1 curve
 * @param point Uncompressed public key as hex string
 */
export function assertValidPoint(point: string) {
  const isCorrectLength = point.length === 130 || point.length === 132;
  const isCorrectFormat = typeof point === 'string' && isCorrectLength;
  if (!isCorrectFormat) throw new Error('Must provide uncompressed public key as hex string');

  const pointInstance = Point.fromHex(point.length === 130 ? point : point.slice(2));
  pointInstance.assertValidity();
}

/**
 * @notice Throws if provided private key is not valid.
 * @param point Private key as hex string
 */
export function assertValidPrivateKey(key: string) {
  const isCorrectLength = key.length === 64 || key.length === 66;
  const isCorrectFormat = typeof key === 'string' && isCorrectLength;
  if (!isCorrectFormat) throw new Error('Must provide private key as hex string');

  if (key.length === 66) key = key.slice(2);
  if (!nobleUtils.isValidPrivateKey(key)) throw new Error('Invalid private key');
}

/**
 * @notice Returns the public keys associated with the provided name, using the legacy lookup approach.
 * @param name Name or domain to test
 * @param provider ethers provider instance
 */
export async function getPublicKeysLegacy(name: string, provider: EthersProvider) {
  if (!isDomain(name)) throw new Error(`Name ${name} is not a valid domain`);
  try {
    // First try ENS (throws on failure)
    return ens.getPublicKeys(name, provider);
  } catch (e) {
    // Fallback to CNS
    return cns.getPublicKeys(name, provider, getResolutionInstance());
  }
}

/**
 * @notice Returns true if the provided name is a valid domain, without the protocol identifier such as https://
 * @param name Name or domain to test
 */
export function isDomain(name: string) {
  const regex = /^([a-z0-9|-]+\.)*[a-z0-9|-]+\.[a-z]+$/; // https://stackoverflow.com/questions/8959765/need-regex-to-get-domain-subdomain/8959842
  return regex.test(name);
}

// --- Private helper methods ---

/**
 * @notice Returns an instance of the UD Resolution library
 */

function getResolutionInstance() {
  return Resolution.infura(String(process.env.INFURA_ID));
}

/**
 * @notice Attempt to resolve an ENS name, and return null on failure
 * @param name Name to resolve
 * @param provider Provider connected to mainnet. If the provider is connected to a different
 * network, we use the umbra-js default provider instead
 * @returns
 */
async function resolveEns(name: string, provider: EthersProvider) {
  try {
    // Ensure we have a mainnet provider by using the provided provider if it's connected to mainnet,
    // and overriding with a mainnet provider otherwise. This ensures ENS resolution is always done
    // against L1, as explained here: https://twitter.com/makoto_inoue/status/1453737962110275598
    const { chainId } = await provider.getNetwork();
    if (chainId !== 1)
      provider = new StaticJsonRpcProvider(`https://mainnet.infura.io/v3/${String(process.env.INFURA_ID)}`);
    const address = await provider.resolveName(name);
    return address || null;
  } catch (e) {
    return null;
  }
}

/**
 * @notice Attempt to resolve a CNS name, and return null on failure
 * @param name
 * @returns
 */
async function resolveCns(name: string) {
  try {
    const resolution = getResolutionInstance();
    const address = await resolution.addr(name, 'ETH');
    return getAddress(address) || null;
  } catch (e) {
    return null;
  }
}

/**
 * @notice Given a from address, to address, and provider, return parameters needed to sweep all ETH
 * @dev The intent of this method is to facilitate sweeping ETH from a stealth address (EOA) to another
 * account. As a result, we don't consider the chance of the sender being a contract wallet that
 * results in extra gas costs.
 * @param from Address sending ETH
 * @param to Address receiving ETH
 * @param provider Provider to use for querying data
 * @param overrides Optional overrides for gasLimit and gasPrice
 */
export async function getEthSweepGasInfo(
  from: string,
  to: string,
  provider: EthersProvider,
  overrides: Overrides = {}
): Promise<{
  gasPrice: BigNumber;
  gasLimit: BigNumber;
  txCost: BigNumber;
  fromBalance: BigNumber;
  ethToSend: BigNumber;
  chainId: number;
}> {
  const gasLimitOf21k = [1, 4, 5, 10, 100, 137, 1337, 11155111]; // networks where ETH sends cost 21000 gas
  const ignoreGasPriceOverride = [10, 42161]; // to maximize ETH sweeps, ignore uer-specified gasPrice overrides

  const [toAddressCode, network, fromBalance, lastBlockData, providerGasPrice] = await Promise.all([
    provider.getCode(to),
    provider.getNetwork(),
    provider.getBalance(from),
    provider.getBlock('latest'),
    // We use `getGasPrice` instead of `getFeeData` because:
    // (a) getGasPrice returns low estimates whereas getFeeData intentionally returns high estimates
    //     of gas costs, since the latter presumes the post-1559 pricing model in which extra fees
    //     are refunded; we don't want there to be any refunds since we're trying to sweep the account;
    // (b) not all chains support getFeeData and/or 1559 gas pricing, e.g. Avalanche and Optimism.
    provider.getGasPrice(),
  ]);
  const isEoa = toAddressCode === '0x';
  const { chainId } = network;

  // If a gas limit was provided, use it. Otherwise, if we are sending to an EOA and this is a network where ETH
  // transfers always to cost 21000 gas, use 21000. Otherwise, estimate the gas limit.
  const gasLimit = overrides.gasLimit
    ? BigNumber.from(await overrides.gasLimit)
    : isEoa && gasLimitOf21k.includes(chainId)
    ? BigNumber.from('21000')
    : await provider.estimateGas({ gasPrice: 0, to, from, value: fromBalance });

  // Estimate the gas price, defaulting to the given one unless on a network where we want to use provider gas price
  let gasPrice = ignoreGasPriceOverride.includes(chainId)
    ? providerGasPrice
    : BigNumber.from((await overrides.gasPrice) || providerGasPrice);

  // On networks with EIP-1559 gas pricing, the provider will throw an error and refuse to submit
  // the tx if the gas price is less than the block-specified base fee. The error is "max fee
  // per gas less than block base fee". So we need to ensure that the low estimate we're using isn't
  // *too* low. Additionally, if the previous block exceeded the target size, the base fee will be
  // increased by 12.5% for the next block, per:
  //   https://ethereum.org/en/developers/docs/gas/#base-fee
  // To be conservative, therefore, we assume a 12.5% increase will affect the base fee for the
  // transaction we're about to send.
  const baseGasFee = (lastBlockData?.baseFeePerGas || BigNumber.from('0')).mul('1125').div('1000');
  if (gasPrice.lt(baseGasFee)) gasPrice = baseGasFee;

  // For networks with a lot of gas market volatility, we bump the gas price to
  // give us a bit of wiggle room.
  let gasPriceScaleFactor;
  switch (chainId) {
    case 42161:
      gasPriceScaleFactor = '110';
      break;
    default:
      gasPriceScaleFactor = '105';
  }
  gasPrice = gasPrice.mul(gasPriceScaleFactor).div('100');

  let txCost = gasPrice.mul(gasLimit);

  // On Optimism, we ask the gas price oracle for the L1 data fee that we should add on top of the L2 execution
  // cost: https://community.optimism.io/docs/developers/build/transaction-fees/
  // For Arbitrum, this is baked into the gasPrice returned from the provider.
  if (chainId === 10) {
    const nonce = await provider.getTransactionCount(from);
    const gasOracleAbi = ['function getL1Fee(bytes memory _data) public view returns (uint256)'];
    const gasPriceOracle = new Contract('0x420000000000000000000000000000000000000F', gasOracleAbi, provider);
    let l1FeeInWei = await gasPriceOracle.getL1Fee(
      serializeTransaction({ to, value: fromBalance, data: '0x', gasLimit, gasPrice, nonce })
    );

    // We apply a 70% multiplier to the Optimism oracle quote, since it's frequently low
    // by 45+% compared to actual L1 send fees.
    l1FeeInWei = (l1FeeInWei as BigNumber).mul('170').div('100');

    txCost = txCost.add(l1FeeInWei as BigNumber);
  }

  // Return the gas price, gas limit, and the transaction cost
  return { gasPrice, gasLimit, txCost, fromBalance, ethToSend: fromBalance.sub(txCost), chainId };
}

/**
 * @notice Similar to ethers.getTransaction(txHash), but does not filter out non-standard fields
 * like getTransaction does
 * @dev Based on https://github.com/ethers-io/ethers.js/blob/ef1b28e958b50cea7ff44da43b3c5ff054e4b483/packages/providers/src.ts/base-provider.ts#L1832
 */
async function getTransactionByHash(txHash: string, provider: EthersProvider): Promise<TransactionResponseExtended> {
  // Initial response contains all fields, including non-standard fields.
  const params = { transactionHash: provider.formatter.hash(txHash, true) };
  const fullTx = await provider.perform('getTransaction', params);
  if (!fullTx) {
    throw new Error('Transaction hash not found. Are the provider and transaction hash on the same network?'); // prettier-ignore
  }
  // We use the formatter to parse values into the types ethers normally returns, but this strips non-standard fields.
  const partialTx = <TransactionResponseExtended>provider.formatter.transactionResponse(fullTx);
  // Now we add back the missing fields, with custom typing by field.
  const bigNumberFields = new Set(['gas']); // ethers renames this to gasLimit, but for completeness we add `gas` back.
  const numberFields = new Set([
    // Arbitrum.
    'arbSubType',
    'arbType',
    'indexInParent',
    'l1BlockNumber',
    // Optimism.
    'index',
    'l1BlockNumber',
    'l1Timestamp',
    'queueIndex',
  ]);
  const tx = <TransactionResponseExtended>{ ...partialTx };
  const existingFields = new Set(Object.keys(tx));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  Object.keys(fullTx).forEach((key) => {
    // Do nothing if this field already exists (i.e. it was formatted by the ethers formatter).
    if (existingFields.has(key)) return;
    // Otherwise, add the field and format it
    if (bigNumberFields.has('key')) {
      tx.gas = fullTx[key] ? BigNumber.from(fullTx[key]) : null;
    } else if (numberFields.has(key)) {
      tx[key] = fullTx[key] ? BigNumber.from(fullTx[key]).toNumber() : null;
    } else {
      tx[key] = fullTx[key];
    }
  });
  return tx;
}

// --- Compliance ---

export async function assertSupportedAddress(recipientId: string) {
  // Check for public key being passed in, and if so derive the corresponding address.
  if (isHexString(recipientId) && recipientId.length == 132) {
    recipientId = computeAddress(recipientId);
  }

  // If needed, resolve recipient ID to an address (e.g. if it's an ENS name).
  const provider = new StaticJsonRpcProvider(`https://mainnet.infura.io/v3/${String(process.env.INFURA_ID)}`);
  const address = await toAddress(recipientId, provider);
  const errMsg = 'Address is invalid or unavailable';

  // Now check the address against the hardcoded list.
  const bannedAddresses = new Set([
    '0x19Aa5Fe80D33a56D56c78e82eA5E50E5d80b4Dff',
    '0x1da5821544e25c636c1417Ba96Ade4Cf6D2f9B5A',
    '0x2f389cE8bD8ff92De3402FFCe4691d17fC4f6535',
    '0x308eD4B7b49797e1A98D3818bFF6fe5385410370',
    '0x3CBdeD43EFdAf0FC77b9C55F6fC9988fCC9b757d',
    '0x48549A34AE37b12F6a30566245176994e17C6b4A',
    '0x5512d943eD1f7c8a43F3435C85F7aB68b30121b0',
    '0x67d40EE1A85bf4a4Bb7Ffae16De985e8427B6b45',
    '0x6aCDFBA02D390b97Ac2b2d42A63E85293BCc160e',
    '0x6F1cA141A28907F78Ebaa64fb83A9088b02A8352',
    '0x72a5843cc08275C8171E582972Aa4fDa8C397B2A',
    '0x7Db418b5D567A4e0E8c59Ad71BE1FcE48f3E6107',
    '0x7F19720A857F834887FC9A7bC0a0fBe7Fc7f8102',
    '0x7F367cC41522cE07553e823bf3be79A889DEbe1B',
    '0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C',
    '0x901bb9583b24D97e995513C6778dc6888AB6870e',
    '0x9F4cda013E354b8fC285BF4b9A60460cEe7f7Ea9',
    '0xA7e5d5A720f06526557c513402f2e6B5fA20b008',
    '0xC455f7fd3e0e12afd51fba5c106909934D8A0e4a',
    '0xd882cFc20F52f2599D84b8e8D58C7FB62cfE344b',
    '0xe7aa314c77F4233C18C6CC84384A9247c0cf367B',
    '0xfEC8A60023265364D066a1212fDE3930F6Ae8da7',
    '0x7FF9cFad3877F21d41Da833E2F775dB0569eE3D9',
    '0x098B716B8Aaf21512996dC57EB0615e2383E2f96',
    '0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B',
    '0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073',
    '0x53b6936513e738f44FB50d2b9476730C0Ab3Bfc1',
    '0x35fB6f6DB4fb05e6A4cE86f2C93691425626d4b1',
    '0xF7B31119c2682c88d88D455dBb9d5932c65Cf1bE',
    '0x3e37627dEAA754090fBFbb8bd226c1CE66D255e9',
    '0x08723392Ed15743cc38513C4925f5e6be5c17243',
    '0x8589427373D6D84E98730D7795D8f6f8731FDA16',
    '0x722122dF12D4e14e13Ac3b6895a86e84145b6967',
    '0xDD4c48C0B24039969fC16D1cdF626eaB821d3384',
    '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b',
    '0xd96f2B1c14Db8458374d9Aca76E26c3D18364307',
    '0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D',
    '0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3',
    '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF',
    '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291',
    '0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144',
    '0xF60dD140cFf0706bAE9Cd734Ac3ae76AD9eBC32A',
    '0x22aaA7720ddd5388A3c0A3333430953C68f1849b',
    '0xBA214C1c1928a32Bffe790263E38B4Af9bFCD659',
    '0xb1C8094B234DcE6e03f10a5b673c1d8C69739A00',
    '0x527653eA119F3E6a1F5BD18fbF4714081D7B31ce',
    '0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2',
    '0xD691F27f38B395864Ea86CfC7253969B409c362d',
    '0xaEaaC358560e11f52454D997AAFF2c5731B6f8a6',
    '0x1356c899D8C9467C7f71C195612F8A395aBf2f0a',
    '0xA60C772958a3eD56c1F15dD055bA37AC8e523a0D',
    '0x169AD27A470D064DEDE56a2D3ff727986b15D52B',
    '0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f',
    '0xF67721A2D8F736E75a49FdD7FAd2e31D8676542a',
    '0x9AD122c22B14202B4490eDAf288FDb3C7cb3ff5E',
    '0x905b63Fff465B9fFBF41DeA908CEb12478ec7601',
    '0x07687e702b410Fa43f4cB4Af7FA097918ffD2730',
    '0x94A1B5CdB22c43faab4AbEb5c74999895464Ddaf',
    '0xb541fc07bC7619fD4062A54d96268525cBC6FfEF',
    '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc',
    '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936',
    '0x23773E65ed146A459791799d01336DB287f25334',
    '0xD21be7248e0197Ee08E0c20D4a96DEBdaC3D20Af',
    '0x610B717796ad172B316836AC95a2ffad065CeaB4',
    '0x178169B423a011fff22B9e3F3abeA13414dDD0F1',
    '0xbB93e510BbCD0B7beb5A853875f9eC60275CF498',
    '0x2717c5e28cf931547B621a5dddb772Ab6A35B701',
    '0x03893a7c7463AE47D46bc7f091665f1893656003',
    '0xCa0840578f57fE71599D29375e16783424023357',
    '0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2',
    '0x8589427373D6D84E98730D7795D8f6f8731FDA16',
    '0x722122dF12D4e14e13Ac3b6895a86e84145b6967',
    '0xDD4c48C0B24039969fC16D1cdF626eaB821d3384',
    '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b',
    '0xd96f2B1c14Db8458374d9Aca76E26c3D18364307',
    '0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D',
  ]);
  if (bannedAddresses.has(address)) throw new Error(errMsg);

  // Next we check against the Chainalysis contract.
  const abi = ['function isSanctioned(address addr) external view returns (bool)'];
  const contract = new Contract('0x40C57923924B5c5c5455c48D93317139ADDaC8fb', abi, provider);
  if (await contract.isSanctioned(address)) throw new Error(errMsg);
  return true;
}

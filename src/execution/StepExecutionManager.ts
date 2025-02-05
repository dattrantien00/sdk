/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  TransactionRequest,
  TransactionResponse,
} from '@ethersproject/abstract-provider'
import { Execution, ExtendedTransactionInfo, FullStatusData } from '@lifi/types'
import { BigNumber } from 'ethers'
import { checkAllowance } from '../allowance'
import { checkBalance } from '../balance'
import ApiService from '../services/ApiService'
import ChainsService from '../services/ChainsService'
import { BaseTransaction, ExecutionParams } from '../types'
import {
  LifiErrorCode,
  TransactionError,
  ValidationError,
} from '../utils/errors'
import { getProvider } from '../utils/getProvider'
import { getTransactionFailedMessage, parseError } from '../utils/parseError'
import { isZeroAddress, personalizeStep } from '../utils/utils'
import { stepComparison } from './stepComparison'
import { switchChain } from './switchChain'
import { getSubstatusMessage, waitForReceivingTransaction } from './utils'

import ConfigService from '../services/ConfigService'
import { updateMultisigRouteProcess } from './multisig'

export class StepExecutionManager {
  allowUserInteraction = true

  allowInteraction = (value: boolean): void => {
    this.allowUserInteraction = value
  }

  execute = async ({
    signer,
    step,
    statusManager,
    settings,
  }: ExecutionParams): Promise<Execution> => {
    const config = ConfigService.getInstance().getConfig()
    const isMultisigSigner = !!config.multisigConfig?.isMultisigSigner

    const multisigBatchTransactions: BaseTransaction[] = []

    const shouldBatchTransactions =
      config.multisigConfig?.shouldBatchTransactions &&
      !!config.multisigConfig.sendBatchTransaction

    step.execution = statusManager.initExecutionObject(step)

    const chainsService = ChainsService.getInstance()
    const fromChain = await chainsService.getChainById(step.action.fromChainId)
    const toChain = await chainsService.getChainById(step.action.toChainId)

    const isBridgeExecution = fromChain.id !== toChain.id
    const currentProcessType = isBridgeExecution ? 'CROSS_CHAIN' : 'SWAP'

    // STEP 1: Check allowance
    const existingProcess = step.execution.process.find(
      (p) => p.type === currentProcessType
    )

    // Check token approval only if fromToken is not the native token => no approval needed in that case

    const checkForAllowance =
      !existingProcess?.txHash &&
      !isZeroAddress(step.action.fromToken.address) &&
      (shouldBatchTransactions || !isMultisigSigner)

    if (checkForAllowance) {
      const populatedTransaction = await checkAllowance(
        signer,
        step,
        statusManager,
        settings,
        fromChain,
        this.allowUserInteraction,
        shouldBatchTransactions
      )

      if (populatedTransaction) {
        const { to, data } = populatedTransaction

        if (to && data) {
          // allowance doesn't need value
          const cleanedPopulatedTransaction: BaseTransaction = {
            value: BigNumber.from(0).toString(),
            to,
            data,
          }

          multisigBatchTransactions.push(cleanedPopulatedTransaction)
        }
      }
    }

    // STEP 2: Get transaction
    let process = statusManager.findOrCreateProcess(step, currentProcessType)

    if (process.status !== 'DONE') {
      const multisigProcess = step.execution.process.find(
        (p) => !!p.multisigTxHash
      )

      try {
        if (isMultisigSigner && multisigProcess) {
          if (!multisigProcess) {
            throw new ValidationError('Multisig process is undefined.')
          }
          if (!config.multisigConfig?.getMultisigTransactionDetails) {
            throw new ValidationError(
              '"getMultisigTransactionDetails()" is missing in Multisig config.'
            )
          }

          const multisigTxHash = multisigProcess.multisigTxHash

          if (!multisigTxHash) {
            // need to check what happens in failed tx
            throw new ValidationError(
              'Multisig internal transaction hash is undefined.'
            )
          }

          await updateMultisigRouteProcess(
            multisigTxHash,
            step,
            statusManager,
            process,
            fromChain
          )
        }

        let transaction: Partial<TransactionResponse>
        if (process.txHash) {
          // Make sure that the chain is still correct
          const updatedSigner = await switchChain(
            signer,
            statusManager,
            step,
            settings.switchChainHook,
            this.allowUserInteraction
          )

          if (!updatedSigner) {
            // Chain switch was not successful, stop execution here
            return step.execution
          }

          signer = updatedSigner

          // Load exiting transaction
          transaction = await getProvider(signer).getTransaction(process.txHash)
        } else {
          process = statusManager.updateProcess(step, process.type, 'STARTED')

          // Check balance
          await checkBalance(signer, step)

          // Create new transaction
          if (!step.transactionRequest) {
            const personalizedStep = await personalizeStep(signer, step)
            const updatedStep =
              await ApiService.getStepTransaction(personalizedStep)
            const comparedStep = await stepComparison(
              statusManager,
              personalizedStep,
              updatedStep,
              settings,
              this.allowUserInteraction
            )
            step = {
              ...comparedStep,
              execution: step.execution,
            }
          }

          const { transactionRequest } = step

          if (!transactionRequest) {
            throw new TransactionError(
              LifiErrorCode.TransactionUnprepared,
              'Unable to prepare transaction.'
            )
          }

          // STEP 3: Send the transaction
          // Make sure that the chain is still correct
          const updatedSigner = await switchChain(
            signer,
            statusManager,
            step,
            settings.switchChainHook,
            this.allowUserInteraction
          )

          if (!updatedSigner) {
            // Chain switch was not successful, stop execution here
            return step.execution!
          }

          signer = updatedSigner

          process = statusManager.updateProcess(
            step,
            process.type,
            'ACTION_REQUIRED'
          )

          if (!this.allowUserInteraction) {
            return step.execution!
          }

          if (settings.updateTransactionRequestHook) {
            const customConfig: TransactionRequest =
              await settings.updateTransactionRequestHook(transactionRequest)

            transactionRequest.gasLimit = customConfig.gasLimit
            transactionRequest.gasPrice = customConfig.gasPrice
            transactionRequest.maxPriorityFeePerGas =
              customConfig.maxPriorityFeePerGas
            transactionRequest.maxFeePerGas = customConfig.maxFeePerGas
          } else {
            try {
              const estimatedGasLimit =
                await signer.estimateGas(transactionRequest)

              if (estimatedGasLimit) {
                transactionRequest.gasLimit = BigNumber.from(
                  `${(BigInt(estimatedGasLimit.toString()) * 125n) / 100n}`
                )
              }

              // Fetch latest gasPrice from provider and use it
              const gasPrice = await signer.getGasPrice()

              if (gasPrice) {
                transactionRequest.gasPrice = gasPrice
              }
            } catch (error) {}
          }

          // Submit the transaction

          if (
            shouldBatchTransactions &&
            config.multisigConfig?.sendBatchTransaction
          ) {
            const { to, data, value } =
              await signer.populateTransaction(transactionRequest)

            const isValidTransaction = to && data

            if (isValidTransaction) {
              const populatedTransaction: BaseTransaction = {
                value: value?.toString() ?? BigNumber.from(0).toString(),
                to,
                data: data.toString(),
              }
              multisigBatchTransactions.push(populatedTransaction)

              transaction = await config.multisigConfig?.sendBatchTransaction(
                multisigBatchTransactions
              )
            } else {
              throw new TransactionError(
                LifiErrorCode.TransactionUnprepared,
                'Unable to prepare transaction.'
              )
            }
          } else {
            transaction = await signer.sendTransaction(transactionRequest)
          }

          // STEP 4: Wait for the transaction
          if (isMultisigSigner) {
            process = statusManager.updateProcess(
              step,
              process.type,
              'ACTION_REQUIRED',
              {
                multisigTxHash: transaction.hash,
              }
            )
          } else {
            process = statusManager.updateProcess(
              step,
              process.type,
              'PENDING',
              {
                txHash: transaction.hash,
                txLink:
                  fromChain.metamask.blockExplorerUrls[0] +
                  'tx/' +
                  transaction.hash,
              }
            )
          }
        }

        await transaction.wait?.()

        // if it's multisig signer and the process is in ACTION_REQUIRED
        // then signatures are still needed
        if (
          isMultisigSigner &&
          process.status === 'ACTION_REQUIRED' &&
          transaction.hash
        ) {
          // Return the execution object without updating the process
          // The execution would progress once all multisigs signer approve

          await updateMultisigRouteProcess(
            transaction.hash,
            step,
            statusManager,
            process,
            fromChain
          )
        }

        if (!isMultisigSigner) {
          process = statusManager.updateProcess(step, process.type, 'PENDING', {
            txHash: transaction.hash,
            txLink:
              fromChain.metamask.blockExplorerUrls[0] +
              'tx/' +
              transaction.hash,
          })
        }

        if (isBridgeExecution) {
          process = statusManager.updateProcess(step, process.type, 'DONE')
        }
      } catch (e: any) {
        if (e.code === 'TRANSACTION_REPLACED' && e.replacement) {
          process = statusManager.updateProcess(step, process.type, 'DONE', {
            txHash: e.replacement.hash,
            txLink:
              fromChain.metamask.blockExplorerUrls[0] +
              'tx/' +
              e.replacement.hash,
          })
        } else {
          const error = await parseError(e, step, process)
          process = statusManager.updateProcess(step, process.type, 'FAILED', {
            error: {
              message: error.message,
              htmlMessage: error.htmlMessage,
              code: error.code,
            },
          })
          statusManager.updateExecution(step, 'FAILED')
          throw error
        }
      }
    }

    // STEP 5: Wait for the receiving chain
    const processTxHash = process.txHash
    if (isBridgeExecution) {
      process = statusManager.findOrCreateProcess(
        step,
        'RECEIVING_CHAIN',
        'PENDING'
      )
    }
    let statusResponse: FullStatusData
    try {
      if (!processTxHash) {
        throw new Error('Transaction hash is undefined.')
      }
      statusResponse = (await waitForReceivingTransaction(
        processTxHash,
        statusManager,
        process.type,
        step
      )) as FullStatusData

      const statusReceiving =
        statusResponse.receiving as ExtendedTransactionInfo

      process = statusManager.updateProcess(step, process.type, 'DONE', {
        substatus: statusResponse.substatus,
        substatusMessage:
          statusResponse.substatusMessage ||
          getSubstatusMessage(statusResponse.status, statusResponse.substatus),
        txHash: statusReceiving?.txHash,
        txLink:
          toChain.metamask.blockExplorerUrls[0] +
          'tx/' +
          statusReceiving?.txHash,
      })

      statusManager.updateExecution(step, 'DONE', {
        fromAmount: statusResponse.sending.amount,
        toAmount: statusReceiving?.amount,
        toToken: statusReceiving?.token,
        gasAmount: statusResponse.sending.gasAmount,
        gasAmountUSD: statusResponse.sending.gasAmountUSD,
        gasPrice: statusResponse.sending.gasPrice,
        gasToken: statusResponse.sending.gasToken,
        gasUsed: statusResponse.sending.gasUsed,
      })
    } catch (e: unknown) {
      const htmlMessage = await getTransactionFailedMessage(
        step,
        process.txLink
      )

      process = statusManager.updateProcess(step, process.type, 'FAILED', {
        error: {
          code: LifiErrorCode.TransactionFailed,
          message: 'Failed while waiting for receiving chain.',
          htmlMessage,
        },
      })
      statusManager.updateExecution(step, 'FAILED')
      console.warn(e)
      throw e
    }

    // DONE
    return step.execution!
  }
}

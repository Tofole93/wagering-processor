import { describe, expect, it, mock } from 'bun:test';
import { WagersController } from '../../src/wagers/wagers.controller.js';
import { WagersService } from '../../src/wagers/wagers.service.js';

describe('WagersController', () => {
    it('exige o cabeçalho Idempotency-Key', async () => {
        const service = {
            submitWithResult: mock(async () => {
                throw new Error('Não deveria chamar o serviço');
            }),
        };

        const controller = new WagersController(
            service as unknown as WagersService,
        );

        const request = {
            providerId: 'test-provider',
            externalTransactionId: 'bet-controller-001',
            walletId: 'c377174e-915e-4688-bf0f-c814f291b4b8',
            playerId: 'b2c3d4e5-f678-4901-8234-56789abcdef0',
            roundId: 'round-001',
            gameId: 'game-001',
            kind: 'BET' as const,
            money: {
                amount: '10.00',
                currency: 'BRL',
            },
        };

        await expect(
            controller.submit(request, '   '),
        ).rejects.toThrow('Idempotency-Key');

        expect(service.submitWithResult).not.toHaveBeenCalled();
    });

    it('encaminha a chave de idempotência e os dados convertidos ao serviço', async () => {
        const transaction = {
            id: 'transaction-001',
            status: 'PROCESSED',
        };
        const service = {
            submitWithResult: mock(async () => ({
                transaction: transaction as any,
                balance: {
                    amount: '90.00',
                    currency: 'BRL',
                },
                idempotentReplay: false,
            })),
        };

        const controller = new WagersController(
            service as unknown as WagersService,
        );

        const request = {
            providerId: 'test-provider',
            externalTransactionId: 'bet-controller-002',
            walletId: 'c377174e-915e-4688-bf0f-c814f291b4b8',
            playerId: 'b2c3d4e5-f678-4901-8234-56789abcdef0',
            roundId: 'round-001',
            gameId: 'game-001',
            kind: 'BET' as const,
            money: {
                amount: '10.00',
                currency: 'BRL',
            },
        };

        const result = await controller.submit(request, 'key-controller-002');

        expect(result).toEqual({
            transactionId: 'transaction-001',
            status: 'PROCESSED',
            balance: {
                amount: '90.00',
                currency: 'BRL',
            },
            idempotentReplay: false,
        });
        expect(service.submitWithResult).toHaveBeenCalledWith({
            providerId: 'test-provider',
            externalTransactionId: 'bet-controller-002',
            idempotencyKey: 'key-controller-002',
            walletId: 'c377174e-915e-4688-bf0f-c814f291b4b8',
            playerId: 'b2c3d4e5-f678-4901-8234-56789abcdef0',
            roundId: 'round-001',
            gameId: 'game-001',
            kind: 'BET',
            amount: '10.00',
            currency: 'BRL',
        });
    });

});

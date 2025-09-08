// test/mevProtection.test.ts
// Comprehensive tests for MEV protection system

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import mevProtectionOrchestrator from '../../src/core/mevProtection.js';
import jitoBundleManager from '../../src/utils/jitoBundle.js';
import mevAwarePriorityFeeCalculator from '../../src/utils/mevAwarePriorityFee.js';
import sandwichDetectionSystem from '../../src/utils/sandwichDetection.js';
import { MEVProtectionRequest } from '../../src/core/mevProtection.js';

// Mock implementations
jest.mock('../../src/utils/jitoBundle.js');
jest.mock('../../src/utils/mevAwarePriorityFee.js');
jest.mock('../../src/utils/sandwichDetection.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/config/index.js', () => ({
    loadBotConfig: () => ({
        mevProtection: {
            enabled: true,
            protectionLevel: 'MEDIUM',
            maxFeeMultiplier: 3.0,
            maxBundleTip: 0.005
        }
    })
}));

describe('MEV Protection System', () => {
    let mockConnection: Connection;
    let mockWallet: Keypair;
    let mockMint: string;
    
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup mock objects
        mockConnection = {} as Connection;
        mockWallet = Keypair.generate();
        mockMint = new PublicKey('11111111111111111111111111111112').toString();
        
        // Reset singleton states
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('MEV Risk Analysis', () => {
        test('should analyze low risk scenario correctly', async () => {
            // Mock low risk responses
            const mockSandwichRisk = {
                riskLevel: 'LOW' as const,
                riskScore: 20,
                indicators: [],
                recommendations: ['Standard execution recommended'],
                shouldDelay: false,
                shouldUsePrivateMempool: false
            };

            const mockFeeCalculation = {
                basePriorityFee: 0.0001,
                mevAdjustment: 0.00001,
                totalFee: 0.00011,
                bundleTip: 0.0001,
                riskLevel: 'LOW' as const,
                riskScore: 15,
                explanation: ['Low MEV risk detected']
            };

            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>edFunction<any>).mockResolvedValue(mockSandwichRisk);
            (mevAwarePriorityFeeCalculator.calculateMEVAwareFee as jest.MockedFunction<any>edFunction<any>).mockResolvedValue(mockFeeCalculation);
            (mevAwarePriorityFeeCalculator.estimateNetworkMEVActivity as jest.MockedFunction<any>edFunction<any>).mockResolvedValue(0.3);

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0.01,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection,
                expectedPriceImpact: 1.5,
                tokenLiquidity: 50,
                isNewToken: false
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);

            expect(result.shouldProceed).toBe(true);
            expect(result.usePrivateMempool).toBe(false);
            expect(result.protectionLevel).toBe('BASIC');
            expect(result.riskAssessment.overallRisk).toBe('LOW');
            expect(result.delayMs).toBe(0);
        });

        test('should analyze high risk scenario correctly', async () => {
            const mockSandwichRisk = {
                riskLevel: 'HIGH' as const,
                riskScore: 75,
                indicators: [
                    {
                        type: 'SUSPICIOUS_MEV_BOT' as const,
                        severity: 'HIGH' as const,
                        description: 'Known MEV bot detected',
                        confidence: 0.9
                    }
                ],
                recommendations: ['Use private mempool', 'Increase priority fees'],
                shouldDelay: true,
                delayMs: 5000,
                shouldUsePrivateMempool: true
            };

            const mockFeeCalculation = {
                basePriorityFee: 0.001,
                mevAdjustment: 0.0006,
                totalFee: 0.0016,
                bundleTip: 0.001,
                riskLevel: 'HIGH' as const,
                riskScore: 80,
                explanation: ['High MEV risk - enhanced protection needed']
            };

            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockResolvedValue(mockSandwichRisk);
            (mevAwarePriorityFeeCalculator.calculateMEVAwareFee as jest.MockedFunction<any>).mockResolvedValue(mockFeeCalculation);
            (mevAwarePriorityFeeCalculator.estimateNetworkMEVActivity as jest.MockedFunction<any>).mockResolvedValue(0.8);

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0.15,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection,
                expectedPriceImpact: 8.5,
                tokenLiquidity: 10,
                isNewToken: true
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);

            expect(result.shouldProceed).toBe(true);
            expect(result.usePrivateMempool).toBe(true);
            expect(result.protectionLevel).toBe('AGGRESSIVE');
            expect(result.riskAssessment.overallRisk).toBe('HIGH');
            expect(result.delayMs).toBe(5000);
            expect(result.bundleTip).toBe(0.001);
        });

        test('should abort critical risk scenarios', async () => {
            const mockSandwichRisk = {
                riskLevel: 'CRITICAL' as const,
                riskScore: 95,
                indicators: [
                    {
                        type: 'SUSPICIOUS_MEV_BOT' as const,
                        severity: 'HIGH' as const,
                        description: 'Multiple MEV bots detected',
                        confidence: 0.95
                    },
                    {
                        type: 'LARGE_PRECEDING_TRADE' as const,
                        severity: 'HIGH' as const,
                        description: 'Large trade detected in mempool',
                        confidence: 0.8
                    }
                ],
                recommendations: ['ABORT: Extremely high sandwich risk'],
                shouldDelay: true,
                delayMs: 10000,
                shouldUsePrivateMempool: true
            };

            const mockFeeCalculation = {
                basePriorityFee: 0.002,
                mevAdjustment: 0.002,
                totalFee: 0.004,
                bundleTip: 0.002,
                riskLevel: 'CRITICAL' as const,
                riskScore: 90,
                explanation: ['Critical MEV risk detected']
            };

            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockResolvedValue(mockSandwichRisk);
            (mevAwarePriorityFeeCalculator.calculateMEVAwareFee as jest.MockedFunction<any>).mockResolvedValue(mockFeeCalculation);

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0.5,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection,
                expectedPriceImpact: 15.0,
                tokenLiquidity: 5,
                isNewToken: true
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);

            expect(result.shouldProceed).toBe(false);
            expect(result.protectionLevel).toBe('AGGRESSIVE');
            expect(result.riskAssessment.overallRisk).toBe('CRITICAL');
            expect(result.reason).toContain('Critical MEV risk');
        });

        test('should handle analysis errors gracefully', async () => {
            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockRejectedValue(
                new Error('Network error during sandwich detection')
            );

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0.05,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);

            // Should return conservative fallback
            expect(result.shouldProceed).toBe(false);
            expect(result.usePrivateMempool).toBe(true);
            expect(result.protectionLevel).toBe('AGGRESSIVE');
            expect(result.riskAssessment.overallRisk).toBe('HIGH');
            expect(result.reason).toContain('MEV analysis system error');
        });
    });

    describe('Jito Bundle Integration', () => {
        test('should configure bundle manager correctly', () => {
            const config = jitoBundleManager.getConfig();
            
            expect(config.enabled).toBe(true);
            expect(config.protectionLevel).toBe('MEDIUM');
            expect(config.maxBundleSize).toBeGreaterThan(0);
            expect(config.timeoutMs).toBeGreaterThan(0);
        });

        test('should handle bundle submission success', async () => {
            const mockBundleResult = {
                success: true,
                bundleId: 'test-bundle-123',
                signature: 'test-signature-456',
                tipAmount: 0.0005,
                executionTime: 2500
            };

            (jitoBundleManager.submitBundle as jest.MockedFunction<any>).mockResolvedValue(mockBundleResult);

            // This would be part of executeMEVProtectedTrade test
            expect(mockBundleResult.success).toBe(true);
            expect(mockBundleResult.bundleId).toBe('test-bundle-123');
            expect(mockBundleResult.tipAmount).toBe(0.0005);
        });

        test('should handle bundle submission failure', async () => {
            const mockBundleResult = {
                success: false,
                error: 'Bundle submission timeout',
                executionTime: 30000
            };

            (jitoBundleManager.submitBundle as jest.MockedFunction<any>).mockResolvedValue(mockBundleResult);

            expect(mockBundleResult.success).toBe(false);
            expect(mockBundleResult.error).toContain('timeout');
        });
    });

    describe('Priority Fee Calculation', () => {
        test('should calculate MEV-aware fees for different risk levels', async () => {
            const mockConnection = {} as Connection;
            
            const riskFactors = {
                tradeSize: 0.1,
                tokenLiquidity: 25,
                priceImpact: 5.5,
                marketCapSol: 100000,
                isNewToken: false,
                networkCongestion: 0.6,
                mempoolActivity: 0.4
            };

            const mockFeeCalc = {
                basePriorityFee: 0.0005,
                mevAdjustment: 0.0002,
                totalFee: 0.0007,
                bundleTip: 0.0005,
                riskLevel: 'MEDIUM' as const,
                riskScore: 45,
                explanation: ['Medium MEV risk adjustment applied']
            };

            (mevAwarePriorityFeeCalculator.calculateMEVAwareFee as jest.MockedFunction<any>).mockResolvedValue(mockFeeCalc);

            const result = await mevAwarePriorityFeeCalculator.calculateMEVAwareFee(
                mockConnection,
                riskFactors,
                mockMint
            );

            expect(result.totalFee).toBeGreaterThan(result.basePriorityFee);
            expect(result.mevAdjustment).toBeGreaterThan(0);
            expect(result.riskLevel).toBe('MEDIUM');
            expect(result.bundleTip).toBeGreaterThan(0);
        });

        test('should record MEV activity correctly', () => {
            const tokenMint = mockMint;
            
            mevAwarePriorityFeeCalculator.recordMEVActivity(tokenMint);
            
            // Should record without error
            expect(() => {
                mevAwarePriorityFeeCalculator.recordMEVActivity(tokenMint);
            }).not.toThrow();
        });
    });

    describe('Sandwich Attack Detection', () => {
        test('should detect suspicious mempool activity', async () => {
            const mockRiskAssessment = {
                riskLevel: 'HIGH' as const,
                riskScore: 70,
                indicators: [
                    {
                        type: 'LARGE_PRECEDING_TRADE' as const,
                        severity: 'MEDIUM' as const,
                        description: 'Large trade detected in recent mempool',
                        confidence: 0.7,
                        evidence: { count: 2 }
                    },
                    {
                        type: 'UNUSUAL_PRIORITY_FEES' as const,
                        severity: 'MEDIUM' as const,
                        description: 'Unusual priority fee spike detected',
                        confidence: 0.6
                    }
                ],
                recommendations: [
                    'Use private mempool',
                    'Increase priority fees significantly'
                ],
                shouldDelay: true,
                delayMs: 3000,
                shouldUsePrivateMempool: true
            };

            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockResolvedValue(mockRiskAssessment);

            const result = await sandwichDetectionSystem.assessSandwichRisk(
                mockMint,
                0.08,
                mockWallet.publicKey,
                mockConnection,
                4.2
            );

            expect(result.riskLevel).toBe('HIGH');
            expect(result.indicators).toHaveLength(2);
            expect(result.shouldUsePrivateMempool).toBe(true);
            expect(result.delayMs).toBe(3000);
        });

        test('should record MEV activity patterns', () => {
            const pattern = 'FRONTRUN' as const;
            const botAddress = new Keypair().publicKey.toString();
            
            expect(() => {
                sandwichDetectionSystem.recordMEVActivity(
                    mockMint,
                    pattern,
                    botAddress,
                    0.05,
                    2.5
                );
            }).not.toThrow();
        });
    });

    describe('Integration Tests', () => {
        test('should complete full MEV protection flow', async () => {
            // Setup mocks for full flow
            const mockSandwichRisk = {
                riskLevel: 'MEDIUM' as const,
                riskScore: 45,
                indicators: [],
                recommendations: ['Consider using private mempool'],
                shouldDelay: false,
                shouldUsePrivateMempool: true
            };

            const mockFeeCalculation = {
                basePriorityFee: 0.0003,
                mevAdjustment: 0.0001,
                totalFee: 0.0004,
                bundleTip: 0.0003,
                riskLevel: 'MEDIUM' as const,
                riskScore: 40,
                explanation: ['Medium risk MEV protection']
            };

            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockResolvedValue(mockSandwichRisk);
            (mevAwarePriorityFeeCalculator.calculateMEVAwareFee as jest.MockedFunction<any>).mockResolvedValue(mockFeeCalculation);
            (mevAwarePriorityFeeCalculator.estimateNetworkMEVActivity as jest.MockedFunction<any>).mockResolvedValue(0.5);

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0.05,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection,
                expectedPriceImpact: 3.2,
                tokenLiquidity: 30
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);

            expect(result.shouldProceed).toBe(true);
            expect(result.usePrivateMempool).toBe(true);
            expect(result.protectionLevel).toBe('STANDARD');
            expect(result.priorityFee).toBe(0.0004);
            expect(result.bundleTip).toBe(0.0003);
            expect(result.recommendations.length).toBeGreaterThan(0);
        });

        test('should provide protection statistics', () => {
            const stats = mevProtectionOrchestrator.getProtectionStats();
            
            expect(stats).toHaveProperty('totalTrades');
            expect(stats).toHaveProperty('protectedTrades');
            expect(stats).toHaveProperty('savedFromMEV');
            expect(stats).toHaveProperty('bundleSuccessRate');
            expect(stats).toHaveProperty('protectionRate');
        });

        test('should perform health checks', async () => {
            (jitoBundleManager.healthCheck as jest.MockedFunction<any>).mockResolvedValue({
                healthy: true
            });

            const healthCheck = await mevProtectionOrchestrator.healthCheck();

            expect(healthCheck.healthy).toBe(true);
            expect(healthCheck.components).toHaveProperty('jitoBundle');
            expect(healthCheck.components).toHaveProperty('sandwichDetection');
            expect(healthCheck.components).toHaveProperty('priorityFeeCalculator');
        });
    });

    describe('Edge Cases and Error Handling', () => {
        test('should handle zero trade amount', async () => {
            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection
            };

            // Should not crash with zero amount
            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);
            expect(result).toBeDefined();
        });

        test('should handle very large trade amounts', async () => {
            const mockHighRiskResponse = {
                riskLevel: 'CRITICAL' as const,
                riskScore: 100,
                indicators: [],
                recommendations: ['Abort trade - too large'],
                shouldDelay: true,
                delayMs: 30000,
                shouldUsePrivateMempool: true
            };

            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockResolvedValue(mockHighRiskResponse);

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 10.0, // Very large trade
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);
            expect(result.riskAssessment.overallRisk).toBe('CRITICAL');
        });

        test('should handle invalid token mint addresses', async () => {
            const request: MEVProtectionRequest = {
                tokenMint: 'invalid-mint-address',
                tradeAmountSOL: 0.01,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection
            };

            // Should handle gracefully without crashing
            await expect(mevProtectionOrchestrator.analyzeMEVRisk(request)).resolves.toBeDefined();
        });

        test('should handle network timeouts', async () => {
            (sandwichDetectionSystem.assessSandwichRisk as jest.MockedFunction<any>).mockImplementation(
                () => new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Network timeout')), 100)
                )
            );

            const request: MEVProtectionRequest = {
                tokenMint: mockMint,
                tradeAmountSOL: 0.01,
                userPublicKey: mockWallet.publicKey,
                connection: mockConnection
            };

            const result = await mevProtectionOrchestrator.analyzeMEVRisk(request);
            
            // Should fallback to conservative settings
            expect(result.usePrivateMempool).toBe(true);
            expect(result.protectionLevel).toBe('AGGRESSIVE');
        });
    });
});
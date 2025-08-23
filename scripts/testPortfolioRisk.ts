// scripts/testPortfolioRisk.ts
// Quick validation script for portfolio risk management

import { Connection, PublicKey } from '@solana/web3.js';
import { portfolioRiskManager } from '../src/core/portfolioRiskManager.js';

async function testPortfolioRiskManagement() {
    console.log('🧪 Testing Portfolio Risk Management System\n');

    const mockConnection = {} as Connection;
    const mockWallet = new PublicKey('11111111111111111111111111111111');
    
    try {
        // Test 1: Basic risk check
        console.log('Test 1: Basic portfolio risk check');
        const result1 = await portfolioRiskManager.checkPortfolioRisk({
            mint: 'TEST_MINT_1',
            deployer: 'TEST_DEPLOYER_1',
            requestedAmount: 0.05,
            connection: mockConnection,
            walletPubkey: mockWallet
        });
        console.log('✅ First position allowed:', result1.allowed);

        // Record the position
        portfolioRiskManager.recordPosition('TEST_MINT_1', 'TEST_DEPLOYER_1', 0.05);
        console.log('📊 Position recorded\n');

        // Test 2: Deployer limit test
        console.log('Test 2: Deployer exposure limit');
        const result2 = await portfolioRiskManager.checkPortfolioRisk({
            mint: 'TEST_MINT_2',
            deployer: 'TEST_DEPLOYER_1',
            requestedAmount: 0.08, // Would exceed 0.1 limit with existing 0.05
            connection: mockConnection,
            walletPubkey: mockWallet
        });
        console.log('❌ Over-limit position blocked:', !result2.allowed);
        console.log('Reason:', result2.reason);
        console.log('Max allowed:', result2.maxAllowedAmount, '\n');

        // Test 3: Portfolio summary
        console.log('Test 3: Portfolio summary');
        const summary = portfolioRiskManager.getPortfolioSummary();
        console.log('📈 Portfolio Summary:');
        console.log(JSON.stringify(summary, null, 2));
        console.log('');

        // Test 4: Deployer analysis
        console.log('Test 4: Deployer analysis');
        const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis('TEST_DEPLOYER_1');
        console.log('🔍 Deployer Analysis:');
        console.log(JSON.stringify(deployerAnalysis, null, 2));
        console.log('');

        // Test 5: Remove position
        console.log('Test 5: Position removal');
        portfolioRiskManager.removePosition('TEST_MINT_1', 'TEST_DEPLOYER_1');
        const summaryAfter = portfolioRiskManager.getPortfolioSummary();
        console.log('📉 Portfolio after removal:');
        console.log('Total value:', (summaryAfter as any).totalPortfolioValue);
        console.log('Deployer count:', (summaryAfter as any).deployerCount);
        console.log('');

        console.log('✅ All portfolio risk management tests completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', (error as Error).message);
        console.error((error as Error).stack);
    }
}

testPortfolioRiskManagement();
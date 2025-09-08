// scripts/testPositionPersistence.ts
// Comprehensive test script for position persistence system

import dotenv from 'dotenv';
dotenv.config();

import positionPersistence from '../src/utils/positionPersistence.js';
import portfolioRiskManager from '../src/core/portfolioRiskManager.js';
import { PublicKey } from '@solana/web3.js';

async function testPositionPersistence() {
    console.log('🧪 Testing Position Persistence System\n');

    try {
        // Test 1: Initialize persistence manager
        console.log('1. Initializing position persistence manager...');
        await positionPersistence.initialize();
        console.log('✅ Persistence manager initialized\n');

        // Test 2: Save test positions
        console.log('2. Saving test positions...');
        const testPositions = [
            {
                mint: 'TEST_MINT_A12345',
                deployer: 'TEST_DEPLOYER_123',
                entryPrice: 0.001,
                amountTokens: 1000,
                exposureSOL: 1.0,
                acquisitionTime: Date.now() - 30000,
                peakRoi: 0.15,
                scaleOutIndex: 0,
                lastUpdateTime: Date.now()
            },
            {
                mint: 'TEST_MINT_B67890',
                deployer: 'TEST_DEPLOYER_456',
                entryPrice: 0.0005,
                amountTokens: 2000,
                exposureSOL: 1.0,
                acquisitionTime: Date.now() - 60000,
                peakRoi: -0.05,
                scaleOutIndex: 1,
                lastUpdateTime: Date.now()
            }
        ];

        for (const pos of testPositions) {
            await positionPersistence.savePosition(pos);
        }
        console.log(`✅ Saved ${testPositions.length} test positions\n`);

        // Test 3: Test deployer exposure tracking
        console.log('3. Testing deployer exposure tracking...');
        const deployerExposures = new Map();
        deployerExposures.set('TEST_DEPLOYER_123', {
            totalExposure: 1.0,
            tokenCount: 1,
            tokens: ['TEST_MINT_A12345'],
            lastTradeTime: Date.now()
        });
        deployerExposures.set('TEST_DEPLOYER_456', {
            totalExposure: 1.0,
            tokenCount: 1,
            tokens: ['TEST_MINT_B67890'],
            lastTradeTime: Date.now()
        });

        await positionPersistence.saveDeployerExposures(deployerExposures);
        console.log('✅ Deployer exposures saved\n');

        // Test 4: Test portfolio risk state
        console.log('4. Testing portfolio risk state...');
        await positionPersistence.savePortfolioRiskState({
            totalPortfolioValue: 2.0
        });
        console.log('✅ Portfolio risk state saved\n');

        // Test 5: Retrieve and verify data
        console.log('5. Retrieving and verifying saved data...');
        const activePositions = positionPersistence.getActivePositions();
        console.log(`📊 Active positions: ${activePositions.length}`);
        
        for (const pos of activePositions) {
            console.log(`   - ${pos.mint.substring(0, 12)}... | Entry: ${pos.entryPrice} | Amount: ${pos.amountTokens} | Peak ROI: ${(pos.peakRoi * 100).toFixed(1)}%`);
        }

        const deployerExps = positionPersistence.getDeployerExposures();
        console.log(`📊 Deployer exposures: ${deployerExps.length}`);
        
        for (const exp of deployerExps) {
            console.log(`   - ${exp.deployerAddress.substring(0, 12)}... | Exposure: ${exp.totalExposure} SOL | Tokens: ${exp.tokenCount}`);
        }

        const portfolioState = positionPersistence.getPortfolioRiskState();
        console.log(`📊 Portfolio value: ${portfolioState.totalPortfolioValue} SOL\n`);

        // Test 6: Position updates
        console.log('6. Testing position updates...');
        await positionPersistence.updatePosition('TEST_MINT_A12345', {
            amountTokens: 800,
            peakRoi: 0.25,
            scaleOutIndex: 1,
            lastSellAt: Date.now()
        });
        console.log('✅ Position updated\n');

        // Test 7: Portfolio risk manager integration
        console.log('7. Testing portfolio risk manager integration...');
        await portfolioRiskManager.restoreFromPersistence();
        console.log('✅ Portfolio risk manager state restored\n');

        const summary = portfolioRiskManager.getPortfolioSummary();
        console.log('📈 Portfolio Summary:');
        console.log(JSON.stringify(summary, null, 2));
        console.log('');

        // Test 8: Create backup
        console.log('8. Creating backup...');
        const backupFile = await positionPersistence.createBackup();
        console.log(`✅ Backup created: ${backupFile}\n`);

        // Test 9: Get statistics
        console.log('9. Getting persistence statistics...');
        const stats = positionPersistence.getStatistics();
        console.log('📊 Persistence Statistics:');
        console.log(JSON.stringify(stats, null, 2));
        console.log('');

        // Test 10: Position reconciliation (mock test)
        console.log('10. Testing position reconciliation (dry run)...');
        if (process.env.RPC_URL && process.env.PRIVATE_KEY) {
            console.log('⚠️ Skipping wallet reconciliation in test mode');
            // In real test, would call:
            // const reconciliation = await positionPersistence.reconcilePositions(connection, walletPubkey);
        } else {
            console.log('⚠️ No wallet/RPC configured, skipping reconciliation test');
        }
        console.log('');

        // Test 11: Position closure
        console.log('11. Testing position closure...');
        await positionPersistence.closePosition('TEST_MINT_B67890');
        console.log('✅ Position closed\n');

        // Test 12: Verify closure
        console.log('12. Verifying position closure...');
        const remainingPositions = positionPersistence.getActivePositions();
        console.log(`📊 Remaining active positions: ${remainingPositions.length}`);
        console.log('');

        // Test 13: Cleanup old positions
        console.log('13. Testing cleanup (1 second age limit for test)...');
        const removedCount = await positionPersistence.cleanup(1000); // 1 second for test
        console.log(`🧹 Cleaned up ${removedCount} old positions\n`);

        // Test 14: Final statistics
        console.log('14. Final statistics...');
        const finalStats = positionPersistence.getStatistics();
        console.log('📊 Final Statistics:');
        console.log(JSON.stringify(finalStats, null, 2));

        console.log('\n✅ All position persistence tests completed successfully!');

    } catch (error) {
        console.error('❌ Position persistence test failed:', (error as Error).message);
        console.error((error as Error).stack);
    } finally {
        // Cleanup
        try {
            await positionPersistence.shutdown();
            console.log('🧹 Position persistence manager shutdown completed');
        } catch (error) {
            console.error('❌ Shutdown failed:', (error as Error).message);
        }
    }
}

testPositionPersistence();
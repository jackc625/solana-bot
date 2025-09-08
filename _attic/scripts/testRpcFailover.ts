// scripts/testRpcFailover.ts
// Test script for multi-RPC failover functionality

import dotenv from 'dotenv';
dotenv.config();

import rpcManager from '../src/utils/rpcManager.js';
import { PublicKey } from '@solana/web3.js';

async function testRpcFailover() {
    console.log('🧪 Testing Multi-RPC Failover System\n');

    try {
        // Initialize RPC manager
        console.log('1. Initializing RPC Manager...');
        await rpcManager.initialize();
        console.log('✅ RPC Manager initialized successfully\n');

        // Test 1: Basic health check and status
        console.log('2. Testing RPC health monitoring...');
        const healthSummary = rpcManager.getHealthSummary();
        console.log('📊 RPC Health Summary:', JSON.stringify(healthSummary, null, 2));
        console.log('');

        // Test 2: Basic RPC operation
        console.log('3. Testing basic RPC operations...');
        const connection = rpcManager.getConnection();
        const slot = await connection.getSlot();
        console.log(`✅ Current slot: ${slot}`);
        
        const version = await connection.getVersion();
        console.log(`✅ RPC version: ${JSON.stringify(version)}`);
        console.log('');

        // Test 3: RPC failover with executeWithFailover
        console.log('4. Testing executeWithFailover wrapper...');
        const balance = await rpcManager.executeWithFailover(
            async (conn) => {
                // Test with a known public key (system program)
                const systemProgramBalance = await conn.getBalance(new PublicKey('11111111111111111111111111111111'));
                return systemProgramBalance;
            },
            'getBalance',
            3
        );
        console.log(`✅ System program balance: ${balance} lamports`);
        console.log('');

        // Test 4: Multiple concurrent operations
        console.log('5. Testing concurrent RPC operations...');
        const promises = Array.from({ length: 5 }, (_, i) =>
            rpcManager.executeWithFailover(
                async (conn) => {
                    const slot = await conn.getSlot();
                    return { operation: i + 1, slot };
                },
                `concurrentTest${i + 1}`,
                2
            )
        );

        const results = await Promise.all(promises);
        console.log('✅ Concurrent operations completed:', results);
        console.log('');

        // Test 5: Forced failover test
        console.log('6. Testing forced failover...');
        const currentRpc = rpcManager.getCurrentRpcStatus();
        console.log(`Current RPC: ${currentRpc?.endpoint.name}`);
        
        const failoverResult = await rpcManager.forceFailover('Manual failover test');
        console.log(`✅ Forced failover result: ${failoverResult}`);
        
        const newRpc = rpcManager.getCurrentRpcStatus();
        console.log(`New RPC after failover: ${newRpc?.endpoint.name}`);
        console.log('');

        // Test 6: Final health check
        console.log('7. Final health check after tests...');
        const finalHealthSummary = rpcManager.getHealthSummary();
        console.log('📊 Final RPC Health Summary:', JSON.stringify(finalHealthSummary, null, 2));

        console.log('\n✅ All RPC failover tests completed successfully!');

    } catch (error) {
        console.error('❌ RPC failover test failed:', (error as Error).message);
        console.error((error as Error).stack);
    } finally {
        // Cleanup
        rpcManager.shutdown();
        console.log('🧹 RPC Manager shutdown completed');
    }
}

testRpcFailover();
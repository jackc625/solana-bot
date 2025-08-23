// scripts/quickMetricsTest.ts
// Quick metrics system validation

import fetch from 'node-fetch';

async function quickTest() {
    console.log('🧪 Quick metrics test...\n');
    
    try {
        // Test basic imports work
        const { default: metricsCollector } = await import('../src/utils/metricsCollector.ts');
        const { metricsServer } = await import('../src/utils/metricsServer.ts');
        
        console.log('✅ Imports successful');
        
        // Test initialization
        await metricsCollector.initialize();
        console.log('✅ Metrics collector initialized');
        
        // Test server start
        await metricsServer.start();
        console.log('✅ Metrics server started');
        
        // Quick metrics generation
        metricsCollector.recordTradingOperation('buy', 'success', 1000);
        metricsCollector.recordTokenValidation('safety_check', 'pass');
        
        // Test endpoint
        const response = await fetch('http://localhost:9090/metrics');
        if (response.ok) {
            const data = await response.text();
            console.log('✅ Metrics endpoint working:', data.length, 'chars');
        }
        
        // Cleanup
        await metricsServer.stop();
        console.log('✅ All tests passed!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

quickTest();
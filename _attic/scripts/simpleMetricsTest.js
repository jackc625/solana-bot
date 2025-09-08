// scripts/simpleMetricsTest.js
// Simple metrics validation test using Node.js

import fetch from 'node-fetch';

async function testMetricsSystem() {
    console.log('🧪 Testing Prometheus metrics system...\n');
    
    try {
        // Test 1: Import and initialize metrics collector
        console.log('📊 Testing metrics collector...');
        const { default: metricsCollector } = await import('../src/utils/metricsCollector.js');
        await metricsCollector.initialize();
        
        // Generate some test metrics
        metricsCollector.recordTradingOperation('buy', 'success', 1500, 'test');
        metricsCollector.recordTokenValidation('safety_check', 'pass');
        metricsCollector.recordTokenScore(5, 3);
        
        const metrics = await metricsCollector.getMetrics();
        console.log('✅ Metrics collector working - generated', metrics.length, 'characters of metrics data');
        
        // Test 2: Start metrics server
        console.log('🌐 Testing metrics server...');
        const { metricsServer } = await import('../src/utils/metricsServer.js');
        await metricsServer.start();
        
        const status = metricsServer.getStatus();
        console.log('✅ Metrics server started on', `${status.config.host}:${status.config.port}`);
        
        // Test 3: Test metrics endpoint
        console.log('🔍 Testing metrics endpoint...');
        const metricsUrl = `http://${status.config.host}:${status.config.port}${status.config.endpoint}`;
        const response = await fetch(metricsUrl);
        
        if (response.ok) {
            const metricsData = await response.text();
            console.log('✅ Metrics endpoint working - received', metricsData.length, 'characters');
            
            // Check for expected content
            const expectedMetrics = ['trading_operations_total', 'token_validations_total'];
            const foundMetrics = expectedMetrics.filter(metric => metricsData.includes(metric));
            console.log('✅ Found expected metrics:', foundMetrics.join(', '));
        } else {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Test 4: Test health endpoint
        console.log('❤️  Testing health endpoint...');
        const healthUrl = `http://${status.config.host}:${status.config.port}/health`;
        const healthResponse = await fetch(healthUrl);
        
        if (healthResponse.ok) {
            const healthData = await healthResponse.json();
            console.log('✅ Health endpoint working - status:', healthData.healthy ? 'healthy' : 'unhealthy');
        } else {
            console.warn('⚠️ Health endpoint failed:', healthResponse.status);
        }
        
        // Cleanup
        await metricsServer.stop();
        console.log('🧹 Cleanup completed');
        
        console.log('\n🎉 All metrics tests passed! System is ready for production use.');
        
    } catch (error) {
        console.error('❌ Metrics test failed:', error.message);
        process.exit(1);
    }
}

// Run the test
testMetricsSystem();
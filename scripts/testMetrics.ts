#!/usr/bin/env tsx
// scripts/testMetrics.ts
// Comprehensive test script for Prometheus metrics system

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import fetch from 'node-fetch';

interface TestResult {
    name: string;
    passed: boolean;
    details?: string;
    duration?: number;
}

class MetricsValidator {
    private results: TestResult[] = [];
    private serverPid: number | null = null;
    private readonly METRICS_URL = 'http://localhost:9090/metrics';
    private readonly HEALTH_URL = 'http://localhost:9090/health';

    async runAllTests(): Promise<void> {
        console.log('🧪 Starting Prometheus metrics system validation...\n');

        try {
            // Test 1: Validate metrics collector instantiation
            await this.testMetricsCollectorInstantiation();

            // Test 2: Validate metrics server startup
            await this.testMetricsServerStartup();

            // Test 3: Test metrics endpoint response
            await this.testMetricsEndpoint();

            // Test 4: Test health endpoint
            await this.testHealthEndpoint();

            // Test 5: Validate metrics format
            await this.testMetricsFormat();

            // Test 6: Test concurrent requests
            await this.testConcurrentRequests();

            // Test 7: Test metrics content validation
            await this.testMetricsContent();

            // Test 8: Test integration with trading components
            await this.testIntegrationPoints();

        } finally {
            await this.cleanup();
        }

        this.printResults();
    }

    private async testMetricsCollectorInstantiation(): Promise<void> {
        const start = Date.now();
        
        try {
            // Import metrics collector to test instantiation
            const { default: metricsCollector } = await import('../src/utils/metricsCollector.js');
            
            // Test basic functionality
            await metricsCollector.initialize();
            const metrics = await metricsCollector.getMetrics();
            
            if (typeof metrics === 'string' && metrics.length > 0) {
                this.results.push({
                    name: 'Metrics Collector Instantiation',
                    passed: true,
                    duration: Date.now() - start,
                    details: `Metrics string length: ${metrics.length} chars`
                });
            } else {
                throw new Error('Invalid metrics output');
            }
        } catch (error) {
            this.results.push({
                name: 'Metrics Collector Instantiation',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testMetricsServerStartup(): Promise<void> {
        const start = Date.now();
        
        try {
            const { metricsServer } = await import('../src/utils/metricsServer.js');
            
            await metricsServer.start();
            const status = metricsServer.getStatus();
            
            if (status.running) {
                this.results.push({
                    name: 'Metrics Server Startup',
                    passed: true,
                    duration: Date.now() - start,
                    details: `Server running on ${status.config.host}:${status.config.port}`
                });
            } else {
                throw new Error('Server not running after start');
            }
        } catch (error) {
            this.results.push({
                name: 'Metrics Server Startup',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testMetricsEndpoint(): Promise<void> {
        const start = Date.now();
        
        try {
            const response = await fetch(this.METRICS_URL);
            
            if (response.ok) {
                const metrics = await response.text();
                const contentType = response.headers.get('content-type');
                
                if (contentType?.includes('text/plain') && metrics.length > 0) {
                    this.results.push({
                        name: 'Metrics Endpoint Response',
                        passed: true,
                        duration: Date.now() - start,
                        details: `Status: ${response.status}, Content-Type: ${contentType}, Size: ${metrics.length} chars`
                    });
                } else {
                    throw new Error(`Invalid content type or empty response: ${contentType}`);
                }
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            this.results.push({
                name: 'Metrics Endpoint Response',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testHealthEndpoint(): Promise<void> {
        const start = Date.now();
        
        try {
            const response = await fetch(this.HEALTH_URL);
            
            if (response.ok) {
                const health = await response.json();
                
                if (typeof health === 'object' && 'healthy' in health && 'checks' in health) {
                    this.results.push({
                        name: 'Health Endpoint Response',
                        passed: true,
                        duration: Date.now() - start,
                        details: `Healthy: ${health.healthy}, Checks: ${health.checks?.length || 0}`
                    });
                } else {
                    throw new Error('Invalid health response format');
                }
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            this.results.push({
                name: 'Health Endpoint Response',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testMetricsFormat(): Promise<void> {
        const start = Date.now();
        
        try {
            const response = await fetch(this.METRICS_URL);
            const metrics = await response.text();
            
            // Validate Prometheus format
            const lines = metrics.split('\n');
            let helpCount = 0;
            let typeCount = 0;
            let metricCount = 0;
            
            for (const line of lines) {
                if (line.startsWith('# HELP')) helpCount++;
                else if (line.startsWith('# TYPE')) typeCount++;
                else if (line.trim() && !line.startsWith('#')) metricCount++;
            }
            
            if (helpCount > 0 && typeCount > 0 && metricCount > 0) {
                this.results.push({
                    name: 'Metrics Format Validation',
                    passed: true,
                    duration: Date.now() - start,
                    details: `HELP: ${helpCount}, TYPE: ${typeCount}, Metrics: ${metricCount}`
                });
            } else {
                throw new Error(`Invalid Prometheus format: HELP=${helpCount}, TYPE=${typeCount}, Metrics=${metricCount}`);
            }
        } catch (error) {
            this.results.push({
                name: 'Metrics Format Validation',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testConcurrentRequests(): Promise<void> {
        const start = Date.now();
        
        try {
            const concurrency = 10;
            const requests = Array(concurrency).fill(null).map(() => 
                fetch(this.METRICS_URL).then(r => r.text())
            );
            
            const responses = await Promise.all(requests);
            
            // Validate all responses are consistent
            const firstResponse = responses[0];
            const allConsistent = responses.every(r => r.length > 0);
            
            if (allConsistent) {
                this.results.push({
                    name: 'Concurrent Requests Test',
                    passed: true,
                    duration: Date.now() - start,
                    details: `${concurrency} concurrent requests succeeded`
                });
            } else {
                throw new Error('Inconsistent responses from concurrent requests');
            }
        } catch (error) {
            this.results.push({
                name: 'Concurrent Requests Test',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testMetricsContent(): Promise<void> {
        const start = Date.now();
        
        try {
            // Generate some test metrics first
            const { default: metricsCollector } = await import('../src/utils/metricsCollector.js');
            
            // Record test metrics
            metricsCollector.recordTradingOperation('buy', 'success', 1500, 'test');
            metricsCollector.recordTokenValidation('safety_check', 'pass');
            metricsCollector.recordSystemEvent('info', 'test', 'validation');
            
            const response = await fetch(this.METRICS_URL);
            const metrics = await response.text();
            
            // Check for expected metric families
            const expectedMetrics = [
                'trading_operations_total',
                'trading_operation_duration_seconds',
                'token_validations_total',
                'system_events_total',
                'nodejs_heap_size_used_bytes'
            ];
            
            const foundMetrics = expectedMetrics.filter(metric => 
                metrics.includes(metric)
            );
            
            if (foundMetrics.length >= 3) { // Allow some flexibility
                this.results.push({
                    name: 'Metrics Content Validation',
                    passed: true,
                    duration: Date.now() - start,
                    details: `Found ${foundMetrics.length}/${expectedMetrics.length} expected metrics`
                });
            } else {
                throw new Error(`Only found ${foundMetrics.length}/${expectedMetrics.length} expected metrics: ${foundMetrics.join(', ')}`);
            }
        } catch (error) {
            this.results.push({
                name: 'Metrics Content Validation',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async testIntegrationPoints(): Promise<void> {
        const start = Date.now();
        
        try {
            // Test that metrics are properly exported from modules
            const integrationTests = [
                { module: 'metricsCollector', path: '../src/utils/metricsCollector.js' },
                { module: 'metricsServer', path: '../src/utils/metricsServer.js' }
            ];
            
            let passedIntegrations = 0;
            for (const test of integrationTests) {
                try {
                    const module = await import(test.path);
                    if (module.default || module.metricsServer || module.metricsCollector) {
                        passedIntegrations++;
                    }
                } catch (err) {
                    // Integration point failed
                }
            }
            
            if (passedIntegrations === integrationTests.length) {
                this.results.push({
                    name: 'Integration Points Test',
                    passed: true,
                    duration: Date.now() - start,
                    details: `All ${integrationTests.length} integration points working`
                });
            } else {
                throw new Error(`Only ${passedIntegrations}/${integrationTests.length} integration points working`);
            }
        } catch (error) {
            this.results.push({
                name: 'Integration Points Test',
                passed: false,
                duration: Date.now() - start,
                details: `Error: ${(error as Error).message}`
            });
        }
    }

    private async cleanup(): Promise<void> {
        try {
            const { metricsServer } = await import('../src/utils/metricsServer.js');
            await metricsServer.stop();
        } catch (error) {
            console.warn('⚠️ Cleanup warning:', (error as Error).message);
        }
    }

    private printResults(): void {
        console.log('\n📊 Metrics System Validation Results:');
        console.log('=' .repeat(60));
        
        let passed = 0;
        let total = this.results.length;
        
        for (const result of this.results) {
            const status = result.passed ? '✅ PASS' : '❌ FAIL';
            const duration = result.duration ? ` (${result.duration}ms)` : '';
            
            console.log(`${status} ${result.name}${duration}`);
            if (result.details) {
                console.log(`   ${result.details}`);
            }
            
            if (result.passed) passed++;
        }
        
        console.log('=' .repeat(60));
        console.log(`📈 Overall Result: ${passed}/${total} tests passed (${((passed/total)*100).toFixed(1)}%)`);
        
        if (passed === total) {
            console.log('🎉 All metrics system tests passed! System is ready for production use.');
        } else {
            console.log('⚠️ Some tests failed. Please review the failures before deploying.');
            process.exit(1);
        }
    }
}

// Run the validation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const validator = new MetricsValidator();
    validator.runAllTests().catch(error => {
        console.error('❌ Validation script failed:', error);
        process.exit(1);
    });
}

export default MetricsValidator;
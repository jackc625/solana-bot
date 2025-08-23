// src/utils/rpcManager.ts
// Multi-RPC support with health monitoring and automatic failover

import { Connection, PublicKey } from "@solana/web3.js";
import { loadBotConfig, RpcEndpoint } from "../config/index.js";
import logger from "./logger.js";

export interface RpcHealthMetrics {
    latency: number;
    successRate: number;
    lastError?: string;
    lastErrorTime?: number;
    consecutiveFailures: number;
    totalRequests: number;
    totalFailures: number;
    isHealthy: boolean;
    lastHealthCheck: number;
}

export interface RpcStatus {
    endpoint: RpcEndpoint;
    connection: Connection;
    metrics: RpcHealthMetrics;
    blockHeight?: number;
    version?: any;
}

class RpcManager {
    private rpcStatuses: Map<string, RpcStatus> = new Map();
    private currentRpc: string | null = null;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private config = loadBotConfig();
    private isInitialized = false;

    /**
     * Initialize the RPC manager with configured endpoints
     */
    async initialize(): Promise<void> {
        try {
            if (this.isInitialized) {
                return;
            }

            const endpoints = this.getConfiguredEndpoints();
            if (endpoints.length === 0) {
                logger.warn('RPC', 'No RPC endpoints configured, using environment RPC_URL');
                await this.initializeFallbackRpc();
                return;
            }

            logger.info('RPC', `Initializing ${endpoints.length} RPC endpoints`, {
                endpoints: endpoints.map(e => ({ name: e.name, priority: e.priority }))
            });

            // Initialize all RPC endpoints
            for (const endpoint of endpoints) {
                await this.initializeEndpoint(endpoint);
            }

            // Select the best initial RPC
            await this.selectBestRpc();

            // Start health monitoring
            this.startHealthChecking();

            this.isInitialized = true;
            logger.info('RPC', '✅ RPC Manager initialized successfully', {
                totalEndpoints: this.rpcStatuses.size,
                currentRpc: this.currentRpc
            });
            
        } catch (error) {
            logger.error('RPC', 'Failed to initialize RPC Manager', {
                error: (error as Error).message,
                stack: (error as Error).stack
            });
            throw error;
        }
    }

    /**
     * Get the current active Connection
     */
    getConnection(): Connection {
        if (!this.isInitialized) {
            throw new Error('RPC Manager not initialized. Call initialize() first.');
        }

        const current = this.getCurrentRpcStatus();
        if (!current) {
            throw new Error('No healthy RPC endpoints available');
        }

        return current.connection;
    }

    /**
     * Get current RPC status for monitoring
     */
    getCurrentRpcStatus(): RpcStatus | null {
        if (!this.currentRpc) return null;
        return this.rpcStatuses.get(this.currentRpc) || null;
    }

    /**
     * Get all RPC statuses for monitoring dashboard
     */
    getAllRpcStatuses(): RpcStatus[] {
        return Array.from(this.rpcStatuses.values())
            .sort((a, b) => a.endpoint.priority - b.endpoint.priority);
    }

    /**
     * Force failover to next best RPC
     */
    async forceFailover(reason: string): Promise<boolean> {
        logger.warn('RPC', `🔄 Forcing RPC failover: ${reason}`, {
            currentRpc: this.currentRpc
        });

        const currentRpc = this.currentRpc;
        if (currentRpc) {
            // Mark current RPC as unhealthy
            const status = this.rpcStatuses.get(currentRpc);
            if (status) {
                status.metrics.consecutiveFailures += 1;
                status.metrics.lastError = reason;
                status.metrics.lastErrorTime = Date.now();
                status.metrics.isHealthy = false;
            }
        }

        return await this.selectBestRpc();
    }

    /**
     * Execute an RPC call with automatic failover
     */
    async executeWithFailover<T>(
        operation: (connection: Connection) => Promise<T>,
        operationName: string,
        maxAttempts: number = 3
    ): Promise<T> {
        let lastError: Error | null = null;
        let attempts = 0;

        while (attempts < maxAttempts) {
            attempts++;
            
            try {
                const connection = this.getConnection();
                const startTime = Date.now();
                
                const result = await operation(connection);
                
                // Record successful operation
                const current = this.getCurrentRpcStatus();
                if (current) {
                    this.recordSuccess(current, Date.now() - startTime);
                }
                
                return result;
                
            } catch (error) {
                lastError = error as Error;
                const current = this.getCurrentRpcStatus();
                
                logger.warn('RPC', `❌ RPC operation failed (attempt ${attempts}/${maxAttempts})`, {
                    operation: operationName,
                    rpc: current?.endpoint.name || 'unknown',
                    error: lastError.message,
                    attempt: attempts
                });

                if (current) {
                    this.recordFailure(current, lastError.message);
                }

                // Try to failover if not the last attempt
                if (attempts < maxAttempts) {
                    const failoverSuccess = await this.forceFailover(`${operationName} failed: ${lastError.message}`);
                    if (!failoverSuccess) {
                        logger.error('RPC', '🚨 All RPC endpoints failed', { operation: operationName });
                        break;
                    }
                }
            }
        }

        throw new Error(`RPC operation '${operationName}' failed after ${attempts} attempts: ${lastError?.message}`);
    }

    /**
     * Get configured endpoints with fallback to environment variable
     */
    private getConfiguredEndpoints(): RpcEndpoint[] {
        const endpoints = this.config.rpcEndpoints;
        if (!endpoints || endpoints.length === 0) {
            // Fallback to environment RPC_URL if available
            const envRpcUrl = process.env.RPC_URL;
            if (envRpcUrl) {
                return [{
                    url: envRpcUrl,
                    name: 'Environment RPC',
                    priority: 1,
                    maxRetries: 3,
                    timeoutMs: 5000
                }];
            }
            return [];
        }
        
        // Sort by priority (lower number = higher priority)
        return endpoints.slice().sort((a, b) => a.priority - b.priority);
    }

    /**
     * Initialize fallback RPC from environment
     */
    private async initializeFallbackRpc(): Promise<void> {
        const rpcUrl = process.env.RPC_URL;
        if (!rpcUrl) {
            throw new Error('No RPC endpoints configured and RPC_URL not found');
        }

        const endpoint: RpcEndpoint = {
            url: rpcUrl,
            name: 'Environment RPC',
            priority: 1,
            maxRetries: 3,
            timeoutMs: 5000
        };

        await this.initializeEndpoint(endpoint);
        this.currentRpc = endpoint.url;
        this.isInitialized = true;
    }

    /**
     * Initialize a single RPC endpoint
     */
    private async initializeEndpoint(endpoint: RpcEndpoint): Promise<void> {
        try {
            const connection = new Connection(endpoint.url, {
                commitment: "confirmed",
                wsEndpoint: endpoint.wsUrl,
                fetch: this.createFetchWithTimeout(endpoint.timeoutMs || 5000)
            });

            const metrics: RpcHealthMetrics = {
                latency: 0,
                successRate: 0,
                consecutiveFailures: 0,
                totalRequests: 0,
                totalFailures: 0,
                isHealthy: true,
                lastHealthCheck: Date.now()
            };

            const status: RpcStatus = {
                endpoint,
                connection,
                metrics
            };

            this.rpcStatuses.set(endpoint.url, status);
            
            // Perform initial health check
            await this.performHealthCheck(status);

            logger.info('RPC', `✅ Initialized RPC endpoint: ${endpoint.name}`, {
                url: endpoint.url.substring(0, 50) + '...',
                priority: endpoint.priority,
                healthy: status.metrics.isHealthy,
                latency: status.metrics.latency
            });

        } catch (error) {
            logger.error('RPC', `❌ Failed to initialize RPC endpoint: ${endpoint.name}`, {
                url: endpoint.url,
                error: (error as Error).message
            });
        }
    }

    /**
     * Select the best RPC based on health and priority
     */
    private async selectBestRpc(): Promise<boolean> {
        const healthyEndpoints = Array.from(this.rpcStatuses.values())
            .filter(status => status.metrics.isHealthy)
            .sort((a, b) => {
                // Primary sort: priority (lower = better)
                if (a.endpoint.priority !== b.endpoint.priority) {
                    return a.endpoint.priority - b.endpoint.priority;
                }
                // Secondary sort: latency (lower = better)
                return a.metrics.latency - b.metrics.latency;
            });

        if (healthyEndpoints.length === 0) {
            logger.error('RPC', '🚨 No healthy RPC endpoints available');
            return false;
        }

        const bestRpc = healthyEndpoints[0];
        const previousRpc = this.currentRpc;
        this.currentRpc = bestRpc.endpoint.url;

        if (previousRpc !== this.currentRpc) {
            logger.info('RPC', `🔄 Switched to RPC: ${bestRpc.endpoint.name}`, {
                from: previousRpc ? this.rpcStatuses.get(previousRpc)?.endpoint.name : 'none',
                to: bestRpc.endpoint.name,
                latency: bestRpc.metrics.latency,
                priority: bestRpc.endpoint.priority
            });
        }

        return true;
    }

    /**
     * Start periodic health checking
     */
    private startHealthChecking(): void {
        const intervalMs = this.config.rpcHealthCheckIntervalMs || 30000;
        
        this.healthCheckInterval = setInterval(async () => {
            logger.debug('RPC', '🔍 Performing periodic RPC health checks');
            
            const promises = Array.from(this.rpcStatuses.values())
                .map(status => this.performHealthCheck(status));
                
            await Promise.allSettled(promises);
            
            // Re-evaluate best RPC after health checks
            await this.selectBestRpc();
            
        }, intervalMs);

        logger.info('RPC', `🏥 RPC health monitoring started (interval: ${intervalMs}ms)`);
    }

    /**
     * Perform health check on a single RPC endpoint
     */
    private async performHealthCheck(status: RpcStatus): Promise<void> {
        const startTime = Date.now();
        
        try {
            // Test basic connectivity with a simple call
            const slot = await status.connection.getSlot();
            const version = await status.connection.getVersion();
            
            const latency = Date.now() - startTime;
            
            // Update metrics
            status.metrics.latency = latency;
            status.metrics.consecutiveFailures = 0;
            status.metrics.totalRequests += 1;
            status.metrics.isHealthy = true;
            status.metrics.lastHealthCheck = Date.now();
            status.blockHeight = slot;
            status.version = version;
            
            // Calculate success rate
            status.metrics.successRate = status.metrics.totalRequests > 0 
                ? (status.metrics.totalRequests - status.metrics.totalFailures) / status.metrics.totalRequests 
                : 1;

            logger.debug('RPC', `✅ Health check passed: ${status.endpoint.name}`, {
                latency,
                slot,
                successRate: (status.metrics.successRate * 100).toFixed(1) + '%'
            });

        } catch (error) {
            this.recordFailure(status, (error as Error).message);
            
            logger.debug('RPC', `❌ Health check failed: ${status.endpoint.name}`, {
                error: (error as Error).message,
                consecutiveFailures: status.metrics.consecutiveFailures
            });
        }
    }

    /**
     * Record successful operation
     */
    private recordSuccess(status: RpcStatus, latency: number): void {
        status.metrics.latency = (status.metrics.latency + latency) / 2; // Moving average
        status.metrics.consecutiveFailures = 0;
        status.metrics.totalRequests += 1;
        status.metrics.successRate = (status.metrics.totalRequests - status.metrics.totalFailures) / status.metrics.totalRequests;
    }

    /**
     * Record failed operation
     */
    private recordFailure(status: RpcStatus, errorMessage: string): void {
        const failoverThreshold = this.config.rpcFailoverThreshold || 3;
        
        status.metrics.consecutiveFailures += 1;
        status.metrics.totalRequests += 1;
        status.metrics.totalFailures += 1;
        status.metrics.lastError = errorMessage;
        status.metrics.lastErrorTime = Date.now();
        status.metrics.successRate = (status.metrics.totalRequests - status.metrics.totalFailures) / status.metrics.totalRequests;
        
        // Mark as unhealthy if too many consecutive failures
        if (status.metrics.consecutiveFailures >= failoverThreshold) {
            status.metrics.isHealthy = false;
            logger.warn('RPC', `⚠️ Marking RPC as unhealthy: ${status.endpoint.name}`, {
                consecutiveFailures: status.metrics.consecutiveFailures,
                threshold: failoverThreshold
            });
        }
    }

    /**
     * Create fetch with timeout for Connection
     */
    private createFetchWithTimeout(timeoutMs: number) {
        return async (input: string | URL | Request, options?: any) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            
            try {
                const response = await fetch(input, {
                    ...options,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                return response;
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }
        };
    }

    /**
     * Get RPC health summary for monitoring
     */
    getHealthSummary(): object {
        const statuses = Array.from(this.rpcStatuses.values());
        const healthyCount = statuses.filter(s => s.metrics.isHealthy).length;
        
        return {
            totalEndpoints: statuses.length,
            healthyEndpoints: healthyCount,
            currentRpc: this.getCurrentRpcStatus()?.endpoint.name || 'none',
            averageLatency: statuses.reduce((sum, s) => sum + s.metrics.latency, 0) / statuses.length,
            endpoints: statuses.map(s => ({
                name: s.endpoint.name,
                priority: s.endpoint.priority,
                healthy: s.metrics.isHealthy,
                latency: s.metrics.latency.toFixed(0) + 'ms',
                successRate: (s.metrics.successRate * 100).toFixed(1) + '%',
                consecutiveFailures: s.metrics.consecutiveFailures,
                blockHeight: s.blockHeight
            }))
        };
    }

    /**
     * Cleanup resources
     */
    shutdown(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        
        logger.info('RPC', '🔄 RPC Manager shutdown completed');
    }
}

// Singleton instance
export const rpcManager = new RpcManager();

export default rpcManager;
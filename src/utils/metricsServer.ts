// src/utils/metricsServer.ts
// HTTP server for exposing Prometheus metrics endpoint

import http from 'http';
import { URL } from 'url';
import logger from './logger.js';
import metricsCollector from './metricsCollector.js';

export interface MetricsServerConfig {
    port: number;
    host: string;
    endpoint: string;
    enableHealthCheck: boolean;
}

/**
 * HTTP server for Prometheus metrics scraping
 */
class MetricsServer {
    private server: http.Server | null = null;
    private isRunning = false;
    private config: MetricsServerConfig;

    constructor(config: Partial<MetricsServerConfig> = {}) {
        this.config = {
            port: config.port || 9090,
            host: config.host || '0.0.0.0',
            endpoint: config.endpoint || '/metrics',
            enableHealthCheck: config.enableHealthCheck ?? true
        };
    }

    /**
     * Start the metrics server
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('METRICS_SERVER', 'Metrics server already running');
            return;
        }

        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    await this.handleRequest(req, res);
                } catch (error) {
                    logger.error('METRICS_SERVER', 'Request handling error', {
                        url: req.url,
                        method: req.method,
                        error: (error as Error).message
                    });
                    this.sendErrorResponse(res, 500, 'Internal Server Error');
                }
            });

            this.server.on('error', (error) => {
                logger.error('METRICS_SERVER', 'Server error', {
                    error: error.message,
                    port: this.config.port
                });
                reject(error);
            });

            this.server.listen(this.config.port, this.config.host, () => {
                this.isRunning = true;
                logger.info('METRICS_SERVER', '🚀 Metrics server started', {
                    host: this.config.host,
                    port: this.config.port,
                    endpoint: this.config.endpoint,
                    url: `http://${this.config.host}:${this.config.port}${this.config.endpoint}`
                });
                resolve();
            });
        });
    }

    /**
     * Stop the metrics server
     */
    async stop(): Promise<void> {
        if (!this.isRunning || !this.server) {
            logger.warn('METRICS_SERVER', 'Metrics server not running');
            return;
        }

        return new Promise((resolve) => {
            this.server!.close(() => {
                this.isRunning = false;
                this.server = null;
                logger.info('METRICS_SERVER', '🔄 Metrics server stopped');
                resolve();
            });
        });
    }

    /**
     * Get server status
     */
    getStatus(): { running: boolean; config: MetricsServerConfig } {
        return {
            running: this.isRunning,
            config: this.config
        };
    }

    /**
     * Handle incoming HTTP requests
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const method = req.method?.toUpperCase();

        // Log request
        logger.debug('METRICS_SERVER', 'Request received', {
            method,
            path: url.pathname,
            userAgent: req.headers['user-agent']
        });

        // Handle CORS preflight
        if (method === 'OPTIONS') {
            this.sendCorsHeaders(res);
            res.writeHead(200);
            res.end();
            return;
        }

        // Route requests
        switch (url.pathname) {
            case this.config.endpoint:
                await this.handleMetricsRequest(req, res);
                break;

            case '/health':
                if (this.config.enableHealthCheck) {
                    await this.handleHealthRequest(req, res);
                } else {
                    this.sendErrorResponse(res, 404, 'Health endpoint disabled');
                }
                break;

            case '/':
                await this.handleRootRequest(req, res);
                break;

            default:
                this.sendErrorResponse(res, 404, 'Not Found');
                break;
        }
    }

    /**
     * Handle metrics endpoint request
     */
    private async handleMetricsRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== 'GET') {
            this.sendErrorResponse(res, 405, 'Method Not Allowed');
            return;
        }

        try {
            const startTime = Date.now();
            const metrics = await metricsCollector.getMetrics();
            const duration = Date.now() - startTime;

            // Record metrics collection performance
            metricsCollector.recordTradingOperation('quote', 'success', duration, 'metrics_collection');

            this.sendCorsHeaders(res);
            res.writeHead(200, {
                'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
                'Content-Length': Buffer.byteLength(metrics, 'utf8')
            });
            res.end(metrics);

            logger.debug('METRICS_SERVER', 'Metrics served', {
                duration,
                size: metrics.length,
                userAgent: req.headers['user-agent']
            });

        } catch (error) {
            logger.error('METRICS_SERVER', 'Failed to serve metrics', {
                error: (error as Error).message
            });
            this.sendErrorResponse(res, 500, 'Failed to collect metrics');
        }
    }

    /**
     * Handle health check request
     */
    private async handleHealthRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== 'GET') {
            this.sendErrorResponse(res, 405, 'Method Not Allowed');
            return;
        }

        try {
            // Perform basic health checks
            const health = await this.performHealthChecks();
            
            this.sendCorsHeaders(res);
            res.writeHead(health.healthy ? 200 : 503, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify(health, null, 2));

            logger.debug('METRICS_SERVER', 'Health check served', {
                healthy: health.healthy,
                checks: health.checks.length
            });

        } catch (error) {
            logger.error('METRICS_SERVER', 'Health check failed', {
                error: (error as Error).message
            });
            this.sendErrorResponse(res, 500, 'Health check failed');
        }
    }

    /**
     * Handle root endpoint request
     */
    private async handleRootRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== 'GET') {
            this.sendErrorResponse(res, 405, 'Method Not Allowed');
            return;
        }

        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Solana Trading Bot - Metrics</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .header { color: #333; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
        .endpoint { margin: 20px 0; }
        .endpoint a { color: #0066cc; text-decoration: none; }
        .endpoint a:hover { text-decoration: underline; }
        .status { margin: 10px 0; }
        .healthy { color: green; }
        .unhealthy { color: red; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 Solana Trading Bot - Metrics Server</h1>
        <p>Prometheus metrics and monitoring endpoints</p>
    </div>
    
    <div class="endpoint">
        <h3>📊 Available Endpoints:</h3>
        <ul>
            <li><a href="${this.config.endpoint}">Prometheus Metrics</a> - <code>${this.config.endpoint}</code></li>
            ${this.config.enableHealthCheck ? '<li><a href="/health">Health Check</a> - <code>/health</code></li>' : ''}
        </ul>
    </div>
    
    <div class="status">
        <h3>📈 Server Status:</h3>
        <p>Host: <code>${this.config.host}:${this.config.port}</code></p>
        <p>Status: <span class="healthy">Running</span></p>
        <p>Uptime: <code>${process.uptime().toFixed(0)}s</code></p>
    </div>
    
    <div class="endpoint">
        <h3>🔧 Prometheus Configuration:</h3>
        <pre>
scrape_configs:
  - job_name: 'solana-trading-bot'
    static_configs:
      - targets: ['${this.config.host === '0.0.0.0' ? 'localhost' : this.config.host}:${this.config.port}']
    metrics_path: '${this.config.endpoint}'
    scrape_interval: 30s
        </pre>
    </div>
</body>
</html>`;

        this.sendCorsHeaders(res);
        res.writeHead(200, {
            'Content-Type': 'text/html'
        });
        res.end(html);
    }

    /**
     * Perform health checks
     */
    private async performHealthChecks(): Promise<{
        healthy: boolean;
        timestamp: string;
        uptime: number;
        checks: Array<{ name: string; status: 'pass' | 'fail'; message?: string }>;
    }> {
        const checks = [];
        let allHealthy = true;

        // Check metrics collector
        try {
            await metricsCollector.getMetrics();
            checks.push({ name: 'metrics_collector', status: 'pass' as const });
        } catch (error) {
            checks.push({ 
                name: 'metrics_collector', 
                status: 'fail' as const, 
                message: (error as Error).message 
            });
            allHealthy = false;
        }

        // Check memory usage
        const memUsage = process.memoryUsage();
        const memoryOk = memUsage.heapUsed < 500 * 1024 * 1024; // 500MB limit
        checks.push({
            name: 'memory_usage',
            status: memoryOk ? 'pass' as const : 'fail' as const,
            message: `Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`
        });
        if (!memoryOk) allHealthy = false;

        // Check if server is responding
        checks.push({ name: 'http_server', status: 'pass' as const });

        return {
            healthy: allHealthy,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            checks
        };
    }

    /**
     * Send CORS headers
     */
    private sendCorsHeaders(res: http.ServerResponse): void {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    /**
     * Send error response
     */
    private sendErrorResponse(res: http.ServerResponse, statusCode: number, message: string): void {
        this.sendCorsHeaders(res);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            error: message,
            timestamp: new Date().toISOString()
        }));
    }
}

// Default metrics server instance
export const metricsServer = new MetricsServer();

export default MetricsServer;
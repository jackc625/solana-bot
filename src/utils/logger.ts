import fs from "fs/promises";
import path from "path";

export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3
}

export interface LogEntry {
    timestamp: string;
    level: string;
    module: string;
    message: string;
    data?: any;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
}

class Logger {
    private logLevel: LogLevel;
    private tradeLogPath: string;
    private errorLogPath: string;
    private debugLogPath: string;
    private maxLogSize: number = 50 * 1024 * 1024; // 50MB max log size

    constructor() {
        this.logLevel = this.getLogLevel();
        this.tradeLogPath = path.resolve("data", "trades.json");
        this.errorLogPath = path.resolve("data", "errors.log");
        this.debugLogPath = path.resolve("data", "debug.log");
        
        // Initialize data directory
        this.initDataDirectory();
    }

    private async initDataDirectory() {
        try {
            await fs.mkdir("data", { recursive: true });
        } catch (err) {
            console.error("Failed to create data directory:", err);
        }
    }

    private getLogLevel(): LogLevel {
        const level = process.env.LOG_LEVEL?.toUpperCase();
        switch (level) {
            case 'ERROR': return LogLevel.ERROR;
            case 'WARN': return LogLevel.WARN;
            case 'INFO': return LogLevel.INFO;
            case 'DEBUG': return LogLevel.DEBUG;
            default: return process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO;
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return level <= this.logLevel;
    }

    private formatError(error: any): { name: string; message: string; stack?: string } {
        if (error instanceof Error) {
            return {
                name: error.name,
                message: error.message,
                stack: error.stack
            };
        }
        return {
            name: 'Unknown Error',
            message: String(error)
        };
    }

    private createLogEntry(level: string, module: string, message: string, data?: any, error?: any): LogEntry {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            module,
            message,
        };

        if (data !== undefined) {
            entry.data = data;
        }

        if (error !== undefined) {
            entry.error = this.formatError(error);
        }

        return entry;
    }

    private formatConsoleOutput(entry: LogEntry): string {
        const emoji = {
            ERROR: '❌',
            WARN: '⚠️ ',
            INFO: 'ℹ️ ',
            DEBUG: '🐛'
        }[entry.level] || 'ℹ️ ';

        let output = `${emoji} [${entry.module}] ${entry.message}`;

        if (entry.data && this.shouldLog(LogLevel.DEBUG)) {
            output += `\n   Data: ${JSON.stringify(entry.data, null, 2)}`;
        }

        if (entry.error) {
            output += `\n   Error: ${entry.error.message}`;
            if (entry.error.stack && this.shouldLog(LogLevel.DEBUG)) {
                output += `\n   Stack: ${entry.error.stack}`;
            }
        }

        return output;
    }

    private async writeToFile(filepath: string, content: string, append = true) {
        try {
            // Check log rotation for debug.log
            if (append && filepath === this.debugLogPath) {
                await this.rotateLogIfNeeded(filepath);
            }
            
            if (append) {
                await fs.appendFile(filepath, content + '\n');
            } else {
                await fs.writeFile(filepath, content);
            }
        } catch (err) {
            console.error(`Failed to write to ${filepath}:`, err);
        }
    }

    private async rotateLogIfNeeded(filepath: string) {
        try {
            const stats = await fs.stat(filepath).catch(() => null);
            if (stats && stats.size > this.maxLogSize) {
                // Rotate: keep last 1000 lines only
                const content = await fs.readFile(filepath, 'utf-8');
                const lines = content.split('\n');
                const keepLines = lines.slice(-1000);
                await fs.writeFile(filepath, keepLines.join('\n'));
                console.log(`📋 Rotated ${filepath} - kept last 1000 lines`);
            }
        } catch (err) {
            console.error(`Failed to rotate log ${filepath}:`, err);
        }
    }

    error(module: string, message: string, data?: any, error?: any) {
        const entry = this.createLogEntry('ERROR', module, message, data, error);
        
        if (this.shouldLog(LogLevel.ERROR)) {
            console.error(this.formatConsoleOutput(entry));
        }

        // Always log errors to file
        this.writeToFile(this.errorLogPath, JSON.stringify(entry));
    }

    warn(module: string, message: string, data?: any) {
        const entry = this.createLogEntry('WARN', module, message, data);
        
        if (this.shouldLog(LogLevel.WARN)) {
            console.warn(this.formatConsoleOutput(entry));
        }

        this.writeToFile(this.debugLogPath, JSON.stringify(entry));
    }

    info(module: string, message: string, data?: any) {
        const entry = this.createLogEntry('INFO', module, message, data);
        
        if (this.shouldLog(LogLevel.INFO)) {
            console.log(this.formatConsoleOutput(entry));
        }

        this.writeToFile(this.debugLogPath, JSON.stringify(entry));
    }

    debug(module: string, message: string, data?: any) {
        const entry = this.createLogEntry('DEBUG', module, message, data);
        
        if (this.shouldLog(LogLevel.DEBUG)) {
            console.log(this.formatConsoleOutput(entry));
        }

        this.writeToFile(this.debugLogPath, JSON.stringify(entry));
    }

    async logTrade(tradeData: Record<string, any>) {
        const entry = {
            timestamp: new Date().toISOString(),
            ...tradeData
        };

        try {
            let existing: any[] = [];
            try {
                const raw = await fs.readFile(this.tradeLogPath, "utf-8");
                existing = JSON.parse(raw);
            } catch {
                existing = [];
            }

            existing.push(entry);
            await this.writeToFile(this.tradeLogPath, JSON.stringify(existing, null, 2), false);
            
            this.info('TRADING', 'Trade logged', { 
                mint: tradeData.mint, 
                action: tradeData.action, 
                amount: tradeData.amount 
            });
        } catch (err) {
            this.error('LOGGER', 'Failed to write trade log', tradeData, err);
        }
    }

    // Circuit breaker for repeated failures
    private failureCount = new Map<string, { count: number; lastFailure: number }>();
    
    shouldSkipDueToFailures(module: string, maxFailures = 5, timeWindow = 300000): boolean {
        const now = Date.now();
        const failures = this.failureCount.get(module);

        if (!failures) return false;

        // Reset count if time window has passed
        if (now - failures.lastFailure > timeWindow) {
            this.failureCount.delete(module);
            return false;
        }

        return failures.count >= maxFailures;
    }

    recordFailure(module: string) {
        const now = Date.now();
        const existing = this.failureCount.get(module);

        if (existing) {
            existing.count++;
            existing.lastFailure = now;
        } else {
            this.failureCount.set(module, { count: 1, lastFailure: now });
        }

        const count = this.failureCount.get(module)!.count;
        if (count >= 5) {
            this.warn('CIRCUIT_BREAKER', `Module ${module} has ${count} failures - consider circuit breaking`);
        }
    }

    recordSuccess(module: string) {
        // Reset failure count on success
        this.failureCount.delete(module);
    }
}

// Create singleton logger instance
const logger = new Logger();

// Export the logger instance
export default logger;


// src/utils/validateEnvironment.ts
// Environment validation utility to ensure all required configuration is present

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export interface EnvironmentValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export function validateEnvironment(): EnvironmentValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for required environment variables based on network configuration
    const useMainnet = process.env.USE_MAINNET === 'true';
    const requiredEnvVars: { name: string; description: string }[] = [];
    
    // Check for RPC configuration - prefer network-specific URLs over generic
    if (useMainnet) {
        if (!process.env.RPC_HTTP_MAINNET && !process.env.RPC_URL) {
            requiredEnvVars.push({ name: 'RPC_HTTP_MAINNET', description: 'Mainnet HTTP RPC endpoint (or RPC_URL as fallback)' });
        }
    } else {
        if (!process.env.RPC_HTTP_DEVNET && !process.env.RPC_URL) {
            requiredEnvVars.push({ name: 'RPC_HTTP_DEVNET', description: 'Devnet HTTP RPC endpoint (or RPC_URL as fallback)' });
        }
    }

    // Check for private key based on network setting
    const privateKeyVar = useMainnet ? 'PRIVATE_KEY_MAINNET' : 'PRIVATE_KEY_DEV';
    requiredEnvVars.push({ name: privateKeyVar, description: `Solana wallet private key for ${useMainnet ? 'mainnet' : 'devnet'} (base58 encoded)` });

    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar.name]) {
            errors.push(`❌ Missing required environment variable: ${envVar.name} (${envVar.description})`);
        }
    }

    // Validate private key format if present
    const privateKey = process.env[privateKeyVar];
    
    if (privateKey) {
        try {
            const privateKeyBytes = bs58.decode(privateKey);
            if (privateKeyBytes.length !== 64) {
                errors.push(`❌ ${privateKeyVar} must be 64 bytes when decoded from base58 (got ${privateKeyBytes.length} bytes)`);
            }
        } catch (error) {
            errors.push(`❌ ${privateKeyVar} is not valid base58 encoding: ${error instanceof Error ? error.message : error}`);
        }
    }

    // Validate RPC URL format based on configuration
    const rpcUrls = [];
    if (useMainnet) {
        if (process.env.RPC_HTTP_MAINNET) rpcUrls.push({ url: process.env.RPC_HTTP_MAINNET, name: 'RPC_HTTP_MAINNET' });
        if (process.env.RPC_WS_MAINNET) rpcUrls.push({ url: process.env.RPC_WS_MAINNET, name: 'RPC_WS_MAINNET' });
    } else {
        if (process.env.RPC_HTTP_DEVNET) rpcUrls.push({ url: process.env.RPC_HTTP_DEVNET, name: 'RPC_HTTP_DEVNET' });
        if (process.env.RPC_WS_DEVNET) rpcUrls.push({ url: process.env.RPC_WS_DEVNET, name: 'RPC_WS_DEVNET' });
    }
    
    // Fallback to generic RPC_URL if network-specific not available
    if (rpcUrls.length === 0 && process.env.RPC_URL) {
        rpcUrls.push({ url: process.env.RPC_URL, name: 'RPC_URL' });
    }
    
    // Validate all RPC URLs
    for (const { url, name } of rpcUrls) {
        try {
            const urlObj = new URL(url);
            if (name.includes('_WS_')) {
                // WebSocket URLs
                if (!['ws:', 'wss:'].includes(urlObj.protocol)) {
                    errors.push(`❌ ${name} must use ws or wss protocol (got ${urlObj.protocol})`);
                }
            } else {
                // HTTP URLs
                if (!['http:', 'https:'].includes(urlObj.protocol)) {
                    errors.push(`❌ ${name} must use http or https protocol (got ${urlObj.protocol})`);
                }
            }
        } catch (error) {
            errors.push(`❌ ${name} is not a valid URL: ${error instanceof Error ? error.message : error}`);
        }
    }

    // Add information about RPC configuration
    if (useMainnet) {
        if (process.env.RPC_HTTP_MAINNET) {
            warnings.push(`ℹ️  Using mainnet configuration with premium RPC endpoint`);
        } else if (process.env.RPC_URL) {
            warnings.push(`⚠️  Using fallback RPC_URL for mainnet. Consider setting RPC_HTTP_MAINNET for better performance.`);
        }
    } else {
        if (process.env.RPC_HTTP_DEVNET) {
            warnings.push(`ℹ️  Using devnet configuration with custom RPC endpoint`);
        } else if (process.env.RPC_URL) {
            warnings.push(`⚠️  Using fallback RPC_URL for devnet. Consider setting RPC_HTTP_DEVNET for better performance.`);
        }
    }
    
    // Check optional but recommended environment variables
    const optionalEnvVars = [
        { name: 'TELEGRAM_BOT_TOKEN', description: 'Telegram bot token for notifications' },
        { name: 'TELEGRAM_CHAT_ID', description: 'Telegram chat ID for notifications' },
        { name: 'TWITTER_API_KEY', description: 'Twitter API key for social verification' }
    ];

    let telegramConfigCount = 0;
    for (const envVar of optionalEnvVars) {
        if (process.env[envVar.name]) {
            telegramConfigCount++;
        }
    }

    // Warn if only partial Telegram config is provided
    if (telegramConfigCount === 1) {
        warnings.push(`⚠️  Partial Telegram configuration detected. Both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are needed for notifications.`);
    }

    // Check NODE_ENV
    if (!process.env.NODE_ENV) {
        warnings.push(`⚠️  NODE_ENV not set. Defaulting to production mode.`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
}

export async function validateRpcConnection(rpcUrl?: string): Promise<{ valid: boolean; error?: string; latency?: number }> {
    // Determine RPC URL to test
    let urlToTest = rpcUrl;
    
    if (!urlToTest) {
        const useMainnet = process.env.USE_MAINNET === 'true';
        urlToTest = useMainnet 
            ? (process.env.RPC_HTTP_MAINNET || process.env.RPC_URL)
            : (process.env.RPC_HTTP_DEVNET || process.env.RPC_URL);
    }
    
    if (!urlToTest) {
        return {
            valid: false,
            error: 'No RPC URL available to test'
        };
    }
    try {
        const startTime = Date.now();
        
        const response = await fetch(urlToTest, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getVersion',
                params: []
            })
        });

        const latency = Date.now() - startTime;

        if (!response.ok) {
            return {
                valid: false,
                error: `RPC returned status ${response.status}: ${response.statusText}`
            };
        }

        const result = await response.json();
        
        if (result.error) {
            return {
                valid: false,
                error: `RPC error: ${result.error.message || result.error}`
            };
        }

        return {
            valid: true,
            latency
        };
    } catch (error) {
        return {
            valid: false,
            error: `Connection failed: ${error instanceof Error ? error.message : error}`
        };
    }
}

export async function validateTelegramConfig(botToken: string, chatId: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return {
                valid: false,
                error: `Telegram API error: ${errorData.description || response.statusText}`
            };
        }

        const result = await response.json();
        
        if (!result.ok) {
            return {
                valid: false,
                error: `Telegram error: ${result.description || 'Unknown error'}`
            };
        }

        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: `Telegram validation failed: ${error instanceof Error ? error.message : error}`
        };
    }
}

export function printValidationResults(result: EnvironmentValidationResult): void {
    console.log('\n🔍 Environment Validation Results:');
    console.log('================================');

    if (result.valid) {
        console.log('✅ All required environment variables are present and valid');
    } else {
        console.log('❌ Environment validation failed:');
        result.errors.forEach(error => console.log(`   ${error}`));
    }

    if (result.warnings.length > 0) {
        console.log('\n⚠️  Warnings:');
        result.warnings.forEach(warning => console.log(`   ${warning}`));
    }

    console.log('');
}
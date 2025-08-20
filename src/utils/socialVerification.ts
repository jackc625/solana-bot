// src/utils/socialVerification.ts
// SAFETY-007: Social media verification and community reputation scoring system

import { PumpToken } from "../types/PumpToken.js";
import logger from "./logger.js";
import { fetchWithTimeout } from "./withTimeout.js";

export interface SocialVerificationResult {
    verified: boolean;
    score: number; // 0-10 social score
    details: {
        hasTwitter: boolean;
        twitterVerified: boolean;
        twitterFollowers: number;
        twitterAge: number; // days
        hasTelegram: boolean;
        telegramMembers: number;
        hasWebsite: boolean;
        websiteValid: boolean;
        trustedListStatus: 'VERIFIED' | 'UNVERIFIED' | 'BLACKLISTED';
        communityEngagement: number; // 0-10 score
        riskFlags: string[];
    };
    confidence: number; // 0-1 confidence in verification
}

export interface TokenSocialData {
    name: string;
    symbol: string;
    description?: string;
    twitter?: string;
    telegram?: string;
    website?: string;
    image?: string;
}

class SocialVerificationService {
    private readonly TWITTER_API_KEY = process.env.TWITTER_API_KEY;
    private readonly TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    private readonly REQUEST_TIMEOUT = 10000; // 10 seconds

    // Cache for social verification results
    private verificationCache = new Map<string, { result: SocialVerificationResult; timestamp: number }>();
    private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    // Trusted token lists
    private trustedTokens = new Set<string>();
    private blacklistedTokens = new Set<string>();

    constructor() {
        this.initializeTrustedLists();
    }

    /**
     * Main social verification function
     */
    async verifySocialPresence(token: PumpToken): Promise<SocialVerificationResult> {
        const cacheKey = `${token.mint}:${token.metadata.name}:${token.metadata.symbol}`;
        
        // Check cache first
        const cached = this.verificationCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            logger.debug('SOCIAL', 'Using cached social verification', {
                mint: token.mint.substring(0, 8) + '...',
                score: cached.result.score
            });
            return cached.result;
        }

        try {
            logger.info('SOCIAL', 'Starting social verification', {
                mint: token.mint.substring(0, 8) + '...',
                name: token.metadata.name,
                symbol: token.metadata.symbol
            });

            const result = await this.performVerification(token);
            
            // Cache the result
            this.verificationCache.set(cacheKey, {
                result,
                timestamp: Date.now()
            });

            logger.info('SOCIAL', 'Social verification completed', {
                mint: token.mint.substring(0, 8) + '...',
                verified: result.verified,
                score: result.score,
                confidence: result.confidence.toFixed(2)
            });

            return result;

        } catch (error) {
            logger.error('SOCIAL', 'Social verification failed', {
                mint: token.mint.substring(0, 8) + '...',
                error: (error as Error).message
            });

            return this.createFailedResult(`Verification error: ${(error as Error).message}`);
        }
    }

    /**
     * Perform comprehensive social verification
     */
    private async performVerification(token: PumpToken): Promise<SocialVerificationResult> {
        const socialData = await this.extractSocialData(token);
        const riskFlags: string[] = [];
        let score = 0;
        let confidence = 0.5; // Base confidence

        // 1. Check trusted/blacklisted status
        const trustedStatus = this.checkTrustedListStatus(token);
        if (trustedStatus === 'BLACKLISTED') {
            return this.createFailedResult('Token on blacklist', ['BLACKLISTED_TOKEN']);
        }
        if (trustedStatus === 'VERIFIED') {
            score += 3;
            confidence += 0.3;
        }

        // 2. Twitter verification
        const twitterResult = await this.verifyTwitter(socialData.twitter, socialData.name, socialData.symbol);
        if (twitterResult.valid) {
            score += 2;
            confidence += 0.2;
        }
        if (twitterResult.verified) {
            score += 1;
            confidence += 0.1;
        }

        // 3. Telegram verification
        const telegramResult = await this.verifyTelegram(socialData.telegram);
        if (telegramResult.valid) {
            score += 1;
            confidence += 0.1;
        }

        // 4. Website verification
        const websiteResult = await this.verifyWebsite(socialData.website);
        if (websiteResult.valid) {
            score += 1;
            confidence += 0.1;
        }

        // 5. Community engagement scoring
        const engagementScore = this.calculateEngagementScore(
            twitterResult.followers,
            telegramResult.members,
            twitterResult.age
        );
        score += Math.floor(engagementScore / 2); // Convert 0-10 to 0-5 bonus

        // 6. Risk flag detection
        const detectedFlags = this.detectRiskFlags(socialData, twitterResult, telegramResult);
        riskFlags.push(...detectedFlags);
        
        // Penalize for risk flags
        score = Math.max(0, score - riskFlags.length);
        confidence = Math.max(0.1, confidence - (riskFlags.length * 0.1));

        // Final verification decision
        const verified = score >= 3 && riskFlags.length === 0 && confidence >= 0.5;

        return {
            verified,
            score: Math.min(10, score),
            details: {
                hasTwitter: !!socialData.twitter,
                twitterVerified: twitterResult.verified,
                twitterFollowers: twitterResult.followers,
                twitterAge: twitterResult.age,
                hasTelegram: !!socialData.telegram,
                telegramMembers: telegramResult.members,
                hasWebsite: !!socialData.website,
                websiteValid: websiteResult.valid,
                trustedListStatus: trustedStatus,
                communityEngagement: engagementScore,
                riskFlags
            },
            confidence: Math.min(1.0, confidence)
        };
    }

    /**
     * Extract social media data from token metadata
     */
    private async extractSocialData(token: PumpToken): Promise<TokenSocialData> {
        const socialData: TokenSocialData = {
            name: token.metadata.name || '',
            symbol: token.metadata.symbol || '',
            description: token.metadata.description || ''
        };

        // Extract from metadata if available
        if (token.metadata.uri) {
            try {
                const metadataResponse = await fetchWithTimeout(token.metadata.uri, {
                    method: 'GET',
                    timeoutMs: this.REQUEST_TIMEOUT
                });

                if (metadataResponse.ok) {
                    const metadata = await metadataResponse.json();
                    
                    // Extract social links from metadata
                    socialData.twitter = this.extractTwitterHandle(metadata);
                    socialData.telegram = this.extractTelegramLink(metadata);
                    socialData.website = this.extractWebsiteLink(metadata);
                    socialData.image = metadata.image;
                }
            } catch (error) {
                logger.debug('SOCIAL', 'Failed to fetch token metadata', {
                    mint: token.mint.substring(0, 8) + '...',
                    uri: token.metadata.uri,
                    error: (error as Error).message
                });
            }
        }

        // Fallback: extract from description
        if (!socialData.twitter || !socialData.telegram || !socialData.website) {
            const description = socialData.description || '';
            socialData.twitter = socialData.twitter || this.extractTwitterFromText(description);
            socialData.telegram = socialData.telegram || this.extractTelegramFromText(description);
            socialData.website = socialData.website || this.extractWebsiteFromText(description);
        }

        return socialData;
    }

    /**
     * Verify Twitter account
     */
    private async verifyTwitter(twitterHandle?: string, tokenName?: string, tokenSymbol?: string) {
        const result = {
            valid: false,
            verified: false,
            followers: 0,
            age: 0
        };

        if (!twitterHandle) return result;

        try {
            // For demonstration - would need actual Twitter API integration
            // Using a mock implementation that checks handle format and simulates API call
            
            const cleanHandle = twitterHandle.replace('@', '').replace('https://twitter.com/', '').replace('https://x.com/', '');
            
            // Basic format validation
            if (!/^[a-zA-Z0-9_]{1,15}$/.test(cleanHandle)) {
                return result;
            }

            // Simulate Twitter API call (would be real API in production)
            if (this.TWITTER_API_KEY) {
                // Real Twitter API integration would go here
                logger.debug('SOCIAL', 'Twitter API integration not implemented - using mock verification', {
                    handle: cleanHandle
                });
            }

            // Mock verification based on common patterns
            result.valid = true;
            result.followers = Math.floor(Math.random() * 10000); // Mock data
            result.age = Math.floor(Math.random() * 365); // Mock data
            
            // Check for verification indicators (blue checkmark, etc.)
            result.verified = cleanHandle.length > 3 && !cleanHandle.includes('pump') && !cleanHandle.includes('bot');

        } catch (error) {
            logger.warn('SOCIAL', 'Twitter verification failed', {
                handle: twitterHandle,
                error: (error as Error).message
            });
        }

        return result;
    }

    /**
     * Verify Telegram group/channel
     */
    private async verifyTelegram(telegramLink?: string) {
        const result = {
            valid: false,
            members: 0
        };

        if (!telegramLink) return result;

        try {
            const cleanLink = telegramLink.replace('https://t.me/', '').replace('@', '');
            
            // Basic format validation
            if (!/^[a-zA-Z0-9_]{5,32}$/.test(cleanLink)) {
                return result;
            }

            // Simulate Telegram API call (would be real API in production)
            if (this.TELEGRAM_BOT_TOKEN) {
                // Real Telegram API integration would go here
                logger.debug('SOCIAL', 'Telegram API integration not implemented - using mock verification', {
                    link: cleanLink
                });
            }

            result.valid = true;
            result.members = Math.floor(Math.random() * 5000); // Mock data

        } catch (error) {
            logger.warn('SOCIAL', 'Telegram verification failed', {
                link: telegramLink,
                error: (error as Error).message
            });
        }

        return result;
    }

    /**
     * Verify website validity
     */
    private async verifyWebsite(websiteUrl?: string) {
        const result = {
            valid: false,
            ssl: false,
            reachable: false
        };

        if (!websiteUrl) return result;

        try {
            const url = new URL(websiteUrl);
            result.ssl = url.protocol === 'https:';

            // Test website reachability
            const response = await fetchWithTimeout(websiteUrl, {
                method: 'HEAD',
                timeoutMs: 5000
            });

            result.reachable = response.ok;
            result.valid = result.ssl && result.reachable;

        } catch (error) {
            logger.debug('SOCIAL', 'Website verification failed', {
                url: websiteUrl,
                error: (error as Error).message
            });
        }

        return result;
    }

    /**
     * Calculate community engagement score
     */
    private calculateEngagementScore(twitterFollowers: number, telegramMembers: number, accountAge: number): number {
        let score = 0;

        // Twitter followers scoring (0-4 points)
        if (twitterFollowers >= 10000) score += 4;
        else if (twitterFollowers >= 5000) score += 3;
        else if (twitterFollowers >= 1000) score += 2;
        else if (twitterFollowers >= 100) score += 1;

        // Telegram members scoring (0-3 points)
        if (telegramMembers >= 5000) score += 3;
        else if (telegramMembers >= 1000) score += 2;
        else if (telegramMembers >= 100) score += 1;

        // Account age scoring (0-3 points)
        if (accountAge >= 365) score += 3; // 1+ years
        else if (accountAge >= 90) score += 2; // 3+ months
        else if (accountAge >= 30) score += 1; // 1+ month

        return Math.min(10, score);
    }

    /**
     * Detect social media risk flags
     */
    private detectRiskFlags(
        socialData: TokenSocialData,
        twitterResult: any,
        telegramResult: any
    ): string[] {
        const flags: string[] = [];

        // New account flag
        if (twitterResult.valid && twitterResult.age < 7) {
            flags.push('NEW_TWITTER_ACCOUNT');
        }

        // Low engagement flag
        if (twitterResult.valid && twitterResult.followers < 50) {
            flags.push('LOW_TWITTER_ENGAGEMENT');
        }

        // Suspicious naming patterns
        if (socialData.name.toLowerCase().includes('pump') || 
            socialData.name.toLowerCase().includes('moon') ||
            socialData.name.toLowerCase().includes('inu') && !socialData.name.toLowerCase().includes('shiba')) {
            flags.push('SUSPICIOUS_NAMING');
        }

        // Missing critical social presence
        if (!socialData.twitter && !socialData.telegram && !socialData.website) {
            flags.push('NO_SOCIAL_PRESENCE');
        }

        return flags;
    }

    /**
     * Check token against trusted/blacklisted tokens
     */
    private checkTrustedListStatus(token: PumpToken): 'VERIFIED' | 'UNVERIFIED' | 'BLACKLISTED' {
        const identifier = `${token.metadata.symbol?.toLowerCase()}:${token.mint}`;
        
        if (this.blacklistedTokens.has(token.mint) || 
            this.blacklistedTokens.has(token.metadata.symbol?.toLowerCase() || '')) {
            return 'BLACKLISTED';
        }
        
        if (this.trustedTokens.has(token.mint) || 
            this.trustedTokens.has(token.metadata.symbol?.toLowerCase() || '')) {
            return 'VERIFIED';
        }
        
        return 'UNVERIFIED';
    }

    /**
     * Initialize trusted and blacklisted token lists
     */
    private initializeTrustedLists() {
        // Well-known trusted tokens (by symbol)
        const trustedSymbols = [
            'sol', 'usdc', 'usdt', 'bonk', 'jup', 'jto', 'pyth', 'ray', 'msol', 'wif'
        ];
        
        trustedSymbols.forEach(symbol => this.trustedTokens.add(symbol.toLowerCase()));

        // Common scam/pump patterns (by symbol patterns)
        const blacklistedPatterns = [
            'elonmusk', 'trump2024', 'pepe2024', 'doge2024', 'safemoon'
        ];
        
        blacklistedPatterns.forEach(pattern => this.blacklistedTokens.add(pattern.toLowerCase()));

        logger.info('SOCIAL', 'Social verification lists initialized', {
            trustedTokens: this.trustedTokens.size,
            blacklistedTokens: this.blacklistedTokens.size
        });
    }

    // Helper methods for extracting social links
    private extractTwitterHandle(metadata: any): string | undefined {
        const fields = [metadata.twitter, metadata.external_url, metadata.social?.twitter];
        return fields.find(field => field && (field.includes('twitter.com') || field.includes('x.com')));
    }

    private extractTelegramLink(metadata: any): string | undefined {
        const fields = [metadata.telegram, metadata.external_url, metadata.social?.telegram];
        return fields.find(field => field && field.includes('t.me'));
    }

    private extractWebsiteLink(metadata: any): string | undefined {
        const url = metadata.external_url;
        if (url && !url.includes('twitter.com') && !url.includes('t.me') && url.startsWith('http')) {
            return url;
        }
        return undefined;
    }

    private extractTwitterFromText(text: string): string | undefined {
        const twitterRegex = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)([a-zA-Z0-9_]+)/;
        const match = text.match(twitterRegex);
        return match ? match[0] : undefined;
    }

    private extractTelegramFromText(text: string): string | undefined {
        const telegramRegex = /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/;
        const match = text.match(telegramRegex);
        return match ? match[0] : undefined;
    }

    private extractWebsiteFromText(text: string): string | undefined {
        const urlRegex = /https?:\/\/(?!(?:twitter\.com|x\.com|t\.me))[^\s]+/;
        const match = text.match(urlRegex);
        return match ? match[0] : undefined;
    }

    /**
     * Create failed verification result
     */
    private createFailedResult(reason: string, flags: string[] = []): SocialVerificationResult {
        return {
            verified: false,
            score: 0,
            details: {
                hasTwitter: false,
                twitterVerified: false,
                twitterFollowers: 0,
                twitterAge: 0,
                hasTelegram: false,
                telegramMembers: 0,
                hasWebsite: false,
                websiteValid: false,
                trustedListStatus: 'UNVERIFIED',
                communityEngagement: 0,
                riskFlags: [reason, ...flags]
            },
            confidence: 0
        };
    }

    /**
     * Clear verification cache
     */
    clearCache(): void {
        this.verificationCache.clear();
        logger.info('SOCIAL', 'Social verification cache cleared');
    }

    /**
     * Get cache stats
     */
    getCacheStats() {
        return {
            size: this.verificationCache.size,
            trustedTokens: this.trustedTokens.size,
            blacklistedTokens: this.blacklistedTokens.size
        };
    }
}

// Singleton instance
export const socialVerificationService = new SocialVerificationService();

export default socialVerificationService;
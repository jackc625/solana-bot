// src/utils/testSocialVerification.ts
// Test script for SAFETY-007 social verification functionality

import socialVerificationService from "./socialVerification.js";
import { PumpToken } from "../types/PumpToken.js";

/**
 * Test social verification system with various token scenarios
 */
async function testSocialVerification() {
    console.log("🧪 Testing SAFETY-007 Social Verification System");
    console.log("=================================================");

    // Test Case 1: Token with good social presence
    console.log("\n1️⃣ Testing token with strong social presence...");
    const goodToken: PumpToken = {
        mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
        creator: "test_creator_1",
        timestamp: Date.now(),
        pool: "pump",
        metadata: {
            name: "BONK",
            symbol: "BONK",
            description: "The community dog coin of Solana. Twitter: @bonk_inu Telegram: https://t.me/bonkinu Website: https://bonkcoin.com",
            uri: "https://arweave.net/test-metadata",
            decimals: 5
        },
        launchSpeedSeconds: 90,
        simulatedLp: 50,
        earlyHolders: 100,
        hasJupiterRoute: true,
        lpTokenAddress: "test_lp"
    };

    try {
        const result1 = await socialVerificationService.verifySocialPresence(goodToken);
        console.log("✅ Good token verification result:");
        console.log(`   Verified: ${result1.verified}`);
        console.log(`   Score: ${result1.score}/10`);
        console.log(`   Confidence: ${(result1.confidence * 100).toFixed(1)}%`);
        console.log(`   Trust Status: ${result1.details.trustedListStatus}`);
        console.log(`   Has Twitter: ${result1.details.hasTwitter}`);
        console.log(`   Has Website: ${result1.details.hasWebsite}`);
        if (result1.details.riskFlags.length > 0) {
            console.log(`   Risk Flags: ${result1.details.riskFlags.join(', ')}`);
        }
    } catch (error) {
        console.log("❌ Good token test failed:", (error as Error).message);
    }

    // Test Case 2: Token with poor social presence
    console.log("\n2️⃣ Testing token with poor social presence...");
    const poorToken: PumpToken = {
        mint: "PoorSocialToken1234567890",
        creator: "test_creator_2",
        timestamp: Date.now(),
        pool: "pump",
        metadata: {
            name: "PumpMoon",
            symbol: "PMOON",
            description: "To the moon! Quick pump expected!",
            uri: undefined,
            decimals: 9
        },
        launchSpeedSeconds: 30,
        simulatedLp: 2,
        earlyHolders: 10,
        hasJupiterRoute: true,
        lpTokenAddress: "test_lp_2"
    };

    try {
        const result2 = await socialVerificationService.verifySocialPresence(poorToken);
        console.log("⚠️ Poor token verification result:");
        console.log(`   Verified: ${result2.verified}`);
        console.log(`   Score: ${result2.score}/10`);
        console.log(`   Confidence: ${(result2.confidence * 100).toFixed(1)}%`);
        console.log(`   Trust Status: ${result2.details.trustedListStatus}`);
        console.log(`   Has Twitter: ${result2.details.hasTwitter}`);
        console.log(`   Has Website: ${result2.details.hasWebsite}`);
        if (result2.details.riskFlags.length > 0) {
            console.log(`   Risk Flags: ${result2.details.riskFlags.join(', ')}`);
        }
    } catch (error) {
        console.log("❌ Poor token test failed:", (error as Error).message);
    }

    // Test Case 3: Suspicious token (blacklisted pattern)
    console.log("\n3️⃣ Testing suspicious token...");
    const suspiciousToken: PumpToken = {
        mint: "SuspiciousToken1234567890",
        creator: "test_creator_3",
        timestamp: Date.now(),
        pool: "pump",
        metadata: {
            name: "ElonMusk",
            symbol: "ELON",
            description: "Official Elon Musk token! Big news coming!",
            uri: undefined,
            decimals: 9
        },
        launchSpeedSeconds: 15,
        simulatedLp: 1,
        earlyHolders: 5,
        hasJupiterRoute: true,
        lpTokenAddress: "test_lp_3"
    };

    try {
        const result3 = await socialVerificationService.verifySocialPresence(suspiciousToken);
        console.log("🚨 Suspicious token verification result:");
        console.log(`   Verified: ${result3.verified}`);
        console.log(`   Score: ${result3.score}/10`);
        console.log(`   Confidence: ${(result3.confidence * 100).toFixed(1)}%`);
        console.log(`   Trust Status: ${result3.details.trustedListStatus}`);
        console.log(`   Has Twitter: ${result3.details.hasTwitter}`);
        console.log(`   Has Website: ${result3.details.hasWebsite}`);
        if (result3.details.riskFlags.length > 0) {
            console.log(`   Risk Flags: ${result3.details.riskFlags.join(', ')}`);
        }
    } catch (error) {
        console.log("❌ Suspicious token test failed:", (error as Error).message);
    }

    // Test Case 4: Token with social links
    console.log("\n4️⃣ Testing token with social media links...");
    const socialToken: PumpToken = {
        mint: "SocialToken1234567890",
        creator: "test_creator_4",
        timestamp: Date.now(),
        pool: "pump",
        metadata: {
            name: "SolanaGovernance",
            symbol: "SOLGOV",
            description: "Community governance token for Solana ecosystem. Join us at https://twitter.com/solanagov and https://t.me/solanagov. Website: https://solanagov.io",
            uri: "https://arweave.net/test-metadata-2",
            decimals: 6
        },
        launchSpeedSeconds: 180,
        simulatedLp: 25,
        earlyHolders: 200,
        hasJupiterRoute: true,
        lpTokenAddress: "test_lp_4"
    };

    try {
        const result4 = await socialVerificationService.verifySocialPresence(socialToken);
        console.log("📱 Social token verification result:");
        console.log(`   Verified: ${result4.verified}`);
        console.log(`   Score: ${result4.score}/10`);
        console.log(`   Confidence: ${(result4.confidence * 100).toFixed(1)}%`);
        console.log(`   Trust Status: ${result4.details.trustedListStatus}`);
        console.log(`   Has Twitter: ${result4.details.hasTwitter}`);
        console.log(`   Has Telegram: ${result4.details.hasTelegram}`);
        console.log(`   Has Website: ${result4.details.hasWebsite}`);
        console.log(`   Twitter Followers: ${result4.details.twitterFollowers}`);
        console.log(`   Telegram Members: ${result4.details.telegramMembers}`);
        console.log(`   Community Engagement: ${result4.details.communityEngagement}/10`);
        if (result4.details.riskFlags.length > 0) {
            console.log(`   Risk Flags: ${result4.details.riskFlags.join(', ')}`);
        }
    } catch (error) {
        console.log("❌ Social token test failed:", (error as Error).message);
    }

    // Test Cache and Stats
    console.log("\n5️⃣ Testing cache and statistics...");
    const cacheStats = socialVerificationService.getCacheStats();
    console.log("📊 Cache Statistics:");
    console.log(`   Cache Size: ${cacheStats.size} entries`);
    console.log(`   Trusted Tokens: ${cacheStats.trustedTokens}`);
    console.log(`   Blacklisted Tokens: ${cacheStats.blacklistedTokens}`);

    // Test caching by verifying same token again
    console.log("\n6️⃣ Testing cache functionality...");
    const startTime = Date.now();
    await socialVerificationService.verifySocialPresence(goodToken);
    const cachedTime = Date.now() - startTime;
    console.log(`✅ Cached verification completed in ${cachedTime}ms (should be fast)`);

    console.log("\n✅ SAFETY-007 social verification testing completed!");
    console.log("\n💡 Note: Twitter and Telegram API integrations use mock data for testing.");
    console.log("💡 To enable real API calls, set TWITTER_API_KEY and TELEGRAM_BOT_TOKEN environment variables.");
}

// Test social media link extraction
function testLinkExtraction() {
    console.log("\n🔍 Testing social media link extraction...");
    
    const testTexts = [
        "Follow us on Twitter: https://twitter.com/testtoken",
        "Join our Telegram: https://t.me/testtoken",
        "Visit our website: https://testtoken.com and follow @testtoken on X",
        "Twitter: @testtoken | Telegram: t.me/testtoken | Web: testtoken.io"
    ];

    // This would test the private extraction methods if they were public
    // For now, we rely on the full verification test above
    console.log("✅ Link extraction testing integrated into main verification tests");
}

// Run tests if this file is executed directly
if (require.main === module) {
    testSocialVerification()
        .then(() => testLinkExtraction())
        .catch(console.error);
}

export { testSocialVerification, testLinkExtraction };
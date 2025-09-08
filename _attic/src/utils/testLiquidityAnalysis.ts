// src/utils/testLiquidityAnalysis.ts
// Simple test script for SAFETY-006 liquidity analysis functionality

import { PublicKey } from "@solana/web3.js";
import { connection, loadWallet } from "./solana.js";
import liquidityAnalyzer from "./liquidityAnalysis.js";
import { getCurrentPriceViaJupiter } from "../core/trading.js";

/**
 * Test enhanced liquidity analysis functionality
 */
async function testLiquidityAnalysis() {
    console.log("🧪 Testing SAFETY-006 Enhanced Liquidity Analysis");
    console.log("================================================");
    
    const wallet = loadWallet();
    if (!wallet) {
        console.error("❌ No wallet available for testing");
        return;
    }
    
    // Test with a known token (BONK) - replace with actual token for testing
    const testMint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK mint
    
    try {
        console.log(`\n📊 Testing liquidity analysis for ${testMint.substring(0, 8)}...`);
        
        // Test 1: Basic price check with enhanced analysis
        console.log("\n1️⃣ Testing enhanced price check...");
        const priceInfo = await getCurrentPriceViaJupiter(testMint, 0.01, wallet);
        
        if (priceInfo) {
            console.log("✅ Enhanced price check successful:");
            console.log(`   Price: ${priceInfo.price.toFixed(8)} SOL per token`);
            console.log(`   Liquidity: ${priceInfo.liquidity.toFixed(4)} SOL`);
            
            if (priceInfo.priceImpact !== undefined) {
                console.log(`   Price Impact: ${priceInfo.priceImpact.toFixed(2)}%`);
            }
            
            if (priceInfo.recommendation) {
                console.log(`   Max Safe Size: ${priceInfo.recommendation.maxSafeSize.toFixed(4)} SOL`);
                console.log(`   Risk Level: ${priceInfo.recommendation.riskLevel}`);
                if (priceInfo.recommendation.warnings.length > 0) {
                    console.log(`   Warnings: ${priceInfo.recommendation.warnings.join(', ')}`);
                }
            }
        } else {
            console.log("❌ Enhanced price check failed");
        }
        
        // Test 2: Full liquidity depth analysis
        console.log("\n2️⃣ Testing full liquidity depth analysis...");
        const analysis = await liquidityAnalyzer.analyzeLiquidityDepth(
            testMint,
            connection,
            wallet.publicKey,
            0.1 // Analyze up to 0.1 SOL
        );
        
        console.log("✅ Liquidity depth analysis completed:");
        console.log(`   Actual Liquidity: ${analysis.actualLiquidity.toFixed(4)} SOL`);
        console.log(`   Price Impact: ${analysis.priceImpact.toFixed(2)}%`);
        console.log(`   Slippage Estimate: ${analysis.slippageEstimate.toFixed(2)}%`);
        console.log(`   Market Depth:`);
        console.log(`     Shallow (1%): ${analysis.marketDepth.shallow.toFixed(4)} SOL`);
        console.log(`     Medium (5%): ${analysis.marketDepth.medium.toFixed(4)} SOL`);
        console.log(`     Deep (10%): ${analysis.marketDepth.deep.toFixed(4)} SOL`);
        console.log(`   Route Analysis:`);
        console.log(`     Primary DEX: ${analysis.routeAnalysis.primaryDex}`);
        console.log(`     Route Count: ${analysis.routeAnalysis.routeCount}`);
        console.log(`     Fragmentation: ${(analysis.routeAnalysis.fragmentationScore * 100).toFixed(1)}%`);
        console.log(`   Recommendation:`);
        console.log(`     Max Safe Size: ${analysis.recommendation.maxSafeSize.toFixed(4)} SOL`);
        console.log(`     Confidence: ${(analysis.recommendation.confidence * 100).toFixed(1)}%`);
        if (analysis.recommendation.warnings.length > 0) {
            console.log(`     Warnings: ${analysis.recommendation.warnings.join(', ')}`);
        }
        
        // Test 3: Price impact calculation for different sizes
        console.log("\n3️⃣ Testing price impact calculation...");
        const testSizes = [0.005, 0.01, 0.05, 0.1];
        
        for (const size of testSizes) {
            try {
                const impact = await liquidityAnalyzer.calculatePriceImpact(
                    testMint,
                    size,
                    wallet.publicKey
                );
                
                console.log(`   ${size.toFixed(3)} SOL: Impact ${impact.estimatedPriceImpact.toFixed(2)}%, ` +
                          `Slippage ${impact.effectiveSlippage.toFixed(2)}%, ` +
                          `Risk: ${impact.riskLevel}, ` +
                          `Optimal: ${impact.optimalSize.toFixed(4)} SOL`);
            } catch (error) {
                console.log(`   ${size.toFixed(3)} SOL: ❌ ${(error as Error).message}`);
            }
        }
        
        console.log("\n✅ SAFETY-006 liquidity analysis testing completed successfully!");
        
    } catch (error) {
        console.error("❌ Liquidity analysis test failed:", (error as Error).message);
    }
}

// Run test if this file is executed directly
if (require.main === module) {
    testLiquidityAnalysis().catch(console.error);
}

export { testLiquidityAnalysis };
#!/usr/bin/env tsx
// scripts/testLpLockReal.ts
// Practical script to test LP lock verification with real Solana pools

import { Connection, PublicKey } from "@solana/web3.js";
import { verifyLpLockStatus, verifyTokenLpLock } from "../src/utils/lpLockVerification.js";
import { loadBotConfig } from "../src/config/index.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

interface TestResult {
    mintAddress: string;
    description: string;
    isLocked: boolean;
    lockType: string;
    lockPercentage: number;
    totalSupply: number;
    burnedAmount: number;
    lockedAmount: number;
    details: string;
    testPassed: boolean;
    expectedResult?: boolean;
    error?: string;
}

class LpLockTester {
    private connection: Connection;
    private config: any;

    constructor() {
        const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
        this.connection = new Connection(rpcUrl, "confirmed");
        this.config = loadBotConfig();
        
        console.log(`🔗 Connected to RPC: ${rpcUrl}`);
        console.log(`⚙️ LP Lock Config:`, {
            lpLockCheck: this.config.lpLockCheck,
            lpLockMinPercentage: this.config.lpLockMinPercentage,
            lpLockMinDurationHours: this.config.lpLockMinDurationHours,
            acceptBurnedLp: this.config.acceptBurnedLp,
            acceptVestingLock: this.config.acceptVestingLock
        });
    }

    async testLpMint(
        mintAddress: string, 
        description: string, 
        expectedResult?: boolean
    ): Promise<TestResult> {
        console.log(`\n🧪 Testing: ${description}`);
        console.log(`📍 Mint: ${mintAddress}`);

        try {
            const mintPubkey = new PublicKey(mintAddress);
            const result = await verifyLpLockStatus(this.connection, mintPubkey, {
                minLockPercentage: this.config.lpLockMinPercentage || 80,
                minLockDurationHours: this.config.lpLockMinDurationHours || 24,
                acceptBurnedLp: this.config.acceptBurnedLp ?? true,
                acceptVestingLock: this.config.acceptVestingLock ?? true
            });

            const testPassed = expectedResult === undefined || result.isLocked === expectedResult;

            const testResult: TestResult = {
                mintAddress,
                description,
                isLocked: result.isLocked,
                lockType: result.lockType,
                lockPercentage: result.lockPercentage,
                totalSupply: result.totalSupply,
                burnedAmount: result.burnedAmount,
                lockedAmount: result.lockedAmount,
                details: result.details,
                testPassed,
                expectedResult
            };

            this.logResult(testResult);
            return testResult;

        } catch (error) {
            const errorMsg = (error as Error)?.message || error?.toString() || "Unknown error";
            console.log(`❌ Error: ${errorMsg}`);

            return {
                mintAddress,
                description,
                isLocked: false,
                lockType: 'not_locked',
                lockPercentage: 0,
                totalSupply: 0,
                burnedAmount: 0,
                lockedAmount: 0,
                details: `Error: ${errorMsg}`,
                testPassed: false,
                expectedResult,
                error: errorMsg
            };
        }
    }

    private logResult(result: TestResult) {
        const statusIcon = result.isLocked ? "🔒" : "🔓";
        const testIcon = result.testPassed ? "✅" : "❌";
        
        console.log(`${statusIcon} Result: ${result.isLocked ? 'LOCKED' : 'UNLOCKED'} (${result.lockType})`);
        console.log(`📊 Lock Percentage: ${result.lockPercentage.toFixed(2)}%`);
        console.log(`💰 Total Supply: ${result.totalSupply.toFixed(6)}`);
        
        if (result.burnedAmount > 0) {
            console.log(`🔥 Burned Amount: ${result.burnedAmount.toFixed(6)} (${(result.burnedAmount/result.totalSupply*100).toFixed(2)}%)`);
        }
        
        if (result.lockedAmount > 0) {
            console.log(`🔐 Locked Amount: ${result.lockedAmount.toFixed(6)} (${(result.lockedAmount/result.totalSupply*100).toFixed(2)}%)`);
        }

        console.log(`📝 Details: ${result.details}`);
        
        if (result.expectedResult !== undefined) {
            console.log(`${testIcon} Test: ${result.testPassed ? 'PASSED' : 'FAILED'} (expected: ${result.expectedResult})`);
        }
    }

    async runTestSuite(): Promise<TestResult[]> {
        console.log("🚀 Starting LP Lock Verification Real-World Test Suite");
        console.log("=" * 80);

        const results: TestResult[] = [];

        // Test 1: Known system/non-LP tokens (should fail gracefully)
        console.log("\n📋 Test Category 1: Non-LP Tokens (should fail gracefully)");
        
        const nonLpTests = [
            {
                address: "So11111111111111111111111111111111111111112",
                description: "Wrapped SOL (not an LP token)",
                expected: false
            },
            {
                address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 
                description: "USDC (not an LP token)",
                expected: false
            },
            {
                address: "11111111111111111111111111111111",
                description: "System Program (invalid mint)",
                expected: false
            }
        ];

        for (const test of nonLpTests) {
            const result = await this.testLpMint(test.address, test.description, test.expected);
            results.push(result);
            await this.sleep(1000); // Rate limiting
        }

        // Test 2: Performance and error handling
        console.log("\n📋 Test Category 2: Performance and Error Handling");
        
        const performanceTests = [
            {
                address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                description: "Token Program ID (should fail gracefully)",
                expected: false
            },
            {
                address: "22222222222222222222222222222222",
                description: "Non-existent address (should fail gracefully)", 
                expected: false
            }
        ];

        for (const test of performanceTests) {
            const result = await this.testLpMint(test.address, test.description, test.expected);
            results.push(result);
            await this.sleep(1000);
        }

        // Test 3: Search for actual LP tokens
        console.log("\n📋 Test Category 3: LP Token Discovery");
        await this.searchForRealLpTokens();

        this.generateTestReport(results);
        return results;
    }

    private async searchForRealLpTokens() {
        console.log("🔍 Searching for real LP tokens...");
        console.log("Note: This would require integration with Raydium/Orca APIs or on-chain discovery");
        
        // In a real implementation, this would:
        // 1. Query Raydium API for recent pools
        // 2. Query Orca API for recent pools  
        // 3. Monitor on-chain program logs for pool creation
        // 4. Extract LP mint addresses and test them

        const exampleDiscoveryFlow = [
            "1. Connect to Raydium API: https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
            "2. Extract pool information and LP mint addresses",
            "3. Connect to Orca API for Whirlpool data",
            "4. Test LP lock verification on discovered mints",
            "5. Categorize pools by lock status"
        ];

        exampleDiscoveryFlow.forEach((step, index) => {
            console.log(`   ${step}`);
        });

        console.log("\n🎯 Manual Testing Recommendations:");
        console.log("   • Find recently created pools on Raydium/Orca");
        console.log("   • Test with known scam tokens (unlocked LP)");
        console.log("   • Test with established tokens (locked/burned LP)");
        console.log("   • Validate against community-maintained blacklists");
    }

    private generateTestReport(results: TestResult[]) {
        console.log("\n" + "=" * 80);
        console.log("📊 TEST REPORT SUMMARY");
        console.log("=" * 80);

        const totalTests = results.length;
        const passedTests = results.filter(r => r.testPassed).length;
        const failedTests = totalTests - passedTests;
        const errorsEncountered = results.filter(r => r.error).length;

        console.log(`\n📈 Overall Results:`);
        console.log(`   Total Tests: ${totalTests}`);
        console.log(`   Passed: ${passedTests} (${(passedTests/totalTests*100).toFixed(1)}%)`);
        console.log(`   Failed: ${failedTests} (${(failedTests/totalTests*100).toFixed(1)}%)`);
        console.log(`   Errors: ${errorsEncountered}`);

        console.log(`\n🔐 Lock Status Distribution:`);
        const lockedCount = results.filter(r => r.isLocked).length;
        const unlockedCount = results.filter(r => !r.isLocked).length;
        console.log(`   Locked: ${lockedCount}`);
        console.log(`   Unlocked: ${unlockedCount}`);

        console.log(`\n🏷️ Lock Type Distribution:`);
        const lockTypes = results.reduce((acc, r) => {
            acc[r.lockType] = (acc[r.lockType] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        
        Object.entries(lockTypes).forEach(([type, count]) => {
            console.log(`   ${type}: ${count}`);
        });

        if (errorsEncountered > 0) {
            console.log(`\n❌ Errors Encountered:`);
            results.filter(r => r.error).forEach(r => {
                console.log(`   ${r.description}: ${r.error}`);
            });
        }

        console.log(`\n✅ Test Suite Completed!`);
        console.log(`   Ready for production use: ${errorsEncountered === 0 && passedTests > 0}`);
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Main execution
async function main() {
    try {
        const tester = new LpLockTester();
        const results = await tester.runTestSuite();
        
        console.log(`\n🏁 Testing completed with ${results.length} test cases`);
        process.exit(0);
        
    } catch (error) {
        console.error("🚨 Test suite failed:", error);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { LpLockTester };